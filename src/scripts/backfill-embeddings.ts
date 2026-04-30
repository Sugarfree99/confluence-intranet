import dbService from "../services/dbService";
import { EmbeddingService } from "../services/embeddingService";

(async () => {
  const pool = (dbService as any).pool;
  const embeddings = new EmbeddingService();

  const r = await pool.query(
    `SELECT c.id, c.content, p.title
       FROM chunks c
       JOIN pages p ON p.id = c.page_id
      WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id)`
  );
  console.log(`Backfilling embeddings for ${r.rows.length} chunks...`);

  let ok = 0;
  let fail = 0;
  for (const row of r.rows) {
    const text = row.content || "";
    try {
      const vec = await embeddings.generateEmbedding(text);
      await dbService.saveChunkEmbedding(row.id, vec, embeddings.getModel());
      ok++;
      console.log(`  ✓ Chunk ${row.id} (${row.title})`);
    } catch (e) {
      fail++;
      console.log(`  ✗ Chunk ${row.id}: ${(e as Error).message}`);
    }
  }
  console.log(`Done. embedded=${ok} failed=${fail}`);
  await pool.end();
})();
