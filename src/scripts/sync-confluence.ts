import confluenceService from "../services/confluenceService";
import dbService from "../services/dbService";
import { EmbeddingService } from "../services/embeddingService";
import TextChunkingService from "../services/textChunkingService";
import {
  downloadAttachment,
  extractAttachmentText,
  isExtractableMediaType,
} from "../services/attachmentTextService";
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
const MAX_EMBEDDING_BATCH = 100;

interface ChunkEmbedResult {
  chunksCreated: number;
  chunksEmbedded: number;
  chunksFailed: number;
}

function sanitizeForDb(text: string): string {
  // PostgreSQL text columns reject NUL (0x00) bytes.
  return (text || "").replace(/\u0000/g, "");
}

async function chunkAndEmbed(
  pageDbId: number,
  confluenceId: string,
  title: string,
  sourceText: string
): Promise<ChunkEmbedResult> {
  const result: ChunkEmbedResult = {
    chunksCreated: 0,
    chunksEmbedded: 0,
    chunksFailed: 0,
  };

  const cleanedSourceText = sanitizeForDb(sourceText);
  const chunks = TextChunkingService.chunkContent(cleanedSourceText, title).map((c) => ({
    ...c,
    content: sanitizeForDb(c.content),
  }));
  if (chunks.length === 0) {
    logger.warn("No chunks produced", { confluenceId, title });
    return result;
  }

  const insertedChunks = await dbService.replacePageChunks(
    pageDbId,
    confluenceId,
    chunks
  );
  result.chunksCreated = insertedChunks.length;

  for (let offset = 0; offset < insertedChunks.length; offset += MAX_EMBEDDING_BATCH) {
    const batch = insertedChunks.slice(offset, offset + MAX_EMBEDDING_BATCH);
    try {
      const vectors = await embeddingService.generateBatchEmbeddings(
        batch.map((c) => c.content)
      );

      for (let i = 0; i < batch.length; i++) {
        try {
          await dbService.saveChunkEmbedding(
            batch[i].id,
            vectors[i],
            embeddingService.getModel()
          );
          result.chunksEmbedded++;
        } catch (err) {
          result.chunksFailed++;
          logger.error("Failed to save chunk embedding", {
            chunkId: batch[i].id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      result.chunksFailed += batch.length;
      logger.error("Failed to embed chunk batch", {
        confluenceId,
        title,
        batchStart: offset,
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function sync() {
  try {
    logger.info("Starting manual Confluence sync...");

    // Initialize database
    await dbService.initialize();

    // Fetch seed pages and expand with linked Confluence documents.
    const seedPages = await confluenceService.getAllPages();
    logger.info(`Fetched ${seedPages.length} seed pages from Confluence`);

    const expanded = await confluenceService.expandWithLinkedPages(seedPages);
    const pages = expanded.allPages;
    logger.info(
      `Expanded to ${pages.length} pages total (${expanded.linkedAdded} linked docs added, ${expanded.referencesScanned} references scanned)`
    );

    // Save each page
    let synced = 0;
    let totalChunks = 0;
    let chunksEmbedded = 0;
    let chunkEmbedFailed = 0;

    let attachmentsSynced = 0;
    let attachmentsRemoved = 0;
    let attachmentsExtracted = 0;
    let attachmentsSkipped = 0;
    let attachmentsFailed = 0;
    for (const page of pages) {
      try {
        // Extract text from HTML
        const rawHtml = page.body.storage.value;
        const $ = cheerio.load(rawHtml);
        const content = sanitizeForDb($.text().replace(/\s+/g, " ").trim());

        const pageDbId = await dbService.savePage({
          confluence_id: page.id,
          title: page.title,
          content,
          space_key: (page.space as any)?.key || "UNKNOWN",
          url: (page as any)._links?.webui || "",
          raw_html: sanitizeForDb(rawHtml),
          last_synced: new Date(),
        });

        synced++;

        // Sync attachments for this page
        let pageAttachments: any[] = [];
        try {
          pageAttachments = await confluenceService.getPageAttachments(page.id);
          const keepIds: string[] = [];
          for (const att of pageAttachments) {
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
            `Synced: ${page.title} (${pageAttachments.length} bilagor)`
          );
        } catch (attErr) {
          logger.error("Failed to sync attachments", {
            pageId: page.id,
            error: attErr instanceof Error ? attErr.message : String(attErr),
          });
          logger.info(`Synced: ${page.title}`);
        }

        // ---- Chunk + embed the page itself --------------------------------
        const pageResult = await chunkAndEmbed(pageDbId, page.id, page.title, rawHtml);
        totalChunks += pageResult.chunksCreated;
        chunksEmbedded += pageResult.chunksEmbedded;
        chunkEmbedFailed += pageResult.chunksFailed;

        // ---- Extract + chunk + embed each supported attachment ------------
        const spaceKey = (page.space as any)?.key || "UNKNOWN";
        for (const att of pageAttachments) {
          const ext = att.extensions || {};
          const fileName: string = ext.fileName || att.title;
          const mediaType: string | null = ext.mediaType || null;
          const downloadPath: string | null = att._links?.download || null;

          if (!downloadPath) continue;
          if (!isExtractableMediaType(mediaType, fileName)) {
            attachmentsSkipped++;
            continue;
          }

          try {
            const buffer = await downloadAttachment(downloadPath);
            const extracted = await extractAttachmentText(buffer, mediaType, fileName);
            const text = sanitizeForDb(extracted.text);

            if (!text || text.length < 20) {
              attachmentsSkipped++;
              logger.info("Attachment produced no extractable text", {
                attachmentId: att.id,
                fileName,
                mediaType,
                extractor: extracted.extractor,
              });
              continue;
            }

            // Persist the attachment as its own page row so the existing
            // chunk/embedding pipeline can store and retrieve it. We prefix
            // the confluence_id with "att:" so it can never collide with a
            // real Confluence page id.
            const attPageConfluenceId = `att:${att.id}`;
            const attTitle = `${page.title} – ${att.title}`;
            const attUrl = att._links?.webui || (page as any)._links?.webui || "";

            const attPageDbId = await dbService.savePage({
              confluence_id: attPageConfluenceId,
              title: attTitle,
              content: text,
              space_key: spaceKey,
              url: attUrl,
              raw_html: text,
              last_synced: new Date(),
            });

            const attResult = await chunkAndEmbed(
              attPageDbId,
              attPageConfluenceId,
              attTitle,
              text
            );
            totalChunks += attResult.chunksCreated;
            chunksEmbedded += attResult.chunksEmbedded;
            chunkEmbedFailed += attResult.chunksFailed;
            attachmentsExtracted++;

            logger.info("Extracted attachment", {
              attachmentId: att.id,
              fileName,
              extractor: extracted.extractor,
              chars: text.length,
              chunks: attResult.chunksCreated,
            });
          } catch (err) {
            attachmentsFailed++;
            logger.error("Failed to extract/embed attachment", {
              attachmentId: att.id,
              fileName,
              error: err instanceof Error ? err.message : String(err),
            });
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
    logger.info(
      `✓ Created ${totalChunks} chunks; embedded ${chunksEmbedded} (failed: ${chunkEmbedFailed})`
    );
    logger.info(
      `✓ Synced ${attachmentsSynced} attachments (${attachmentsRemoved} borttagna)`
    );
    logger.info(
      `✓ Extracted text from ${attachmentsExtracted} attachments (skipped: ${attachmentsSkipped}, failed: ${attachmentsFailed})`
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
