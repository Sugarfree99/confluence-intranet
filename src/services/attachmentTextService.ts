import axios from "axios";
import * as winston from "winston";
import { config } from "../config";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

export interface ExtractedAttachment {
  text: string;
  pages?: number;
  extractor: "pdf" | "docx" | "text" | "unsupported";
}

const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "text/html",
]);

const DOCX_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const PDF_MEDIA_TYPES = new Set(["application/pdf"]);

function getConfluenceAuthHeader(): string {
  const credentials = `${config.confluence.username}:${config.confluence.apiToken}`;
  return "Basic " + Buffer.from(credentials).toString("base64");
}

function getConfluenceBaseUrl(): string {
  const raw = config.confluence.baseUrl.replace(/\/$/, "");
  return raw.endsWith("/wiki") ? raw : `${raw}/wiki`;
}

/**
 * Download an attachment from Confluence as a Buffer.
 * `downloadUrl` is the path returned by the API (e.g. "/download/attachments/...").
 */
export async function downloadAttachment(downloadUrl: string): Promise<Buffer> {
  const url = downloadUrl.startsWith("http")
    ? downloadUrl
    : `${getConfluenceBaseUrl()}${downloadUrl}`;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    maxRedirects: 5,
    headers: {
      Authorization: getConfluenceAuthHeader(),
      Accept: "*/*",
    },
  });
  return Buffer.from(response.data);
}

/**
 * Extract plain text from a downloaded attachment based on its media type
 * and/or filename. Returns an empty string for unsupported formats.
 */
export async function extractAttachmentText(
  buffer: Buffer,
  mediaType: string | null | undefined,
  fileName: string | null | undefined
): Promise<ExtractedAttachment> {
  const mt = (mediaType || "").toLowerCase();
  const lowerName = (fileName || "").toLowerCase();

  try {
    if (PDF_MEDIA_TYPES.has(mt) || lowerName.endsWith(".pdf")) {
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      return {
        text: (result.text || "").trim(),
        pages: result.total,
        extractor: "pdf",
      };
    }

    if (DOCX_MEDIA_TYPES.has(mt) || lowerName.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return {
        text: (result.value || "").trim(),
        extractor: "docx",
      };
    }

    if (
      TEXT_MEDIA_TYPES.has(mt) ||
      lowerName.endsWith(".txt") ||
      lowerName.endsWith(".md") ||
      lowerName.endsWith(".csv") ||
      lowerName.endsWith(".json")
    ) {
      return {
        text: buffer.toString("utf-8").trim(),
        extractor: "text",
      };
    }

    return { text: "", extractor: "unsupported" };
  } catch (error) {
    logger.warn("Failed to extract attachment text", {
      mediaType: mt,
      fileName,
      error: error instanceof Error ? error.message : String(error),
    });
    return { text: "", extractor: "unsupported" };
  }
}

export function isExtractableMediaType(
  mediaType: string | null | undefined,
  fileName: string | null | undefined
): boolean {
  const mt = (mediaType || "").toLowerCase();
  const lowerName = (fileName || "").toLowerCase();
  return (
    PDF_MEDIA_TYPES.has(mt) ||
    DOCX_MEDIA_TYPES.has(mt) ||
    TEXT_MEDIA_TYPES.has(mt) ||
    lowerName.endsWith(".pdf") ||
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".json")
  );
}
