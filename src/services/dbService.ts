import { Pool } from "pg";
import { config } from "../config";
import * as winston from "winston";
import * as fs from "fs";
import * as path from "path";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

export interface Page {
  id: string;
  confluence_id: string;
  title: string;
  content: string;
  space_key: string;
  url: string;
  last_synced: Date;
  raw_html: string;
}

export class DatabaseService {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
    });
  }

  async initialize(): Promise<void> {
    try {
      // Read schema file
      const schemaPath = path.join(__dirname, "../../db/schema.sql");
      const schema = fs.readFileSync(schemaPath, "utf-8");

      // Execute schema
      await this.pool.query(schema);
      logger.info("Database schema initialized");
    } catch (error) {
      logger.error("Failed to initialize database schema", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async savePage(page: Partial<Page>): Promise<number> {
    const query = `
      INSERT INTO pages (confluence_id, title, content, space_key, url, last_synced, raw_html)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (confluence_id) DO UPDATE SET
        title = $2,
        content = $3,
        space_key = $4,
        url = $5,
        last_synced = $6,
        raw_html = $7
      RETURNING id
    `;

    const result = await this.pool.query(query, [
      page.confluence_id,
      page.title,
      page.content,
      page.space_key,
      page.url,
      page.last_synced || new Date(),
      page.raw_html,
    ]);
    return result.rows[0].id as number;
  }

  async getPages(limit = 50, offset = 0): Promise<Page[]> {
    const query = `
      SELECT * FROM pages 
      ORDER BY last_synced DESC 
      LIMIT $1 OFFSET $2
    `;
    const result = await this.pool.query(query, [limit, offset]);
    return result.rows;
  }

  async getPageById(confluenceId: string): Promise<Page | null> {
    const query = "SELECT * FROM pages WHERE confluence_id = $1";
    const result = await this.pool.query(query, [confluenceId]);
    return result.rows[0] || null;
  }

  async searchPages(query: string): Promise<Page[]> {
    const searchQuery = `
      SELECT * FROM pages 
      WHERE to_tsvector('english', content) @@ to_tsquery('english', $1)
      OR title ILIKE $2
      ORDER BY ts_rank(to_tsvector('english', content), to_tsquery('english', $1)) DESC
    `;
    const result = await this.pool.query(searchQuery, [query, `%${query}%`]);
    return result.rows;
  }

  async getSyncStats(): Promise<{ total: number; lastSync: Date | null }> {
    const query = `
      SELECT COUNT(*) as total, MAX(last_synced) as last_sync FROM pages
    `;
    const result = await this.pool.query(query);
    return {
      total: parseInt(result.rows[0].total),
      lastSync: result.rows[0].last_sync,
    };
  }

  /** Save (or update) a page's embedding by confluence_id. */
  async savePageEmbedding(confluenceId: string, embedding: number[]): Promise<void> {
    await this.pool.query(
      `UPDATE pages
          SET embedding = $1,
              embedding_updated_at = NOW()
        WHERE confluence_id = $2`,
      [embedding, confluenceId]
    );
  }

  /**
   * Replace the chunks for a page atomically and return the inserted rows.
   * Old chunks (and their embeddings, via ON DELETE CASCADE) are removed first.
   */
  async replacePageChunks(
    pageId: number,
    confluenceId: string,
    chunks: Array<{
      content: string;
      type: string;
      characterCount: number;
      tokenCount: number;
      startPosition: number;
      metadata: any;
    }>
  ): Promise<Array<{ id: number; chunk_index: number; content: string }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chunks WHERE page_id = $1", [pageId]);

      const inserted: Array<{ id: number; chunk_index: number; content: string }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const r = await client.query(
          `INSERT INTO chunks
             (page_id, confluence_id, chunk_index, content, chunk_type,
              character_count, token_count, start_position, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, chunk_index, content`,
          [
            pageId,
            confluenceId,
            i,
            c.content,
            c.type,
            c.characterCount,
            c.tokenCount,
            c.startPosition,
            c.metadata ? JSON.stringify(c.metadata) : null,
          ]
        );
        inserted.push(r.rows[0]);
      }

      await client.query("COMMIT");
      return inserted;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Upsert one embedding row per chunk. Stored as pgvector halfvec(3072). */
  async saveChunkEmbedding(
    chunkId: number,
    embedding: number[],
    model: string
  ): Promise<void> {
    // pgvector accepts the text form `[v1,v2,...]` and casts to halfvec.
    const vec = "[" + embedding.join(",") + "]";
    await this.pool.query(
      `INSERT INTO embeddings (chunk_id, embedding, model)
       VALUES ($1, $2::halfvec, $3)
       ON CONFLICT (chunk_id) DO UPDATE SET
         embedding = EXCLUDED.embedding,
         model = EXCLUDED.model,
         created_at = NOW()`,
      [chunkId, vec, model]
    );
  }

  async saveAttachment(att: {
    confluence_id: string;
    page_confluence_id: string;
    title: string;
    file_name?: string;
    media_type?: string;
    file_size?: number;
    download_url?: string;
    web_url?: string;
    version?: number;
  }): Promise<void> {
    const query = `
      INSERT INTO attachments (
        confluence_id, page_id, page_confluence_id, title, file_name,
        media_type, file_size, download_url, web_url, version, last_synced
      )
      VALUES (
        $1,
        (SELECT id FROM pages WHERE confluence_id = $2),
        $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP
      )
      ON CONFLICT (confluence_id) DO UPDATE SET
        page_id = (SELECT id FROM pages WHERE confluence_id = $2),
        page_confluence_id = $2,
        title = $3,
        file_name = $4,
        media_type = $5,
        file_size = $6,
        download_url = $7,
        web_url = $8,
        version = $9,
        last_synced = CURRENT_TIMESTAMP
    `;
    await this.pool.query(query, [
      att.confluence_id,
      att.page_confluence_id,
      att.title,
      att.file_name || null,
      att.media_type || null,
      att.file_size || null,
      att.download_url || null,
      att.web_url || null,
      att.version || null,
    ]);
  }

  async getAttachmentsByPageId(pageConfluenceId: string): Promise<any[]> {
    const query = `
      SELECT * FROM attachments
      WHERE page_confluence_id = $1
      ORDER BY title
    `;
    const result = await this.pool.query(query, [pageConfluenceId]);
    return result.rows;
  }

  async getAttachmentByConfluenceId(confluenceId: string): Promise<any | null> {
    const r = await this.pool.query(
      "SELECT * FROM attachments WHERE confluence_id = $1",
      [confluenceId]
    );
    return r.rows[0] || null;
  }

  /**
   * Store the raw bytes of an attachment so they can later be served back
   * to the user in the file's original format (image, PDF, etc.).
   * Called separately from `saveAttachment` so metadata can be upserted
   * even when the binary download fails.
   */
  async saveAttachmentFile(confluenceId: string, data: Buffer): Promise<void> {
    await this.pool.query(
      "UPDATE attachments SET file_data = $2 WHERE confluence_id = $1",
      [confluenceId, data]
    );
  }

  /**
   * Fetch the raw bytes + media type for streaming back to the browser.
   */
  async getAttachmentFile(
    confluenceId: string
  ): Promise<{ data: Buffer; media_type: string | null; file_name: string | null; title: string } | null> {
    const r = await this.pool.query(
      `SELECT file_data, media_type, file_name, title
         FROM attachments
        WHERE confluence_id = $1`,
      [confluenceId]
    );
    const row = r.rows[0];
    if (!row || !row.file_data) return null;
    return {
      data: row.file_data as Buffer,
      media_type: row.media_type,
      file_name: row.file_name,
      title: row.title,
    };
  }

  async deleteAttachmentsForPage(pageConfluenceId: string, keepIds: string[]): Promise<number> {
    if (keepIds.length === 0) {
      const r = await this.pool.query(
        "DELETE FROM attachments WHERE page_confluence_id = $1",
        [pageConfluenceId]
      );
      return r.rowCount || 0;
    }
    const r = await this.pool.query(
      `DELETE FROM attachments
       WHERE page_confluence_id = $1
         AND confluence_id <> ALL($2::text[])`,
      [pageConfluenceId, keepIds]
    );
    return r.rowCount || 0;
  }

  async getAttachmentStats(): Promise<{ total: number; totalSize: number }> {
    const r = await this.pool.query(
      "SELECT COUNT(*)::int AS total, COALESCE(SUM(file_size),0)::bigint AS total_size FROM attachments"
    );
    return {
      total: parseInt(r.rows[0].total),
      totalSize: parseInt(r.rows[0].total_size),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new DatabaseService();
