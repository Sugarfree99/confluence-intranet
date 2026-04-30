import express from "express";
import qaService from "../services/qaService";
import { optionalAuth, AuthRequest } from "../middleware/auth";

export const qaRoutes = express.Router();

/**
 * Ask a question and get an answer with sources
 */
qaRoutes.post("/ask", optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { question, history } = req.body;

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        success: false,
        error: "question parameter is required",
      });
    }

    const result = await qaService.answerQuestion(question, Array.isArray(history) ? history : []);

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

    const pages = await qaService.searchRelevantPages(q, 10);

    res.json({
      success: true,
      query: q,
      results: pages,
      count: pages.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
