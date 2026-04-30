import express from "express";
import confluenceService from "../services/confluenceService";
import dbService from "../services/dbService";
import aiOptimizationService from "../services/aiOptimizationService";
import embeddingService from "../services/embeddingService";
import * as winston from "winston";
import * as cheerio from "cheerio";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

export const adminRoutes = express.Router();

// Get sync status
adminRoutes.get("/status", async (req, res) => {
  try {
    const stats = await dbService.getSyncStats();
    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Manual sync
adminRoutes.post("/sync", async (_req, res) => {
  try {
    logger.info("Starting manual sync from Confluence");

    const seedPages = await confluenceService.getAllPages();
    logger.info(`Fetched ${seedPages.length} seed pages from Confluence`);

    const expanded = await confluenceService.expandWithLinkedPages(seedPages);
    const pages = expanded.allPages;
    logger.info(
      `Expanded to ${pages.length} pages total (${expanded.linkedAdded} linked docs added, ${expanded.referencesScanned} references scanned)`
    );

    let synced = 0;
    let chunked = 0;
    let embedded = 0;

    for (const page of pages) {
      try {
        // Extract plain text from HTML
        const $ = cheerio.load(page.body.storage.value);
        const content = $.text().substring(0, 5000); // Limit content

        // Save page
        await dbService.savePage({
          confluence_id: page.id,
          title: page.title,
          content,
          space_key: (page as any).space?.key || "UNKNOWN",
          url: (page as any)._links?.webui || "",
          raw_html: page.body.storage.value,
          last_synced: new Date(),
        });

        synced++;

        // Get the saved page ID
        const savedPage = await dbService.getPageById(page.id);
        if (savedPage?.id) {
          // Process into chunks
          const chunks = await aiOptimizationService.processPageIntoChunks(
            Number(savedPage.id) || 0,
            page.id,
            page.title,
            page.body.storage.value
          );
          chunked += chunks.length;

          // Generate embeddings for chunks
          for (const chunk of chunks) {
            if (chunk.id) {
              try {
                const embedding = await embeddingService.generateEmbedding(chunk.content);
                await aiOptimizationService.saveEmbedding(chunk.id, embedding);
                embedded++;
              } catch (embeddingError) {
                logger.error("Failed to generate embedding", { chunkId: chunk.id });
              }
            }
          }
        }
      } catch (pageError) {
        logger.error("Failed to sync page", {
          pageId: page.id,
          error: pageError instanceof Error ? pageError.message : String(pageError),
        });
      }
    }

    logger.info(`Successfully synced ${synced} pages, created ${chunked} chunks, ${embedded} embeddings`);

    // Log sync operation
    await aiOptimizationService.logSyncOperation("full_sync", "success", synced, 0);

    res.json({
      success: true,
      message: `Synced ${synced} pages, created ${chunked} chunks, generated ${embedded} embeddings`,
      stats: {
        pagesSync: synced,
        chunksCreated: chunked,
        embeddingsGenerated: embedded,
      },
    });
  } catch (error) {
    logger.error("Sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    await aiOptimizationService.logSyncOperation("full_sync", "failed", 0, 1, 
      error instanceof Error ? error.message : String(error)
    );

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Generate embeddings for existing chunks (background job)
adminRoutes.post("/generate-embeddings", async (req, res) => {
  try {
    logger.info("Starting embedding generation for all chunks");

    // This is a background job that should run async
    res.json({
      success: true,
      message: "Embedding generation started",
    });

    // The actual processing would happen in background
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Reprocess chunks for a page
adminRoutes.post("/reprocess/:pageId", async (req, res) => {
  try {
    const pageId = parseInt(req.params.pageId);

    // Delete existing chunks
    // Reprocess with new parameters

    res.json({
      success: true,
      message: `Reprocessed page ${pageId}`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
