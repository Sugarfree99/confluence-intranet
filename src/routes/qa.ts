import express from "express";
import qaService from "../services/qaService";
import { optionalAuth, AuthRequest } from "../middleware/auth";

export const qaRoutes = express.Router();

/**
 * Ask a question and get an answer with sources
 */
qaRoutes.post("/ask", optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { question } = req.body;

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        success: false,
        error: "question parameter is required",
      });
    }

    const result = await qaService.answerQuestion(question);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * Search for related content
 */
qaRoutes.get("/search", optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== "string") {
      return res.status(400).json({
        success: false,
        error: "q parameter is required",
      });
    }

    const chunks = await qaService.searchRelevantChunks(q, 10);

    res.json({
      success: true,
      query: q,
      results: chunks,
      count: chunks.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
