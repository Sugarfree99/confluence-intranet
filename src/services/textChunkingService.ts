import * as cheerio from "cheerio";

interface ChunkOptions {
  maxTokens?: number;
  maxCharacters?: number;
  preferHeadings?: boolean;
}

interface Chunk {
  index: number;
  content: string;
  type: string;
  characterCount: number;
  tokenCount: number;
  startPosition: number;
  metadata: {
    language: string;
    confidence: number;
    originalType: string;
  };
}

export class TextChunkingService {
  static readonly DEFAULT_MAX_TOKENS = 300; // ~1000 characters per chunk
  static readonly DEFAULT_MAX_CHARS = 1000;

  /**
   * Parse HTML content and extract semantic chunks
   */
  static parseHTML(html: string): Array<{ type: string; content: string }> {
    const $ = cheerio.load(html);
    const elements: Array<{ type: string; content: string }> = [];

    // Extract structured content
    $.root()
      .children()
      .each((_, el) => {
        const tagName = el.name?.toLowerCase();

        switch (tagName) {
          case "h1":
          case "h2":
          case "h3":
          case "h4":
          case "h5":
          case "h6":
            elements.push({
              type: "heading",
              content: $.text($(el)).trim(),
            });
            break;

          case "p":
            const text = $.text($(el)).trim();
            if (text) {
              elements.push({
                type: "paragraph",
                content: text,
              });
            }
            break;

          case "pre":
          case "code":
            elements.push({
              type: "code",
              content: $.text($(el)).trim(),
            });
            break;

          case "ul":
          case "ol":
            const items: string[] = [];
            $(el)
              .find("li")
              .each((_, li) => {
                items.push("• " + $.text($(li)).trim());
              });
            if (items.length > 0) {
              elements.push({
                type: "list",
                content: items.join("\n"),
              });
            }
            break;

          case "table":
            const rows: string[] = [];
            $(el)
              .find("tr")
              .each((_, tr) => {
                const cells: string[] = [];
                $(tr)
                  .find("td, th")
                  .each((_, td) => {
                    cells.push($.text($(td)).trim());
                  });
                rows.push(cells.join(" | "));
              });
            if (rows.length > 0) {
              elements.push({
                type: "table",
                content: rows.join("\n"),
              });
            }
            break;

          case "blockquote":
            elements.push({
              type: "quote",
              content: $.text($(el)).trim(),
            });
            break;
        }
      });

    return elements;
  }

  /**
   * Estimate token count (rough approximation)
   */
  static estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters or 1 word ≈ 1.3 tokens
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }

  /**
   * Split content into semantic chunks optimized for AI
   */
  static chunkContent(
    html: string,
    documentTitle: string,
    options: ChunkOptions = {}
  ): Chunk[] {
    const maxTokens = options.maxTokens || TextChunkingService.DEFAULT_MAX_TOKENS;
    const maxChars = options.maxCharacters || TextChunkingService.DEFAULT_MAX_CHARS;

    const elements = this.parseHTML(html);
    const chunks: Chunk[] = [];
    let currentChunk = "";
    let currentType = "mixed";
    let charPosition = 0;
    let chunkIndex = 0;

    for (const element of elements) {
      // Determine if we should start a new chunk
      const combinedLength = currentChunk + "\n" + element.content;
      const estimatedTokens = this.estimateTokens(combinedLength);

      // Start new chunk if:
      // 1. Adding element would exceed limits
      // 2. Element is a heading (new section)
      if (
        (estimatedTokens > maxTokens || combinedLength.length > maxChars) &&
        currentChunk.length > 0
      ) {
        chunks.push(this.createChunk(currentChunk, currentType, chunkIndex, charPosition, documentTitle));
        chunkIndex++;
        currentChunk = element.content;
        currentType = element.type;
        charPosition += combinedLength.length;
      } else if (element.type === "heading" && currentChunk.length > 100) {
        // Start new chunk for headings with significant content
        if (currentChunk.length > 0) {
          chunks.push(this.createChunk(currentChunk, currentType, chunkIndex, charPosition, documentTitle));
          chunkIndex++;
          charPosition += currentChunk.length;
        }
        currentChunk = element.content;
        currentType = element.type;
      } else {
        // Add to current chunk
        if (currentChunk.length > 0) {
          currentChunk += "\n";
        }
        currentChunk += element.content;
        if (element.type === "heading") currentType = "mixed";
      }
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      chunks.push(this.createChunk(currentChunk, currentType, chunkIndex, charPosition, documentTitle));
    }

    return chunks;
  }

  private static createChunk(
    content: string,
    type: string,
    index: number,
    startPosition: number,
    title: string
  ): Chunk {
    return {
      index,
      content,
      type,
      characterCount: content.length,
      tokenCount: this.estimateTokens(content),
      startPosition,
      metadata: {
        language: "sv", // Swedish
        confidence: 0.95,
        originalType: type,
      },
    };
  }

  /**
   * Create a context-aware chunk with surrounding content for better AI understanding
   */
  static createContextualChunks(
    html: string,
    documentTitle: string
  ): Array<Chunk & { context: string }> {
    const baseChunks = this.chunkContent(html, documentTitle);

    return baseChunks.map((chunk, index) => {
      const previousContent =
        index > 0 ? `Previous: ${baseChunks[index - 1].content.substring(0, 100)}...` : "";
      const nextContent =
        index < baseChunks.length - 1 ? `Next: ${baseChunks[index + 1].content.substring(0, 100)}...` : "";

      return {
        ...chunk,
        context: [previousContent, `Title: ${documentTitle}`, nextContent]
          .filter((x) => x)
          .join(" | "),
      };
    });
  }
}

export default TextChunkingService;
