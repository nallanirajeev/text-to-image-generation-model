import { neon } from "@neondatabase/serverless";

const rateLimitStore = new Map();
const guestUsedStore = new Map();

function getRateLimit(ip, isGuest) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = isGuest ? 1 : 60;

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  const entry = rateLimitStore.get(ip);
  if (now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count };
}

async function verifySupabaseToken(token) {
  if (!token) return null;
  try {
    const [, payloadB64] = token.split(".");
    if (!payloadB64) return null;
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function validatePrompt(prompt) {
  if (!prompt || typeof prompt !== "string") return { valid: false, error: "Prompt is required." };
  const trimmed = prompt.trim();
  if (trimmed.length < 3) return { valid: false, error: "Prompt must be at least 3 characters." };
  if (trimmed.length > 1000) return { valid: false, error: "Prompt must be under 1000 characters." };
  const blocked = ["nude child", "loli", "child porn", "minor nude"];
  const lower = trimmed.toLowerCase();
  for (const w of blocked) {
    if (lower.includes(w)) return { valid: false, error: "Prompt contains disallowed content." };
  }
  return { valid: true, prompt: trimmed };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const userPayload = token ? await verifySupabaseToken(token) : null;
  const isAuthenticated = !!userPayload;
  const isGuest = !isAuthenticated;

  if (isGuest) {
    if (guestUsedStore.has(ip)) {
      return res.status(403).json({
        error: "GUEST_LIMIT_REACHED",
        message: "You've used your free generation. Sign in to generate unlimited images!",
        requiresAuth: true,
      });
    }
    guestUsedStore.set(ip, true);
  }

  const rateLimit = getRateLimit(ip, isGuest);
  res.setHeader("X-RateLimit-Remaining", rateLimit.remaining);

  if (!rateLimit.allowed) {
    return res.status(429).json({
      error: isGuest
        ? "You've used your free generation. Sign in for unlimited access!"
        : "Too many requests. Please wait a moment.",
      requiresAuth: isGuest,
      resetAt: rateLimit.resetAt,
    });
  }

  const { prompt: rawPrompt } = req.body || {};
  const validation = validatePrompt(rawPrompt);
  if (!validation.valid) return res.status(400).json({ error: validation.error });
  const prompt = validation.prompt;

  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
    return res.status(500).json({ error: "Server misconfiguration: missing Cloudflare credentials." });
  }

  try {
    const cfResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/lykon/dreamshaper-8-lcm`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          negative_prompt: "blurry, distorted, low quality, ugly, bad anatomy, watermark, text, nsfw",
          num_steps: 8,
        }),
      }
    );

    if (!cfResponse.ok) {
      const errText = await cfResponse.text();
      console.error("Cloudflare AI error:", cfResponse.status, errText);
      return res.status(502).json({ error: "Image generation failed. Please try again." });
    }

    const imageBuffer = await cfResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString("base64");
    const imageDataUrl = `data:image/png;base64,${base64Image}`;

    if (process.env.DATABASE_URL) {
      try {
        const sql = neon(process.env.DATABASE_URL);
        const userId = userPayload?.sub || null;
        await sql`
          INSERT INTO generations (prompt, image_data, user_id, created_at)
          VALUES (${prompt}, ${imageDataUrl}, ${userId}, NOW())
        `;
      } catch (dbErr) {
        console.error("DB insert error (non-fatal):", dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      image: imageDataUrl,
      prompt,
      timestamp: new Date().toISOString(),
      isGuest,
      guestGenerationUsed: isGuest,
    });
  } catch (err) {
    console.error("Generation error:", err);
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
}
