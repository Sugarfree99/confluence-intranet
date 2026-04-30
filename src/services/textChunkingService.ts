import * as cheerio from "cheerio";

/**
 * Deterministic, logic-based semantic chunker for the RAG pipeline.
 *
 * No LLMs, no embeddings, no model-based topic detection. Splits are decided
 * purely from document structure using this priority cascade:
 *
 *   1. Headings / sections
 *   2. Paragraphs (blank lines, <p>, list items, table rows, ...)
 *   3. Sentences (punctuation-based)
 *   4. Hard split on word boundaries (last resort)
 *
 * A small token overlap is added between consecutive chunks belonging to the
 * same section, on a sentence/word boundary, to preserve context across cuts.
 */

interface ChunkOptions {
  /** Soft upper bound (in estimated tokens) for a single chunk. */
  maxTokens?: number;
  /** Hard upper bound (in characters) for a single chunk. */
  maxCharacters?: number;
  /** Approximate token overlap between adjacent chunks of the same section. */
  overlapTokens?: number;
  /** Minimum tokens per chunk before we try to merge with the next one. */
  minTokens?: number;
  /** Kept for API compatibility — chunker always prefers headings. */
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
    /** Heading path (e.g. "H1 > H2") that this chunk belongs to, if any. */
    headingPath?: string;
    /** Which rule produced the cut: section | paragraph | sentence | hard. */
    splitStrategy?: "section" | "paragraph" | "sentence" | "hard";
  };
}

interface Block {
  type: "heading" | "paragraph" | "code" | "list" | "table" | "quote";
  /** 1–6 for headings, undefined otherwise. */
  level?: number;
  content: string;
}

export class TextChunkingService {
  static readonly DEFAULT_MAX_TOKENS = 300; // ~1000 characters per chunk
  static readonly DEFAULT_MAX_CHARS = 1000;
  static readonly DEFAULT_OVERLAP_TOKENS = 50;
  static readonly DEFAULT_MIN_TOKENS = 80;

  /**
   * Parse HTML content into an ordered list of structural blocks.
   *
   * Walks the full DOM (not just root children) so it handles HTML fragments
   * that cheerio auto-wraps in <html><body>, as well as Confluence storage
   * format where content sits inside <ac:rich-text-body> macros.
   */
  static parseHTML(html: string): Block[] {
    const $ = cheerio.load(html);
    const elements: Block[] = [];
    const seen = new Set<any>();

    const SELECTOR = "h1, h2, h3, h4, h5, h6, p, pre, code, ul, ol, table, blockquote";

    $(SELECTOR).each((_, el) => {
      // Skip nested elements already covered by an ancestor we'll emit
      // (e.g. <p> inside <blockquote>, <code> inside <pre>, <li> handled via <ul>)
      const $el = $(el);
      if ($el.parents("pre, blockquote, ul, ol, table").length > 0) return;
      if (seen.has(el)) return;
      seen.add(el);

      const tagName = (el as any).name?.toLowerCase();
      let item: Block | null = null;

      switch (tagName) {
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6": {
          const text = $el.text().trim();
          if (text) item = { type: "heading", level: parseInt(tagName.slice(1), 10), content: text };
          break;
        }
        case "p": {
          const text = $el.text().trim();
          if (text) item = { type: "paragraph", content: text };
          break;
        }
        case "pre":
        case "code": {
          const text = $el.text().trim();
          if (text) item = { type: "code", content: text };
          break;
        }
        case "ul":
        case "ol": {
          const items: string[] = [];
          $el.find("li").each((_, li) => {
            const t = $(li).text().trim();
            if (t) items.push("• " + t);
          });
          if (items.length > 0) item = { type: "list", content: items.join("\n") };
          break;
        }
        case "table": {
          const rows: string[] = [];
          $el.find("tr").each((_, tr) => {
            const cells: string[] = [];
            $(tr)
              .find("td, th")
              .each((_, td) => {
                cells.push($(td).text().trim());
              });
            if (cells.length) rows.push(cells.join(" | "));
          });
          if (rows.length > 0) item = { type: "table", content: rows.join("\n") };
          break;
        }
        case "blockquote": {
          const text = $el.text().trim();
          if (text) item = { type: "quote", content: text };
          break;
        }
      }

      if (item) elements.push(item);
    });

    return elements;
  }

  /**
   * Parse a markdown / plain-text document into structural blocks.
   *   - Lines starting with `#`..`######` become headings (level = # count).
   *   - Blank lines separate paragraphs.
   *   - Fenced ``` blocks become code blocks.
   *   - Lines starting with `-`, `*`, `+`, or `\d+.` are grouped into lists.
   */
  static parseMarkdown(text: string): Block[] {
    const blocks: Block[] = [];
    const lines = text.replace(/\r\n/g, "\n").split("\n");

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // blank line -> paragraph separator
      if (!line.trim()) {
        i++;
        continue;
      }

      // fenced code
      if (line.trim().startsWith("```")) {
        const buf: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          buf.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        if (buf.length) blocks.push({ type: "code", content: buf.join("\n") });
        continue;
      }

      // heading
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        blocks.push({ type: "heading", level: h[1].length, content: h[2].trim() });
        i++;
        continue;
      }

      // list (consecutive list lines)
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push("• " + lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "").trim());
          i++;
        }
        blocks.push({ type: "list", content: items.join("\n") });
        continue;
      }

      // paragraph: consume until blank line
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i].trim());
        i++;
      }
      if (buf.length) blocks.push({ type: "paragraph", content: buf.join(" ") });
    }

    return blocks;
  }

  /**
   * Estimate token count (rough approximation, deterministic).
   * 1 word ≈ 1.3 tokens is good enough for budgeting.
   */
  static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
  }

  // ---------------------------------------------------------------------------
  // Splitting primitives (priority cascade)
  // ---------------------------------------------------------------------------

  /** Split text into paragraphs by blank lines / line breaks. */
  private static splitParagraphs(text: string): string[] {
    return text
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /**
   * Split text into sentences using punctuation. Deterministic, regex-based,
   * with a few common-abbreviation guards (e.g. "t.ex.", "dvs.", "Mr.").
   */
  private static splitSentences(text: string): string[] {
    if (!text.trim()) return [];

    // Protect a small set of abbreviations so the regex doesn't cut them.
    const ABBREV = ["t.ex", "bl.a", "dvs", "ev", "ca", "fr.o.m", "t.o.m", "Mr", "Mrs", "Dr", "St", "etc", "vs", "No", "fig"];
    let masked = text;
    const placeholders: Array<[string, string]> = [];
    ABBREV.forEach((abbr, idx) => {
      const tag = `__ABBR${idx}__`;
      const re = new RegExp(abbr.replace(/\./g, "\\.") + "\\.", "g");
      if (re.test(masked)) {
        masked = masked.replace(re, tag);
        placeholders.push([tag, abbr + "."]);
      }
    });

    const parts = masked
      .split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9"'(])/u)
      .map((s) => s.trim())
      .filter(Boolean);

    return parts.map((p) => {
      let out = p;
      for (const [tag, original] of placeholders) out = out.split(tag).join(original);
      return out;
    });
  }

  /**
   * Hard split — last resort. Splits on word boundaries when a single
   * sentence is itself larger than the token budget.
   */
  private static hardSplit(text: string, maxTokens: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let buf: string[] = [];
    let bufTokens = 0;

    for (const w of words) {
      const wt = Math.max(1, Math.ceil(1.3));
      if (bufTokens + wt > maxTokens && buf.length) {
        out.push(buf.join(" "));
        buf = [];
        bufTokens = 0;
      }
      buf.push(w);
      bufTokens += wt;
    }
    if (buf.length) out.push(buf.join(" "));
    return out;
  }

  /**
   * Tail of a string containing roughly `overlapTokens` worth of content,
   * snapped to a sentence boundary if possible, otherwise to a word boundary.
   * Used to seed the next chunk so context is preserved across cuts.
   */
  private static overlapTail(text: string, overlapTokens: number): string {
    if (overlapTokens <= 0 || !text) return "";

    const sentences = this.splitSentences(text);
    if (sentences.length > 1) {
      const buf: string[] = [];
      let tokens = 0;
      for (let i = sentences.length - 1; i >= 0; i--) {
        const t = this.estimateTokens(sentences[i]);
        if (tokens + t > overlapTokens && buf.length) break;
        buf.unshift(sentences[i]);
        tokens += t;
      }
      if (buf.length) return buf.join(" ");
    }

    // Word-level fallback
    const words = text.split(/\s+/).filter(Boolean);
    const take = Math.min(words.length, Math.max(1, Math.round(overlapTokens / 1.3)));
    return words.slice(words.length - take).join(" ");
  }

  /**
   * Greedy packer: take an ordered list of pieces (paragraphs or sentences)
   * and merge them into chunks bounded by maxTokens / maxChars.
   */
  private static packPieces(
    pieces: string[],
    maxTokens: number,
    maxChars: number
  ): string[] {
    const chunks: string[] = [];
    let buf = "";
    let bufTokens = 0;

    const flush = () => {
      if (buf.trim()) chunks.push(buf.trim());
      buf = "";
      bufTokens = 0;
    };

    for (const piece of pieces) {
      const pt = this.estimateTokens(piece);
      const sep = buf ? "\n\n" : "";
      const wouldChars = buf.length + sep.length + piece.length;
      const wouldTokens = bufTokens + pt;

      if (buf && (wouldTokens > maxTokens || wouldChars > maxChars)) {
        flush();
      }
      buf += (buf ? "\n\n" : "") + piece;
      bufTokens += pt;
    }
    flush();
    return chunks;
  }

  /**
   * Section-level chunking. Given the blocks belonging to one section
   * (i.e. a heading and everything until the next sibling/parent heading),
   * apply the cascade and return chunks for that section.
   */
  private static chunkSection(
    blocks: Block[],
    headingPath: string,
    maxTokens: number,
    maxChars: number,
    overlapTokens: number
  ): Array<{ content: string; type: string; strategy: Chunk["metadata"]["splitStrategy"] }> {
    if (blocks.length === 0) return [];

    // Build a single section text. Headings inline so they stay with their text.
    const sectionText = blocks
      .map((b) => (b.type === "heading" ? `${"#".repeat(b.level || 2)} ${b.content}` : b.content))
      .join("\n\n");
    const sectionTokens = this.estimateTokens(sectionText);

    // Dominant block type for metadata (first non-heading, else heading)
    const dominant = blocks.find((b) => b.type !== "heading")?.type || blocks[0].type;

    // 1. Whole section fits -> single chunk
    if (sectionTokens <= maxTokens && sectionText.length <= maxChars) {
      return [{ content: sectionText, type: dominant, strategy: "section" }];
    }

    // 2. Paragraph-level packing
    const paragraphs = blocks.flatMap((b) => {
      const prefix = b.type === "heading" ? `${"#".repeat(b.level || 2)} ` : "";
      // Treat lists/tables/code as a single paragraph each.
      if (b.type === "paragraph") return this.splitParagraphs(b.content);
      return [prefix + b.content];
    });

    let strategy: Chunk["metadata"]["splitStrategy"] = "paragraph";
    let packed = this.packPieces(paragraphs, maxTokens, maxChars);

    // 3. If any chunk is still over budget, drill into sentences for that piece.
    const refined: string[] = [];
    for (const chunk of packed) {
      if (this.estimateTokens(chunk) <= maxTokens && chunk.length <= maxChars) {
        refined.push(chunk);
        continue;
      }
      strategy = "sentence";
      const sentences = this.splitSentences(chunk);
      const sentencePacked = this.packPieces(sentences, maxTokens, maxChars);

      // 4. Hard split: a single sentence is still too big.
      for (const sc of sentencePacked) {
        if (this.estimateTokens(sc) <= maxTokens && sc.length <= maxChars) {
          refined.push(sc);
        } else {
          strategy = "hard";
          for (const piece of this.hardSplit(sc, maxTokens)) refined.push(piece);
        }
      }
    }
    packed = refined;

    // 5. Add overlap between consecutive chunks of this section.
    if (overlapTokens > 0 && packed.length > 1) {
      const withOverlap: string[] = [packed[0]];
      for (let i = 1; i < packed.length; i++) {
        const tail = this.overlapTail(packed[i - 1], overlapTokens);
        withOverlap.push(tail ? `${tail}\n\n${packed[i]}` : packed[i]);
      }
      packed = withOverlap;
    }

    return packed.map((content) => ({ content, type: dominant, strategy }));
  }

  /**
   * Split content into semantic chunks for embedding / RAG retrieval.
   *
   * Accepts either HTML (Confluence storage / sanitised HTML) or markdown /
   * plain text. Detection is a simple `<` sniff — explicit and deterministic.
   */
  static chunkContent(
    input: string,
    documentTitle: string,
    options: ChunkOptions = {}
  ): Chunk[] {
    const maxTokens = options.maxTokens ?? TextChunkingService.DEFAULT_MAX_TOKENS;
    const maxChars = options.maxCharacters ?? TextChunkingService.DEFAULT_MAX_CHARS;
    const overlapTokens = options.overlapTokens ?? TextChunkingService.DEFAULT_OVERLAP_TOKENS;
    const minTokens = options.minTokens ?? TextChunkingService.DEFAULT_MIN_TOKENS;

    const blocks = /<[a-zA-Z][^>]*>/.test(input)
      ? this.parseHTML(input)
      : this.parseMarkdown(input);

    if (blocks.length === 0) return [];

    // ---- 1. Group blocks into sections by heading ---------------------------
    type Section = { headingPath: string[]; blocks: Block[] };
    const sections: Section[] = [];
    const headingStack: { level: number; text: string }[] = [];
    let current: Section = { headingPath: [], blocks: [] };
    sections.push(current);

    for (const block of blocks) {
      if (block.type === "heading") {
        // Pop stack to current heading level
        while (headingStack.length && headingStack[headingStack.length - 1].level >= (block.level || 1)) {
          headingStack.pop();
        }
        headingStack.push({ level: block.level || 1, text: block.content });

        // Start a new section that owns this heading
        current = {
          headingPath: headingStack.map((h) => h.text),
          blocks: [block],
        };
        sections.push(current);
      } else {
        current.blocks.push(block);
      }
    }

    // ---- 2. Chunk each section ---------------------------------------------
    const chunks: Chunk[] = [];
    let charPosition = 0;
    let chunkIndex = 0;

    for (const section of sections) {
      if (section.blocks.length === 0) continue;
      const headingPath = section.headingPath.join(" > ");
      const sectionChunks = this.chunkSection(
        section.blocks,
        headingPath,
        maxTokens,
        maxChars,
        overlapTokens
      );

      for (const sc of sectionChunks) {
        // Prepend the heading path + document title for retrieval context.
        const header = [documentTitle, headingPath].filter(Boolean).join(" > ");
        const content = header ? `[${header}]\n${sc.content}` : sc.content;

        chunks.push({
          index: chunkIndex++,
          content,
          type: sc.type,
          characterCount: content.length,
          tokenCount: this.estimateTokens(content),
          startPosition: charPosition,
          metadata: {
            language: "sv",
            confidence: 1.0,
            originalType: sc.type,
            headingPath: headingPath || undefined,
            splitStrategy: sc.strategy,
          },
        });
        charPosition += content.length;
      }
    }

    // ---- 3. Merge tiny trailing chunks into their predecessor --------------
    // Tiny fragments hurt retrieval more than they help.
    const merged: Chunk[] = [];
    for (const c of chunks) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        c.tokenCount < minTokens &&
        prev.tokenCount + c.tokenCount <= maxTokens &&
        prev.characterCount + c.characterCount <= maxChars &&
        prev.metadata.headingPath === c.metadata.headingPath
      ) {
        prev.content = `${prev.content}\n\n${c.content}`;
        prev.characterCount = prev.content.length;
        prev.tokenCount = this.estimateTokens(prev.content);
      } else {
        merged.push(c);
      }
    }
    // Re-index so chunk indexes are contiguous.
    merged.forEach((c, i) => (c.index = i));
    return merged;
  }

  /**
   * Create chunks with extra surrounding-context strings attached.
   * Useful for reranking / debugging; embedding should still use `content`.
   */
  static createContextualChunks(
    html: string,
    documentTitle: string,
    options: ChunkOptions = {}
  ): Array<Chunk & { context: string }> {
    const baseChunks = this.chunkContent(html, documentTitle, options);

    return baseChunks.map((chunk, index) => {
      const previousContent =
        index > 0 ? `Previous: ${baseChunks[index - 1].content.substring(0, 100)}...` : "";
      const nextContent =
        index < baseChunks.length - 1
          ? `Next: ${baseChunks[index + 1].content.substring(0, 100)}...`
          : "";

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
