import { neon } from "@neondatabase/serverless";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

  if (!process.env.DATABASE_URL) {
    return res.status(200).json({ generations: [] });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT id, prompt, image_data, created_at
      FROM generations
      ORDER BY created_at DESC
      LIMIT 24
    `;
    return res.status(200).json({ generations: rows });
  } catch (err) {
    console.error("Gallery fetch error:", err.message);
    return res.status(200).json({ generations: [] });
  }
}
