import dbService from "../services/dbService";

(async () => {
  const pool = (dbService as any).pool;
  const r = await pool.query(
    `SELECT title, length(content) AS len, content, (embedding IS NOT NULL) AS has_emb
       FROM pages WHERE title ILIKE '%semester%'`
  );
  for (const row of r.rows) {
    console.log("Title:", row.title, "len:", row.len, "has_emb:", row.has_emb);
    console.log("Content:", row.content?.substring(0, 500));
  }
  await pool.end();
})();
