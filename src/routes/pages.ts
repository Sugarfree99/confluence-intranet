import express from "express";
import confluenceService from "../services/confluenceService";
import dbService from "../services/dbService";

export const pageRoutes = express.Router();

// Get all pages
pageRoutes.get("/", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const pages = await dbService.getPages(limit, offset);
    const stats = await dbService.getSyncStats();

    res.json({
      success: true,
      data: pages,
      pagination: {
        limit,
        offset,
        total: stats.total,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get specific page
pageRoutes.get("/:id", async (req, res) => {
  try {
    const page = await dbService.getPageById(req.params.id);

    if (!page) {
      return res.status(404).json({
        success: false,
        error: "Page not found",
      });
    }

    res.json({
      success: true,
      data: page,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Search pages
pageRoutes.get("/search/query", async (req, res) => {
  try {
    const query = req.query.q as string;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Query parameter 'q' is required",
      });
    }

    const results = await dbService.searchPages(query);

    res.json({
      success: true,
      query,
      results,
      count: results.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
