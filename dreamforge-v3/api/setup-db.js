import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  const { secret } = req.body || {};
  if (secret !== process.env.SETUP_SECRET) return res.status(401).json({ error: "Unauthorized." });

  if (!process.env.DATABASE_URL) return res.status(500).json({ error: "DATABASE_URL not configured." });

  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      CREATE TABLE IF NOT EXISTS generations (
        id SERIAL PRIMARY KEY,
        prompt TEXT NOT NULL,
        image_data TEXT NOT NULL,
        user_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations (created_at DESC)
    `;
    return res.status(200).json({ success: true, message: "Database initialized." });
  } catch (err) {
    console.error("DB setup error:", err);
    return res.status(500).json({ error: err.message });
  }
}
