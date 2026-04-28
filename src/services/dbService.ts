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

  async savePage(page: Partial<Page>): Promise<void> {
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
    `;

    await this.pool.query(query, [
      page.confluence_id,
      page.title,
      page.content,
      page.space_key,
      page.url,
      page.last_synced || new Date(),
      page.raw_html,
    ]);
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new DatabaseService();
