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
    let chunked = 0;
    let embedded = 0;
    for (const page of pages) {
      try {
        // Extract text from HTML
        const $ = cheerio.load(page.body.storage.value);
        const content = $.text().substring(0, 5000);

        await dbService.savePage({
          confluence_id: page.id,
          title: page.title,
          content,
          space_key: (page.space as any)?.key || "UNKNOWN",
          url: (page as any)._links?.webui || "",
          raw_html: page.body.storage.value,
          last_synced: new Date(),
        });

        synced++;
        logger.info(`Synced: ${page.title}`);

        // Semantic chunking + embeddings
        const savedPage = await dbService.getPageById(page.id);
        if (savedPage?.id) {
          const chunks = await aiOptimizationService.processPageIntoChunks(
            Number(savedPage.id) || 0,
            page.id,
            page.title,
            page.body.storage.value
          );
          chunked += chunks.length;

          for (const chunk of chunks) {
            if (chunk.id) {
              try {
                const embedding = await embeddingService.generateEmbedding(chunk.content);
                await aiOptimizationService.saveEmbedding(chunk.id, embedding, embeddingService.getModel());
                embedded++;
              } catch (embedError) {
                logger.error("Failed to embed chunk", {
                  chunkId: chunk.id,
                  error: embedError instanceof Error ? embedError.message : String(embedError),
                });
              }
            }
          }
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
    logger.info(`✓ Created ${chunked} chunks, generated ${embedded} embeddings`);

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
