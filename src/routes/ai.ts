import express from "express";
import aiOptimizationService from "../services/aiOptimizationService";
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

export const aiRoutes = express.Router();

/**
 * Get AI-ready content summary for a page
 * Includes chunks, embeddings, and related content
 */
aiRoutes.get("/pages/:pageId/summary", async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId);
    const summary = await aiOptimizationService.getPageSummaryForAI(pageId);

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get chunks for a page (for AI processing)
 */
aiRoutes.get("/pages/:pageId/chunks", async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId);
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const chunks = await aiOptimizationService.getPageChunks(pageId);
    const paginatedChunks = chunks.slice(offset, offset + limit);

    res.json({
      success: true,
      data: paginatedChunks,
      pagination: {
        total: chunks.length,
        limit,
        offset,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get related pages (for context building)
 */
aiRoutes.get("/pages/:pageId/related", async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId);
    const relatedPages = await aiOptimizationService.getRelatedPages(pageId);

    res.json({
      success: true,
      data: relatedPages,
      count: relatedPages.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get content ready for embedding generation
 * Returns chunks that need embeddings
 */
aiRoutes.get("/chunks/pending-embeddings", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;

    // This would query chunks without embeddings yet
    // For now, we'll return a placeholder
    res.json({
      success: true,
      message: "Endpoint for retrieving chunks pending embeddings",
      limit,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get statistics about AI-optimized content
 */
aiRoutes.get("/statistics", async (req, res) => {
  try {
    // Query would return aggregated stats
    res.json({
      success: true,
      data: {
        totalPages: 0,
        totalChunks: 0,
        totalTokens: 0,
        embeddingsGenerated: 0,
        lastSync: new Date(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Search using semantic similarity (requires embeddings)
 */
aiRoutes.post("/search/semantic", async (req, res) => {
  try {
    const { query, embedding, limit } = req.body;

    if (!query || !embedding) {
      return res.status(400).json({
        success: false,
        error: "query and embedding are required",
      });
    }

    // Vector similarity search would happen here
    // Results would be ranked by cosine similarity
    res.json({
      success: true,
      query,
      results: [],
      message: "Semantic search requires embedding generation endpoint",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Get content in a format optimized for LLM context windows
 */
aiRoutes.get("/context-window/:pageId", async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId);
    const maxTokens = parseInt(req.query.maxTokens as string) || 8000;

    const summary = await aiOptimizationService.getPageSummaryForAI(pageId);

    // Build context window
    let tokens = 0;
    const selectedChunks = [];

    for (const chunk of summary.chunks) {
      if (tokens + chunk.token_count <= maxTokens) {
        selectedChunks.push(chunk);
        tokens += chunk.token_count;
      } else {
        break;
      }
    }

    const contextWindow = {
      page: summary.page,
      chunks: selectedChunks,
      statistics: {
        tokensUsed: tokens,
        tokensAvailable: maxTokens,
        chunksIncluded: selectedChunks.length,
      },
    };

    res.json({
      success: true,
      data: contextWindow,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
