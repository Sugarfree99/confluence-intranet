import confluenceService from "../services/confluenceService";
import dbService from "../services/dbService";
import { EmbeddingService } from "../services/embeddingService";
import TextChunkingService from "../services/textChunkingService";
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

const embeddingService = new EmbeddingService();

async function sync() {
  try {
    logger.info("Starting manual Confluence sync...");

    // Initialize database
    await dbService.initialize();

    // Fetch all pages
    const pages = await confluenceService.getAllPages();
    logger.info(`Fetched ${pages.length} pages from Confluence`);

    // Save each page
    let synced = 0;
    let totalChunks = 0;
    let chunksEmbedded = 0;
    let chunkEmbedFailed = 0;

    for (const page of pages) {
      try {
        // Extract text from HTML
        const rawHtml = page.body.storage.value;
        const $ = cheerio.load(rawHtml);
        const content = $.text().replace(/\s+/g, " ").trim();

        const pageDbId = await dbService.savePage({
          confluence_id: page.id,
          title: page.title,
          content,
          space_key: (page.space as any)?.key || "UNKNOWN",
          url: (page as any)._links?.webui || "",
          raw_html: rawHtml,
          last_synced: new Date(),
        });

        synced++;
        logger.info(`Synced: ${page.title}`);

        // ---- Chunk + embed -------------------------------------------------
        const chunks = TextChunkingService.chunkContent(rawHtml, page.title);
        if (chunks.length === 0) {
          logger.warn("No chunks produced for page", { pageId: page.id, title: page.title });
          continue;
        }

        const insertedChunks = await dbService.replacePageChunks(
          pageDbId,
          page.id,
          chunks
        );
        totalChunks += insertedChunks.length;

        // Batch-embed chunks (one HTTP call per page).
        try {
          const vectors = await embeddingService.generateBatchEmbeddings(
            insertedChunks.map((c) => c.content)
          );
          for (let i = 0; i < insertedChunks.length; i++) {
            try {
              await dbService.saveChunkEmbedding(
                insertedChunks[i].id,
                vectors[i],
                embeddingService.getModel()
              );
              chunksEmbedded++;
            } catch (err) {
              chunkEmbedFailed++;
              logger.error("Failed to save chunk embedding", {
                chunkId: insertedChunks[i].id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          chunkEmbedFailed += insertedChunks.length;
          logger.error("Failed to embed chunks for page", {
            pageId: page.id,
            title: page.title,
            chunkCount: insertedChunks.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (error) {
        logger.error("Failed to sync page", {
          pageId: page.id,
          title: page.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info(`✓ Successfully synced ${synced}/${pages.length} pages`);
    logger.info(
      `✓ Created ${totalChunks} chunks; embedded ${chunksEmbedded} (failed: ${chunkEmbedFailed})`
    );

    // Show stats
    const stats = await dbService.getSyncStats();
    logger.info("Sync statistics", {
      totalPages: stats.total,
      lastSync: stats.lastSync,
    });

    await dbService.close();
  } catch (error) {
    logger.error("Sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

sync();
