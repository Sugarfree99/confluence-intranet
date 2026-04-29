import confluenceService from "../services/confluenceService";
import dbService from "../services/dbService";
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
    let attachmentsSynced = 0;
    let attachmentsRemoved = 0;
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

        // Sync attachments for this page
        try {
          const attachments = await confluenceService.getPageAttachments(page.id);
          const keepIds: string[] = [];
          for (const att of attachments) {
            const ext = att.extensions || {};
            await dbService.saveAttachment({
              confluence_id: att.id,
              page_confluence_id: page.id,
              title: att.title,
              file_name: ext.fileName || att.title,
              media_type: ext.mediaType || null,
              file_size: typeof ext.fileSize === "number" ? ext.fileSize : null,
              download_url: att._links?.download || null,
              web_url: att._links?.webui || null,
              version: att.version?.number || null,
            });
            keepIds.push(att.id);
            attachmentsSynced++;
          }
          // Remove attachments that no longer exist on this page
          attachmentsRemoved += await dbService.deleteAttachmentsForPage(page.id, keepIds);
          logger.info(
            `Synced: ${page.title} (${attachments.length} bilagor)`
          );
        } catch (attErr) {
          logger.error("Failed to sync attachments", {
            pageId: page.id,
            error: attErr instanceof Error ? attErr.message : String(attErr),
          });
          logger.info(`Synced: ${page.title}`);
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
      `✓ Synced ${attachmentsSynced} attachments (${attachmentsRemoved} borttagna)`
    );

    // Show stats
    const stats = await dbService.getSyncStats();
    const attStats = await dbService.getAttachmentStats();
    logger.info("Sync statistics", {
      totalPages: stats.total,
      lastSync: stats.lastSync,
      totalAttachments: attStats.total,
      totalAttachmentSize: attStats.totalSize,
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
