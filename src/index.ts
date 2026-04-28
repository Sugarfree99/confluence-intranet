import express from "express";
import cors from "cors";
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

// Logging middleware
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use("/api", apiRoutes);

// Simple auth endpoint for testing
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
      const pages = await confluenceService.getAllPages();
      logger.info(`Fetched ${pages.length} pages from Confluence`);

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
