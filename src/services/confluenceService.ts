import axios from "axios";
import { config } from "../config";
import * as winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

interface ConfluencePage {
  id: string;
  type: string;
  title: string;
  space: string;
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

  async getAllPages(): Promise<ConfluencePage[]> {
    return this.getSpacePages(config.confluence.spaceKey);
  }
}

export default new ConfluenceService();
