import axios from "axios";
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

export interface EmbeddingResponse {
  embedding: number[];
  index: number;
  object: string;
}

export class EmbeddingService {
  private apiKey: string;
  private model: string;
  private allowDummyOnError: boolean;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";
    // Embedding model is separate from the chat model (GEMINI_MODEL).
    // Defaults to Gemini's gemini-embedding-001.
    this.model =
      model ||
      process.env.GEMINI_EMBEDDING_MODEL ||
      process.env.OPENAI_EMBEDDING_MODEL ||
      "gemini-embedding-001";
    this.allowDummyOnError = process.env.ALLOW_DUMMY_EMBEDDINGS === "true";
  }

  private isGeminiKey(): boolean {
    // Gemini API keys start with "AIza"; OpenAI keys start with "sk-".
    return !!process.env.GEMINI_API_KEY || this.apiKey.startsWith("AIza");
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Generate embeddings using Gemini (default) or OpenAI.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      logger.warn("Embedding API key not configured, returning dummy embedding");
      return this.generateDummyEmbedding(text);
    }

    try {
      if (this.isGeminiKey()) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
        const response = await axios.post(
          url,
          {
            model: `models/${this.model}`,
            content: { parts: [{ text }] },
          },
          { headers: { "Content-Type": "application/json" } }
        );
        return response.data.embedding.values;
      }

      const response = await axios.post(
        "https://api.openai.com/v1/embeddings",
        { input: text, model: this.model },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
      return response.data.data[0].embedding;
    } catch (error) {
      const err = error as any;
      logger.error("Failed to generate embedding", {
        error: error instanceof Error ? error.message : String(error),
        status: err?.response?.status,
        data: err?.response?.data,
        model: this.model,
      });

      if (this.allowDummyOnError) {
        logger.warn("Falling back to dummy embedding because ALLOW_DUMMY_EMBEDDINGS=true", {
          model: this.model,
        });
        return this.generateDummyEmbedding(text);
      }

      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      logger.warn("Embedding API key not configured, returning dummy embeddings");
      return texts.map((text) => this.generateDummyEmbedding(text));
    }

    try {
      if (this.isGeminiKey()) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
        const response = await axios.post(
          url,
          {
            requests: texts.map((text) => ({
              model: `models/${this.model}`,
              content: { parts: [{ text }] },
            })),
          },
          { headers: { "Content-Type": "application/json" } }
        );
        return response.data.embeddings.map((e: any) => e.values);
      }

      const response = await axios.post(
        "https://api.openai.com/v1/embeddings",
        { input: texts, model: this.model },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      return response.data.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((item: any) => item.embedding);
    } catch (error) {
      const err = error as any;
      logger.error("Failed to generate batch embeddings", {
        error: error instanceof Error ? error.message : String(error),
        status: err?.response?.status,
        data: err?.response?.data,
        model: this.model,
      });

      if (this.allowDummyOnError) {
        logger.warn("Falling back to dummy batch embeddings because ALLOW_DUMMY_EMBEDDINGS=true", {
          model: this.model,
        });
        return texts.map((text) => this.generateDummyEmbedding(text));
      }

      throw error;
    }
  }

  /**
   * Generate a dummy embedding (useful for development without API key)
   * Uses simple hash-based approach
   */
  private generateDummyEmbedding(text: string, dimensions: number = 768): number[] {
    // Create a simple hash-based embedding for testing
    const hash = this.hashString(text);
    const embedding: number[] = [];

    for (let i = 0; i < dimensions; i++) {
      const seed = hash + i * 7919; // Use prime number for variety
      const pseudoRandom = Math.sin(seed) * 10000;
      embedding.push((pseudoRandom - Math.floor(pseudoRandom)) * 2 - 1);
    }

    // Normalize the embedding
    return this.normalizeVector(embedding);
  }

  /**
   * Simple hash function for string
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Normalize vector to unit length
   */
  private normalizeVector(vector: number[]): number[] {
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (magnitude === 0) return vector;
    return vector.map((val) => val / magnitude);
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Embeddings must have same dimensions");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

export default new EmbeddingService();
