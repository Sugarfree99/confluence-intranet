import { Pool } from "pg";
import { config } from "../config";
import * as winston from "winston";
import TextChunkingService from "./textChunkingService";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

export interface AIChunk {
  id?: number;
  page_id: number;
  confluence_id: string;
  chunk_index: number;
  content: string;
  chunk_type: string;
  character_count: number;
  token_count: number;
  start_position: number;
  metadata: {
    language: string;
    confidence: number;
    originalType: string;
    context?: string;
  };
}

export interface EmbeddingRecord {
  id?: number;
  chunk_id: number;
  embedding: number[];
  model: string;
  created_at?: Date;
}

export class AIOptimizationService {
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

  /**
   * Process a page into AI-optimized chunks
   */
  async processPageIntoChunks(
    pageId: number,
    confluenceId: string,
    title: string,
    rawHtml: string
  ): Promise<AIChunk[]> {
    try {
      // Create contextual chunks
      const contextualChunks = TextChunkingService.createContextualChunks(rawHtml, title);

      const chunks: AIChunk[] = contextualChunks.map((chunk) => ({
        page_id: pageId,
        confluence_id: confluenceId,
        chunk_index: chunk.index,
        content: chunk.content,
        chunk_type: chunk.type,
        character_count: chunk.characterCount,
        token_count: chunk.tokenCount,
        start_position: chunk.startPosition,
        metadata: {
          ...chunk.metadata,
          context: chunk.context,
        },
      }));

      // Save chunks to database
      for (const chunk of chunks) {
        const query = `
          INSERT INTO chunks 
          (page_id, confluence_id, chunk_index, content, chunk_type, character_count, token_count, start_position, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT DO NOTHING
          RETURNING id
        `;

        const result = await this.pool.query(query, [
          chunk.page_id,
          chunk.confluence_id,
          chunk.chunk_index,
          chunk.content,
          chunk.chunk_type,
          chunk.character_count,
          chunk.token_count,
          chunk.start_position,
          JSON.stringify(chunk.metadata),
        ]);

        if (result.rows.length > 0) {
          chunk.id = result.rows[0].id;
        }
      }

      logger.info(`Created ${chunks.length} chunks for page ${confluenceId}`);
      return chunks;
    } catch (error) {
      logger.error("Failed to process page into chunks", {
        pageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Save embeddings for a chunk
   */
  async saveEmbedding(chunkId: number, embedding: number[], model: string = "text-embedding-3-small"): Promise<void> {
    try {
      const query = `
        INSERT INTO embeddings (chunk_id, embedding, model)
        VALUES ($1, $2, $3)
        ON CONFLICT (chunk_id) DO UPDATE SET
          embedding = $2,
          model = $3
      `;

      await this.pool.query(query, [
        chunkId,
        embedding,
        model,
      ]);
    } catch (error) {
      logger.error("Failed to save embedding", {
        chunkId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get chunks for a page
   */
  async getPageChunks(pageId: number): Promise<AIChunk[]> {
    try {
      const query = `
        SELECT * FROM chunks 
        WHERE page_id = $1 
        ORDER BY chunk_index ASC
      `;

      const result = await this.pool.query(query, [pageId]);
      return result.rows.map((row) => ({
        ...row,
        metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      }));
    } catch (error) {
      logger.error("Failed to get page chunks", {
        pageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create page relationships from links
   */
  async createPageRelationships(sourcePageId: number, targetPageIds: number[], type: string = "references"): Promise<void> {
    try {
      for (const targetPageId of targetPageIds) {
        const query = `
          INSERT INTO page_relationships (source_page_id, target_page_id, relationship_type)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `;

        await this.pool.query(query, [sourcePageId, targetPageId, type]);
      }
    } catch (error) {
      logger.error("Failed to create page relationships", {
        sourcePageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get related pages
   */
  async getRelatedPages(pageId: number): Promise<any[]> {
    try {
      const query = `
        SELECT 
          p.*, 
          pr.relationship_type,
          pr.context
        FROM page_relationships pr
        JOIN pages p ON p.id = pr.target_page_id
        WHERE pr.source_page_id = $1
        ORDER BY pr.relationship_type
      `;

      const result = await this.pool.query(query, [pageId]);
      return result.rows;
    } catch (error) {
      logger.error("Failed to get related pages", {
        pageId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get AI-ready content summary for a page
   */
  async getPageSummaryForAI(pageId: number): Promise<{
    page: any;
    chunks: AIChunk[];
    relatedPages: any[];
    statistics: any;
  }> {
    const pageQuery = "SELECT * FROM pages WHERE id = $1";
    const pageResult = await this.pool.query(pageQuery, [pageId]);
    const page = pageResult.rows[0];

    if (!page) {
      throw new Error("Page not found");
    }

    const chunks = await this.getPageChunks(pageId);
    const relatedPages = await this.getRelatedPages(pageId);

    const statistics = {
      totalChunks: chunks.length,
      totalTokens: chunks.reduce((sum, c) => sum + c.token_count, 0),
      totalCharacters: chunks.reduce((sum, c) => sum + c.character_count, 0),
      chunkTypes: [...new Set(chunks.map((c) => c.chunk_type))],
      relatedPagesCount: relatedPages.length,
    };

    return {
      page,
      chunks,
      relatedPages,
      statistics,
    };
  }

  /**
   * Log sync operation
   */
  async logSyncOperation(
    syncType: string,
    status: string,
    itemsProcessed: number,
    itemsFailed: number = 0,
    error?: string
  ): Promise<void> {
    try {
      const query = `
        INSERT INTO sync_logs (sync_type, status, items_processed, items_failed, error_message, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;

      await this.pool.query(query, [
        syncType,
        status,
        itemsProcessed,
        itemsFailed,
        error || null,
        JSON.stringify({
          timestamp: new Date().toISOString(),
        }),
      ]);
    } catch (error) {
      logger.error("Failed to log sync operation", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new AIOptimizationService();
