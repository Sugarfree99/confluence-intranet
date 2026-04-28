import { Pool } from "pg";
import { config } from "../config";
import EmbeddingService from "./embeddingService";
import * as winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

export interface QAResult {
  answer: string;
  sources: Array<{
    chunkId: number;
    pageId: number;
    title: string;
    excerpt: string;
    relevance: number;
  }>;
  confidence: number;
}

export class QAService {
  private pool: Pool;
  private embeddingService: any;

  constructor() {
    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
    });

    this.embeddingService = EmbeddingService;
  }

  /**
   * Search for relevant chunks based on question embedding
   */
  async searchRelevantChunks(question: string, limit: number = 5): Promise<any[]> {
    try {
      // Generate embedding for the question
      const questionEmbedding = await this.embeddingService.generateEmbedding(question);

      // Search using text similarity as fallback (pgvector not always available)
      const query = `
        SELECT 
          c.id,
          c.page_id,
          c.content,
          c.chunk_type,
          p.title,
          p.url,
          p.space_key,
          ts_rank(
            to_tsvector('english', c.content), 
            to_tsquery('english', $1)
          ) as relevance
        FROM chunks c
        JOIN pages p ON c.page_id = p.id
        WHERE to_tsvector('english', c.content) @@ to_tsquery('english', $1)
        ORDER BY relevance DESC
        LIMIT $2
      `;

      // Convert question to tsquery format
      const searchQuery = question
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .join(" | ");

      const result = await this.pool.query(query, [searchQuery, limit]);
      return result.rows;
    } catch (error) {
      logger.error("Failed to search relevant chunks", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Extract answer from relevant context
   * This is a simplified version - in production you'd use an LLM API
   */
  async generateAnswerFromContext(
    question: string,
    relevantChunks: any[]
  ): Promise<{ answer: string; confidence: number }> {
    // This is a placeholder implementation
    // In production, you'd send this to an LLM API (OpenAI, Anthropic, etc.)

    if (relevantChunks.length === 0) {
      return {
        answer: "Jag kunde inte hitta relevant information för din fråga.",
        confidence: 0,
      };
    }

    // Combine chunks for context
    const context = relevantChunks.map((c) => c.content).join("\n\n");

    // This would be replaced with actual LLM call
    return {
      answer: `Baserat på dokumentationen: ${context.substring(0, 200)}...`,
      confidence: 0.6,
    };
  }

  /**
   * Answer a question using RAG (Retrieval Augmented Generation)
   */
  async answerQuestion(question: string): Promise<QAResult> {
    try {
      logger.info("Answering question", { question });

      // Search for relevant chunks
      const relevantChunks = await this.searchRelevantChunks(question, 5);

      if (relevantChunks.length === 0) {
        return {
          answer: "Jag kunde inte hitta relevant information för din fråga. Prova en annan formulering.",
          sources: [],
          confidence: 0,
        };
      }

      // Generate answer from context
      const { answer, confidence } = await this.generateAnswerFromContext(question, relevantChunks);

      // Format sources
      const sources = relevantChunks.map((chunk) => ({
        chunkId: chunk.id,
        pageId: chunk.page_id,
        title: chunk.title,
        excerpt: chunk.content.substring(0, 150) + "...",
        relevance: chunk.relevance || 0.5,
      }));

      return {
        answer,
        sources,
        confidence,
      };
    } catch (error) {
      logger.error("Failed to answer question", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        answer: "Ett fel inträffade när jag försökte besvara din fråga.",
        sources: [],
        confidence: 0,
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new QAService();
