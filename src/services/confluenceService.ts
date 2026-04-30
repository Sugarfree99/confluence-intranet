import axios from "axios";
import { config } from "../config";
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

export interface ConfluencePage {
  id: string;
  type: string;
  title: string;
  space: any;
  body: {
    storage: {
      value: string;
    };
  };
  _links: {
    webui: string;
  };
  metadata: {
    currentuser: {
      username: string;
    };
  };
}

interface ConfluenceResponse {
  results: ConfluencePage[];
  start: number;
  limit: number;
  size: number;
  _links: {
    next?: string;
  };
}

export class ConfluenceService {
  private baseUrl: string;
  private auth: string;

  constructor() {
    const rawBaseUrl = config.confluence.baseUrl.replace(/\/$/, "");
    this.baseUrl = rawBaseUrl.endsWith("/wiki") ? rawBaseUrl : `${rawBaseUrl}/wiki`;
    const credentials = `${config.confluence.username}:${config.confluence.apiToken}`;
    this.auth = Buffer.from(credentials).toString("base64");
  }

  private async makeRequest(endpoint: string, params: any = {}) {
    try {
      const response = await axios.get(`${this.baseUrl}/rest/api/content${endpoint}`, {
        params: {
          expand: "body.storage,metadata.currentuser,space",
          limit: 50,
          ...params,
        },
        headers: {
          Authorization: `Basic ${this.auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      });
      return response.data;
    } catch (error) {
      logger.error("Confluence API error", {
        error: error instanceof Error ? error.message : String(error),
        endpoint,
      });
      throw error;
    }
  }

  async getSpacePages(spaceKey: string): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    let start = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const response: ConfluenceResponse = await this.makeRequest("", {
        spaceKey,
        type: "page",
        start,
        limit,
      });

      pages.push(...response.results);

      if (response._links.next) {
        start += limit;
      } else {
        hasMore = false;
      }
    }

    logger.info(`Retrieved ${pages.length} pages from space ${spaceKey}`);
    return pages;
  }

  async getPageContent(pageId: string): Promise<ConfluencePage> {
    const response = await this.makeRequest(`/${pageId}`);
    return response;
  }

  async getPageAttachments(pageId: string): Promise<any[]> {
    const attachments: any[] = [];
    let start = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await axios.get(
          `${this.baseUrl}/rest/api/content/${pageId}/child/attachment`,
          {
            params: { start, limit, expand: "version,metadata" },
            headers: {
              Authorization: `Basic ${this.auth}`,
              Accept: "application/json",
            },
          }
        );
        const data = response.data;
        attachments.push(...(data.results || []));
        if (data._links && data._links.next) {
          start += limit;
        } else {
          hasMore = false;
        }
      } catch (error) {
        logger.error("Failed to fetch attachments", {
          pageId,
          error: error instanceof Error ? error.message : String(error),
        });
        hasMore = false;
      }
    }
    return attachments;
  }

  async getAllPages(): Promise<ConfluencePage[]> {
    return this.getSpacePages(config.confluence.spaceKey);
  }

  private extractLinkedPageIdsFromHtml(html: string): string[] {
    const ids = new Set<string>();
    const $ = cheerio.load(html || "");

    $("a[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;

      const pagesMatch = href.match(/\/pages\/(\d+)/i);
      if (pagesMatch?.[1]) {
        ids.add(pagesMatch[1]);
        return;
      }

      const pageIdMatch = href.match(/[?&]pageId=(\d+)/i);
      if (pageIdMatch?.[1]) {
        ids.add(pageIdMatch[1]);
      }
    });

    return Array.from(ids);
  }

  private extractLinkedPageTitlesFromHtml(
    html: string,
    fallbackSpaceKey: string
  ): Array<{ title: string; spaceKey: string }> {
    const refs = new Map<string, { title: string; spaceKey: string }>();
    const $ = cheerio.load(html || "", { xmlMode: false });

    $("ri\\:page").each((_, el) => {
      const title = ($(el).attr("ri:content-title") || "").trim();
      if (!title) return;

      const spaceKey = ($(el).attr("ri:space-key") || fallbackSpaceKey || config.confluence.spaceKey).trim();
      const key = `${spaceKey}::${title.toLowerCase()}`;
      if (!refs.has(key)) {
        refs.set(key, { title, spaceKey });
      }
    });

    return Array.from(refs.values());
  }

  private async getPageByTitle(spaceKey: string, title: string): Promise<ConfluencePage | null> {
    const response: ConfluenceResponse = await this.makeRequest("", {
      spaceKey,
      title,
      type: "page",
      limit: 1,
    });

    if (!response.results || response.results.length === 0) {
      return null;
    }

    return response.results[0];
  }

  async expandWithLinkedPages(seedPages: ConfluencePage[]): Promise<{
    allPages: ConfluencePage[];
    linkedAdded: number;
    referencesScanned: number;
  }> {
    const pageMap = new Map<string, ConfluencePage>();
    const titleLookupCache = new Map<string, ConfluencePage | null>();
    let linkedAdded = 0;
    let referencesScanned = 0;

    for (const page of seedPages) {
      pageMap.set(page.id, page);
    }

    for (const page of seedPages) {
      const rawHtml = page.body?.storage?.value || "";
      const fallbackSpaceKey = (page.space as any)?.key || config.confluence.spaceKey;

      const linkedIds = this.extractLinkedPageIdsFromHtml(rawHtml);
      referencesScanned += linkedIds.length;
      for (const linkedId of linkedIds) {
        if (pageMap.has(linkedId)) continue;

        try {
          const linkedPage = await this.getPageContent(linkedId);
          pageMap.set(linkedPage.id, linkedPage);
          linkedAdded++;
        } catch (error) {
          logger.warn("Failed to resolve linked page by ID", {
            linkedId,
            sourcePageId: page.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const titleRefs = this.extractLinkedPageTitlesFromHtml(rawHtml, fallbackSpaceKey);
      referencesScanned += titleRefs.length;
      for (const ref of titleRefs) {
        const cacheKey = `${ref.spaceKey}::${ref.title.toLowerCase()}`;

        if (!titleLookupCache.has(cacheKey)) {
          try {
            const resolved = await this.getPageByTitle(ref.spaceKey, ref.title);
            titleLookupCache.set(cacheKey, resolved);
          } catch (error) {
            logger.warn("Failed to resolve linked page by title", {
              title: ref.title,
              spaceKey: ref.spaceKey,
              sourcePageId: page.id,
              error: error instanceof Error ? error.message : String(error),
            });
            titleLookupCache.set(cacheKey, null);
          }
        }

        const resolvedPage = titleLookupCache.get(cacheKey);
        if (resolvedPage && !pageMap.has(resolvedPage.id)) {
          pageMap.set(resolvedPage.id, resolvedPage);
          linkedAdded++;
        }
      }
    }

    return {
      allPages: Array.from(pageMap.values()),
      linkedAdded,
      referencesScanned,
    };
  }
}

export default new ConfluenceService();
