import express from "express";
import cors from "cors";
import path from "path";
import apiRoutes from "./routes";
import { config } from "./config";
import dbService from "./services/dbService";
import * as winston from "winston";
import cron from "node-cron";
import confluenceService from "./services/confluenceService";
import aiOptimizationService from "./services/aiOptimizationService";
import embeddingService from "./services/embeddingService";
import * as cheerio from "cheerio";
import { generateToken } from "./middleware/auth";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

const app = express();
const publicDir = path.join(__dirname, "../public");

// CORS Configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:5173",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

// Logging middleware
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use("/api", apiRoutes);

// Chat UI
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/**
 * Friendly document URL: /doc/:slug
 *
 * Renders the document inside our own app (using the configured baseUrl —
 * we never redirect off-site). For regular Confluence pages we display the
 * stored raw_html; for synthetic attachment-pages (confluence_id "att:...")
 * we display the extracted plain text plus a link to fetch the original
 * binary via the Confluence download URL.
 */
function slugifyTitle(title: string): string {
  return (title || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 120);
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderDocPage(opts: {
  title: string;
  bodyHtml: string;
  originalLink?: { href: string; label: string } | null;
}): string {
  const original = opts.originalLink
    ? `<a class="btn" href="${escapeHtml(opts.originalLink.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(opts.originalLink.label)}</a>`
    : "";
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f7f9; color: #1a1a1a; }
  header { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #e3e5e8; padding: 12px 20px; display: flex; gap: 12px; align-items: center; }
  header a.back { color: #555; text-decoration: none; font-size: 14px; }
  header a.back:hover { color: #000; }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  .btn { display: inline-block; padding: 6px 12px; background: #2563eb; color: #fff; border-radius: 6px; text-decoration: none; font-size: 13px; }
  .btn:hover { background: #1d4ed8; }
  main { max-width: 920px; margin: 24px auto; padding: 24px 28px; background: #fff; border: 1px solid #e3e5e8; border-radius: 8px; }
  main h1.doc-title { margin-top: 0; font-size: 24px; }
  .doc-body { line-height: 1.6; }
  .doc-body img { max-width: 100%; height: auto; }
  .doc-body table { border-collapse: collapse; margin: 12px 0; }
  .doc-body th, .doc-body td { border: 1px solid #e3e5e8; padding: 6px 10px; }
  .doc-body pre { background: #f6f7f9; padding: 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    header, main { background: #181a20; border-color: #2a2d34; }
    header a.back { color: #9ca3af; }
    header h1 { color: #e5e7eb; }
    .doc-body pre { background: #0f1115; }
    .doc-body th, .doc-body td { border-color: #2a2d34; }
  }
</style>
</head>
<body>
  <header>
    <a class="back" href="/">← Tillbaka till chatten</a>
    <h1>${escapeHtml(opts.title)}</h1>
    ${original}
  </header>
  <main>
    <h1 class="doc-title">${escapeHtml(opts.title)}</h1>
    <article class="doc-body">${opts.bodyHtml}</article>
  </main>
</body>
</html>`;
}

app.get("/doc/:slug", async (req, res) => {
  try {
    const slug = (req.params.slug || "").toLowerCase();
    if (!slug) return res.status(404).send("Document not found");

    const pages = await dbService.getPages(5000, 0);
    const match = pages.find((p) => slugifyTitle(p.title) === slug);

    if (!match) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(
        renderDocPage({
          title: "Dokumentet hittades inte",
          bodyHtml: `<p>Slug: <code>${escapeHtml(slug)}</code></p>`,
        })
      );
    }

    const isAttachmentPage =
      typeof match.confluence_id === "string" &&
      match.confluence_id.startsWith("att:");

    let bodyHtml = "";
    let originalLink: { href: string; label: string } | null = null;

    if (isAttachmentPage) {
      // Synthetic attachment page: just present a download link. We no
      // longer try to preview the file inline — clicking the link sends
      // the raw bytes (with the original media type) to the browser,
      // which then handles it like any other file download.
      const attId = match.confluence_id.substring(4);
      const attRow = await dbService.getAttachmentByConfluenceId(attId);
      const hasBytes = !!attRow?.file_data;
      const rawSrc = `/attachment/${encodeURIComponent(attId)}/raw`;
      const fileName: string =
        attRow?.file_name || attRow?.title || match.title || "fil";
      const mediaType: string = attRow?.media_type || "okänd typ";
      const sizeStr =
        typeof attRow?.file_size === "number" || typeof attRow?.file_size === "string"
          ? `${(Number(attRow.file_size) / 1024).toFixed(1)} kB`
          : "okänd storlek";

      let downloadHref = "";
      if (hasBytes) {
        downloadHref = `${rawSrc}?download=1`;
      } else {
        const dl = attRow?.download_url || attRow?.web_url || match.url || "";
        if (dl) {
          downloadHref = /^https?:\/\//i.test(dl)
            ? dl
            : `${process.env.CONFLUENCE_BASE_URL || ""}${dl}`;
        }
      }

      bodyHtml = downloadHref
        ? `<p>Filen <strong>${escapeHtml(fileName)}</strong> (${escapeHtml(mediaType)}, ${escapeHtml(sizeStr)}) kan laddas ner nedan.</p>
           <p><a class="btn" href="${escapeHtml(downloadHref)}">Ladda ner ${escapeHtml(fileName)}</a></p>`
        : `<p><em>Filen är inte tillgänglig för nedladdning.</em></p>`;

      if (downloadHref) {
        originalLink = { href: downloadHref, label: "Ladda ner" };
      }
    } else {
      // Regular Confluence page: render stored HTML body.
      bodyHtml =
        match.raw_html && match.raw_html.trim().length > 0
          ? match.raw_html
          : `<p>${escapeHtml(match.content || "")}</p>`;

      // List attachments that belong to this page so the user can drill in.
      try {
        const atts = await dbService.getAttachmentsByPageId(match.confluence_id);
        if (atts.length > 0) {
          const items = atts
            .map((a: any) => {
              const attTitle = `${match.title} – ${a.title}`;
              const attSlug = slugifyTitle(attTitle);
              return `<li><a href="/doc/${encodeURIComponent(attSlug)}">${escapeHtml(a.title)}</a></li>`;
            })
            .join("");
          bodyHtml += `<hr><h2>Bilagor</h2><ul>${items}</ul>`;
        }
      } catch {
        // Non-fatal: just skip the attachment list.
      }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDocPage({ title: match.title, bodyHtml, originalLink }));
  } catch (error) {
    logger.error("Failed to resolve /doc/:slug", {
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send("Internal error");
  }
});

/**
 * Stream the raw bytes of an attachment back to the browser using its
 * original media type, so images/PDFs/audio/video can be previewed inline.
 * Append `?download=1` to force a Save As dialog.
 */
app.get("/attachment/:id/raw", async (req, res) => {
  try {
    const id = req.params.id;
    const file = await dbService.getAttachmentFile(id);

    if (!file) {
      // No raw bytes stored — fall back to the Confluence download URL
      // so the user still gets the file.
      const meta = await dbService.getAttachmentByConfluenceId(id);
      const dl = meta?.download_url || meta?.web_url;
      if (dl) {
        const absolute = /^https?:\/\//i.test(dl)
          ? dl
          : `${(process.env.CONFLUENCE_BASE_URL || "").replace(/\/$/, "")}${dl}`;
        return res.redirect(302, absolute);
      }
      return res.status(404).send("Attachment not found");
    }

    const mediaType = file.media_type || "application/octet-stream";
    const fileName = file.file_name || file.title || "file";
    // Always send as attachment so the browser triggers a download dialog.
    // (Previously we used `inline` unless ?download=1 was set; that caused
    // browsers to navigate to the URL and try to render the bytes instead
    // of saving them, so links from chat sources felt "broken".)
    const disposition = "attachment";

    // RFC 5987 encoding lets us send Unicode file names safely.
    const asciiName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    const utf8Name = encodeURIComponent(fileName);

    res.setHeader("Content-Type", mediaType);
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`
    );
    res.setHeader("Content-Length", String(file.data.length));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end(file.data);
  } catch (error) {
    logger.error("Failed to stream attachment", {
      id: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send("Internal error");
  }
});


app.post("/auth/login", (req, res) => {
  const { username, password } = req.body;
  
  // Simple authentication - in production use proper auth service
  if (username === "admin" && password === process.env.ADMIN_PASSWORD) {
    const token = generateToken("admin", "admin");
    res.json({
      success: true,
      token,
      message: "Login successful",
    });
  } else {
    res.status(401).json({
      success: false,
      error: "Invalid credentials",
    });
  }
});

// Initialize synchronization
async function initializeSync() {
  try {
    await dbService.initialize();
    logger.info("Database initialized");
  } catch (error) {
    logger.error("Failed to initialize database", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Schedule periodic sync
  const intervalMinutes = config.sync.intervalMinutes;
  const cronExpression = `0 */${intervalMinutes} * * * *`; // Every N minutes

  cron.schedule(cronExpression, async () => {
    logger.info("Running scheduled Confluence sync");

    try {
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

          // Process chunks if page was saved
          const savedPage = await dbService.getPageById(page.id);
          if (savedPage?.id) {
            const chunks = await aiOptimizationService.processPageIntoChunks(
              Number(savedPage.id) || 0,
              page.id,
              page.title,
              page.body.storage.value
            );
            chunked += chunks.length;

            // Generate embeddings
            for (const chunk of chunks) {
              if (chunk.id) {
                try {
                  const embedding = await embeddingService.generateEmbedding(chunk.content);
                  await aiOptimizationService.saveEmbedding(chunk.id, embedding);
                  embedded++;
                } catch (error) {
                  logger.error("Failed to embed chunk", { chunkId: chunk.id });
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

      logger.info("Scheduled sync completed", {
        pagesSync: synced,
        chunksCreated: chunked,
        embeddingsGenerated: embedded,
      });

      await aiOptimizationService.logSyncOperation("scheduled_sync", "success", synced);
    } catch (error) {
      logger.error("Scheduled sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await aiOptimizationService.logSyncOperation("scheduled_sync", "failed", 0, 1,
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  logger.info(`Scheduled sync configured to run every ${intervalMinutes} minutes`);
}

// Start server
const port = config.server.port;

app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  logger.info(`Environment: ${config.server.env}`);
  logger.info(`Confluence: ${config.confluence.baseUrl}`);
  logger.info(`CORS origin: ${process.env.CORS_ORIGIN || "http://localhost:5173"}`);

  // Initialize database and sync
  initializeSync();
});

export default app;
