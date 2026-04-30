import { Pool } from "pg";
import { config } from "../config";
import LLMService from "./llmService";
import { EmbeddingService } from "./embeddingService";
import * as winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

export interface QAResult {
  answer: string;
  sources: Array<{
    pageId: number;
    title: string;
    url?: string;
    excerpt: string;
    relevance: number;
  }>;
  confidence: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface PageCandidate {
  page_id: number;
  title: string;
  url: string;
  space_key: string;
  content: string;
  score: number;
}

interface ChunkCandidate {
  chunk_id: number;
  page_id: number;
  chunk_index: number;
  title: string;
  url: string;
  space_key: string;
  content: string;
  score: number;
  confluence_id: string;
}

/**
 * Chunk-level RAG:
 *   1. Embed the user question.
 *   2. Hybrid retrieval over the `chunks` table (FTS + vector cosine), fused
 *      with Reciprocal Rank Fusion. Falls back to page-level retrieval if
 *      no chunks/embeddings exist yet.
 *   3. Send the top-K chunks (with their page title/url for citation) to the
 *      LLM as grounded context.
 */
export class QAService {
  private pool: Pool;
  private llm: any;
  private embeddings: EmbeddingService;

  private readonly TOP_K_CHUNKS = 20;        // candidates fetched per branch
  private readonly FINAL_CHUNKS = 8;          // chunks sent to the LLM
  private readonly FINAL_PAGES = 3;           // legacy fallback when no chunks
  private readonly FTS_CANDIDATES = 20;
  private readonly VECTOR_CANDIDATES = 20;
  private readonly RRF_K = 60; // standard RRF constant
  // Defensive cap so a runaway page can't blow the context window.
  private readonly MAX_PAGE_CHARS = 120_000;
  private readonly STOPWORDS = new Set([
    "och",
    "att",
    "det",
    "som",
    "för",
    "med",
    "till",
    "från",
    "den",
    "detta",
    "har",
    "kan",
    "vi",
    "ni",
    "om",
  ]);

  constructor() {
    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
    });
    this.llm = LLMService;
    this.embeddings = new EmbeddingService();
  }

  private toTsQuery(question: string): string {
    return question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !this.STOPWORDS.has(w))
      .map((w) => `${w}:*`)
      .join(" | ");
  }

  private focusTerms(question: string): string[] {
    return question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !this.STOPWORDS.has(w));
  }

  private expandTerms(question: string): string[] {
    const base = this.focusTerms(question);

    const synonyms: Record<string, string[]> = {
      kontaktuppgifter: ["kontaktinformation", "kontaktinfo", "kontakt", "info"],
      kontaktinformation: ["kontaktuppgifter", "kontaktinfo", "kontakt", "info"],
      kontaktinfo: ["kontaktuppgifter", "kontaktinformation", "kontakt", "info"],
      telefonnummer: ["telefon", "tel", "nummer"],
      epost: ["mail", "e post", "epost"],
      email: ["mail", "epost"],
      löner: ["lön", "ersättning"],
    };

    const out = new Set<string>();
    for (const w of base) {
      out.add(w);
      for (const s of synonyms[w] || []) out.add(s);
    }

    return Array.from(out).filter((w) => w.length > 2);
  }

  // ---------- retrieval ----------

  private cosineSim(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Chunk-level hybrid retrieval. Embeds the question, runs vector + FTS
   * over the `chunks` / `embeddings` tables, fuses with Reciprocal Rank
   * Fusion, and returns the top-K chunks joined to their parent page.
   *
   * Returns [] if there are no chunks in the DB yet — caller can fall back
   * to page-level retrieval.
   */
  async searchRelevantChunks(question: string, limit?: number): Promise<ChunkCandidate[]> {
    const k = limit || this.FINAL_CHUNKS;

    // Quick check: are there any chunks at all? Saves work on a fresh DB.
    const countRow = await this.pool.query(`SELECT COUNT(*)::int AS n FROM chunks`);
    if (!countRow.rows[0] || countRow.rows[0].n === 0) return [];

    const expandedTerms = this.expandTerms(question);
    const tsQuery = this.toTsQuery(expandedTerms.join(" "));

    // --- 1. Embed the question --------------------------------------------
    let queryVec: number[] | null = null;
    try {
      queryVec = await this.embeddings.generateEmbedding(question);
    } catch (err) {
      logger.warn("Failed to embed question, using FTS only", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // --- 2. Vector branch (HNSW-indexed cosine via pgvector `<=>`) ------
    let vecRows: any[] = [];
    if (queryVec) {
      try {
        // pgvector accepts text form `[v1,v2,...]` and casts to halfvec.
        const qvec = "[" + queryVec.join(",") + "]";
        const r = await this.pool.query(
          `SELECT c.id        AS chunk_id,
                  c.page_id   AS page_id,
                  c.chunk_index,
                  c.content,
                  p.title,
                  p.url,
                  p.space_key,
                  p.confluence_id,
                  1 - (e.embedding <=> $1::halfvec) AS score
             FROM embeddings e
             JOIN chunks c ON c.id = e.chunk_id
             JOIN pages  p ON p.id = c.page_id
            WHERE e.embedding IS NOT NULL
            ORDER BY e.embedding <=> $1::halfvec
            LIMIT $2`,
          [qvec, this.TOP_K_CHUNKS]
        );
        vecRows = r.rows;
      } catch (err) {
        logger.warn("Chunk vector retrieval failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- 3. FTS branch ----------------------------------------------------
    let ftsRows: any[] = [];
    try {
      if (tsQuery) {
        const r = await this.pool.query(
          `SELECT c.id        AS chunk_id,
                  c.page_id   AS page_id,
                  c.chunk_index,
                  c.content,
                  p.title,
                  p.url,
                  p.space_key,
                  p.confluence_id,
                  ts_rank_cd(
                    to_tsvector('simple', coalesce(c.content, '')),
                    to_tsquery('simple', $1)
                  ) AS score
             FROM chunks c
             JOIN pages  p ON p.id = c.page_id
            WHERE to_tsvector('simple', coalesce(c.content, '')) @@ to_tsquery('simple', $1)
            ORDER BY score DESC
            LIMIT $2`,
          [tsQuery, this.TOP_K_CHUNKS]
        );
        ftsRows = r.rows;
      }
    } catch (err) {
      logger.warn("Chunk FTS retrieval failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (vecRows.length === 0 && ftsRows.length === 0) return [];

    // --- 4. Reciprocal Rank Fusion ----------------------------------------
    const byId = new Map<number, any>();
    const rrf = new Map<number, number>();

    const apply = (rows: any[], weight: number) => {
      rows.forEach((row, rank) => {
        const id = Number(row.chunk_id);
        byId.set(id, row);
        const contrib = weight * (1 / (this.RRF_K + rank + 1));
        rrf.set(id, (rrf.get(id) || 0) + contrib);
      });
    };
    apply(vecRows, 1.0);
    apply(ftsRows, 0.8);

    const fused = Array.from(rrf.entries())
      .map(([id, score]) => ({ row: byId.get(id), score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return fused.map(({ row, score }) => ({
      chunk_id: Number(row.chunk_id),
      page_id: Number(row.page_id),
      chunk_index: Number(row.chunk_index),
      title: row.title || "Untitled",
      url: row.url || "",
      space_key: row.space_key || "",
      content: row.content || "",
      score,
      confluence_id: row.confluence_id || "",
    }));
  }

  /**
   * Hybrid retrieval: combine FTS ranking and vector cosine similarity
   * via Reciprocal Rank Fusion. Falls back to FTS-only if no embeddings.
   */
  async searchRelevantPages(question: string, limit?: number): Promise<PageCandidate[]> {
    const n = limit || this.FINAL_PAGES;
    const focusTerms = this.focusTerms(question);
    const expandedTerms = this.expandTerms(question);
    const tsQuery = this.toTsQuery(expandedTerms.join(" "));

    try {
      // --- 1. FTS candidates --------------------------------------------------
      let ftsRows: any[] = [];
      if (tsQuery) {
        const likePatterns = expandedTerms
          .filter((t) => t.length > 3)
          .map((t) => `%${t}%`);
        const focusPatterns = focusTerms.map((t) => `%${t}%`);
        const r = await this.pool.query(
          `SELECT id AS page_id, title, url, space_key, content,
                  (
                    ts_rank_cd(
                      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                      setweight(to_tsvector('simple', coalesce(content, '')), 'B'),
                      to_tsquery('simple', $1)
                    )
                    + CASE WHEN coalesce(title, '') ILIKE ANY($3::text[]) THEN 0.50 ELSE 0 END
                    + CASE WHEN coalesce(content, '') ILIKE ANY($3::text[]) THEN 0.20 ELSE 0 END
                  ) AS score
             FROM pages
            WHERE (
              setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
              setweight(to_tsvector('simple', coalesce(content, '')), 'B')
            ) @@ to_tsquery('simple', $1)
            OR coalesce(title, '') ILIKE ANY($2::text[])
            OR coalesce(title, '') ILIKE ANY($3::text[])
            ORDER BY score DESC
            LIMIT $4`,
          [tsQuery, likePatterns.length ? likePatterns : [""], focusPatterns.length ? focusPatterns : [""], this.FTS_CANDIDATES]
        );
        ftsRows = r.rows;
      } else {
        const r = await this.pool.query(
          `SELECT id AS page_id, title, url, space_key, content, 0.1::float8 AS score
             FROM pages
            WHERE title ILIKE $1 OR content ILIKE $1
            ORDER BY id DESC
            LIMIT $2`,
          [`%${question}%`, this.FTS_CANDIDATES]
        );
        ftsRows = r.rows;
      }

      // --- 2. Vector candidates ----------------------------------------------
      let vecRows: any[] = [];
      try {
        const queryVec = await this.embeddings.generateEmbedding(question);
        const all = await this.pool.query(
          `SELECT id AS page_id, title, url, space_key, content, embedding
             FROM pages
            WHERE embedding IS NOT NULL`
        );
        const scored = all.rows
          .map((row: any) => ({
            ...row,
            score: this.cosineSim(queryVec, row.embedding as number[]),
          }))
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, this.VECTOR_CANDIDATES);
        vecRows = scored;
      } catch (err) {
        logger.warn("Vector retrieval failed, falling back to FTS only", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // --- 3. Fuse with Reciprocal Rank Fusion -------------------------------
      const byId = new Map<number, any>();
      const rrf = new Map<number, number>();

      const apply = (rows: any[], weight: number) => {
        rows.forEach((row, rank) => {
          const id = Number(row.page_id);
          byId.set(id, row);
          const contrib = weight * (1 / (this.RRF_K + rank + 1));
          rrf.set(id, (rrf.get(id) || 0) + contrib);
        });
      };
      apply(vecRows, 1.0); // semantic match
      apply(ftsRows, 0.8); // keyword match (slightly lower weight)

      const fused = Array.from(rrf.entries())
        .map(([id, score]) => ({ row: byId.get(id), score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, n);

      if (fused.length === 0) return [];

      return fused.map(({ row, score }) => {
        const full: string = row.content || "";
        const content =
          full.length > this.MAX_PAGE_CHARS
            ? full.substring(0, this.MAX_PAGE_CHARS) + "\n…(avkortat)"
            : full;
        return {
          page_id: Number(row.page_id),
          title: row.title || "Untitled",
          url: row.url || "",
          space_key: row.space_key || "",
          content,
          score,
        } as PageCandidate;
      });
    } catch (error) {
      logger.error("Page retrieval failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  // ---------- generation ----------

  /**
   * Build a slug for a document title that matches the `/doc/:slug` route.
   */
  private slugify(title: string): string {
    return (title || "")
      .toString()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 120);
  }

  /**
   * Format chat history as plain text for an LLM prompt.
   */
  private formatHistory(history: ChatTurn[]): string {
    if (!history || history.length === 0) return "";
    return history
      .filter((h) => h && (h.role === "user" || h.role === "assistant") && h.content)
      .map((h) => `${h.role === "user" ? "Användare" : "Assistent"}: ${h.content}`)
      .join("\n");
  }

  /**
   * If the user has previous turns, ask the LLM to rewrite the current
   * (potentially context-dependent) question into a standalone search
   * query. Falls back to the original question on any failure.
   */
  private async rewriteFollowUp(question: string, history: ChatTurn[]): Promise<string> {
    if (!history || history.length === 0) return question;
    if (!this.llm.isConfigured()) return question;

    const convo = this.formatHistory(history);
    const prompt = `Du får en kort konversation och en uppföljningsfråga. Skriv om uppföljningsfrågan så att den blir helt fristående och förståelig utan tidigare kontext. Behåll språket (svenska). Returnera ENBART den omskrivna frågan, inget annat.

Konversation:
${convo}

Uppföljningsfråga: ${question}

Fristående fråga:`;

    try {
      const rewritten = await this.llm.generate(prompt, { temperature: 0 });
      const cleaned = (rewritten || "").trim().replace(/^["']|["']$/g, "");
      if (!cleaned || cleaned.length > 400) return question;
      logger.info("Rewrote follow-up question", { original: question, rewritten: cleaned });
      return cleaned;
    } catch (err) {
      logger.warn("Follow-up rewrite failed; using original question", {
        error: err instanceof Error ? err.message : String(err),
      });
      return question;
    }
  }

  /**
   * Build the markdown source-link footer that gets appended to the answer.
   * One link per unique source page, max 3, in score order.
   *
   * Attachment sources (synthetic pages with confluence_id "att:<id>") link
   * directly to the raw download endpoint so the user gets the file in its
   * original format. Regular Confluence pages link to the in-app viewer.
   */
  private buildSourceFooter(
    sources: Array<{ title: string; url?: string; pageId: number; confluenceId?: string }>
  ): string {
    if (!sources || sources.length === 0) return "";
    const seen = new Set<number>();
    const lines: string[] = [];
    for (const s of sources) {
      if (seen.has(s.pageId)) continue;
      seen.add(s.pageId);
      const title = s.title || "Dokument";
      let href: string;
      if (s.confluenceId && s.confluenceId.startsWith("att:")) {
        const attId = s.confluenceId.substring(4);
        href = `/attachment/${encodeURIComponent(attId)}/raw?download=1`;
      } else {
        const slug = this.slugify(title);
        if (!slug) continue;
        href = `/doc/${slug}`;
      }
      lines.push(`- [${title}](${href})`);
      if (lines.length >= 3) break;
    }
    if (lines.length === 0) return "";
    return `\n\n**Källor:**\n${lines.join("\n")}`;
  }

  private async generateAnswerFromChunks(
    question: string,
    chunks: ChunkCandidate[],
    history: ChatTurn[] = []
  ): Promise<{ answer: string; confidence: number; grounded: boolean }> {
    if (chunks.length === 0) {
      return {
        answer: this.pick(this.NO_ANSWER_VARIANTS),
        confidence: 0,
        grounded: false,
      };
    }

    if (!this.llm.isConfigured()) {
      const context = chunks.map((c) => c.content).join("\n\n");
      return {
        answer: `Baserat på dokumentationen: ${context.substring(0, 400)}...`,
        confidence: 0.4,
        grounded: true,
      };
    }

    const context = chunks
      .map((c, i) => `[${i + 1}] ${c.title}\n${c.content}`)
      .join("\n\n---\n\n");

    const historyBlock = this.formatHistory(history);
    const historySection = historyBlock
      ? `Tidigare konversation (för att förstå följdfrågor):\n${historyBlock}\n\n`
      : "";

    const prompt = `Du är en hjälpsam, vänlig assistent för Nordrests medarbetare. Du svarar bara utifrån informationen nedan – på ett naturligt och mänskligt sätt, som en kollega som faktiskt har läst dokumenten.

Du MASTE returnera giltig JSON med exakt detta format:
{
  "grounded": boolean,   // true om du faktiskt kunde besvara frågan utifrån underlaget; false om svaret inte fanns där
  "answer": string       // själva svaret på svenska
}

Riktlinjer för fältet "answer":
- Svara på svenska, kort och konkret. Inga formella floskler.
- Variera gärna meningsbyggnad och inledningsord.
- Använd ALDRIG fraser som "i kontexten", "i tillhandahållna dokumenten", "enligt informationen", "baserat på materialet".
- Om underlaget inte täcker frågan: sätt grounded=false och skriv en kort, varm och varierad ursaktning (t.ex. "Det där hittar jag inget om – vet du var det skulle stå?", "Hmm, jag har inget om det", "Jag kommer inte åt det här just nu"). Hitta INTE på.
- Inkludera INTE källhänvisningar som [1], [2] i "answer".

${historySection}Fråga: ${question}

Underlag:
${context}`;

    try {
      const raw = await this.llm.generate(prompt, {
        temperature: 0.5,
        responseMimeType: "application/json",
      });
      const parsed = this.parseLLMJson(raw);
      const grounded = parsed.grounded === true;
      const answer = String(parsed.answer || "")
        .replace(/\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
        .trim();
      const topScore = chunks[0]?.score ?? 0.5;
      return {
        answer: answer || this.pick(this.NO_ANSWER_VARIANTS),
        confidence: grounded ? Math.min(1, topScore) : 0,
        grounded,
      };
    } catch (error) {
      logger.error("Answer generation (chunks) failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        answer: this.pick(this.ERROR_VARIANTS),
        confidence: 0,
        grounded: false,
      };
    }
  }

  private async generateAnswer(
    question: string,
    pages: PageCandidate[],
    history: ChatTurn[] = []
  ): Promise<{ answer: string; confidence: number; grounded: boolean }> {
    if (pages.length === 0) {
      return {
        answer: this.pick(this.NO_ANSWER_VARIANTS),
        confidence: 0,
        grounded: false,
      };
    }

    if (!this.llm.isConfigured()) {
      const context = pages.map((p) => p.content).join("\n\n");
      return {
        answer: `Baserat på dokumentationen: ${context.substring(0, 400)}...`,
        confidence: 0.4,
        grounded: true,
      };
    }

    const context = pages
      .map((p, i) => `[${i + 1}] ${p.title}\n${p.content}`)
      .join("\n\n---\n\n");

    const historyBlock = this.formatHistory(history);
    const historySection = historyBlock
      ? `Tidigare konversation (för att förstå följdfrågor):\n${historyBlock}\n\n`
      : "";

    const prompt = `Du är en hjälpsam, vänlig assistent för Nordrests medarbetare. Du svarar bara utifrån informationen nedan – på ett naturligt och mänskligt sätt, som en kollega som faktiskt har läst dokumenten.

Du MASTE returnera giltig JSON med exakt detta format:
{
  "grounded": boolean,   // true om du faktiskt kunde besvara frågan utifrån underlaget; false om svaret inte fanns där
  "answer": string       // själva svaret på svenska
}

Riktlinjer för fältet "answer":
- Svara på svenska, kort och konkret. Inga formella floskler.
- Variera gärna meningsbyggnad och inledningsord.
- Använd ALDRIG fraser som "i kontexten", "i tillhandahållna dokumenten", "enligt informationen", "baserat på materialet".
- Om underlaget inte täcker frågan: sätt grounded=false och skriv en kort, varm och varierad ursaktning. Hitta INTE på.
- Inkludera INTE källhänvisningar som [1], [2] i "answer".

${historySection}Fråga: ${question}

Underlag:
${context}`;

    try {
      const raw = await this.llm.generate(prompt, {
        temperature: 0.5,
        responseMimeType: "application/json",
      });
      const parsed = this.parseLLMJson(raw);
      const grounded = parsed.grounded === true;
      const answer = String(parsed.answer || "")
        .replace(/\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
        .trim();
      const topScore = pages[0]?.score ?? 0.5;
      return {
        answer: answer || this.pick(this.NO_ANSWER_VARIANTS),
        confidence: grounded ? Math.min(1, topScore) : 0,
        grounded,
      };
    } catch (error) {
      logger.error("Answer generation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        answer: this.pick(this.ERROR_VARIANTS),
        confidence: 0,
        grounded: false,
      };
    }
  }

  /**
   * Pools of fallback messages so the bot doesn't repeat the same line every
   * time it can't find an answer or hits an error. We pick uniformly at
   * random; for two consecutive misses the user gets a different phrasing.
   */
  private readonly NO_ANSWER_VARIANTS = [
    "Det där hittar jag inget om – vet du var det skulle stå?",
    "Hmm, jag hittar inget om det i våra dokument. Vill du formulera om frågan?",
    "Jag har inget på det just nu. Försök gärna med en annan formulering, eller berätta mer vad du letar efter.",
    "Tyvärr, det fanns inget om det här. Kanske finns det under ett annat namn?",
    "Jag kommer inte åt något om det. Vill du prova med andra ord eller smalna av frågan?",
    "Det där har jag inte stött på. Kan du beskriva det lite annorlunda så letar jag igen?",
  ];

  private readonly ERROR_VARIANTS = [
    "Hoppsan, något gick fel när jag skulle svara. Prova gärna igen om en stund.",
    "Det blev krångel min sida – kan du försöka igen om någon minut?",
    "Något strulade när jag letade. Vill du försöka igen?",
  ];

  private pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Parse a JSON object from the LLM's response. Tolerant of leading/trailing
   * whitespace and ```json ``` code fences. Returns {} on any failure so the
   * caller falls through to the default "not grounded" branch.
   */
  private parseLLMJson(raw: string): { grounded?: boolean; answer?: string } {
    if (!raw) return {};
    let s = raw.trim();
    // Strip a leading ```json or ``` fence if present.
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    // Pull out the outermost {...} in case the model wrapped extra text.
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      s = s.substring(first, last + 1);
    }
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") return obj;
    } catch {
      // fall through
    }
    return {};
  }

  async answerQuestion(question: string, history: ChatTurn[] = []): Promise<QAResult> {
    logger.info("Answering question", { question, historyTurns: history.length });

    // If there is prior conversation, rewrite the (possibly context-dependent)
    // question into a standalone search query before retrieval. The original
    // question + full history are still passed to the LLM for generation.
    const searchQuery = await this.rewriteFollowUp(question, history);

    // ---- 1. Try chunk-level retrieval first --------------------------------
    const chunks = await this.searchRelevantChunks(searchQuery);

    if (chunks.length > 0) {
      const { answer, confidence, grounded } = await this.generateAnswerFromChunks(
        question,
        chunks,
        history
      );

      // The LLM tells us via the structured `grounded` flag whether it
      // actually used the chunks. If not, drop sources entirely so we
      // don't show a "Källor:" footer for documents that didn't help.
      if (!grounded) {
        return { answer, sources: [], confidence: 0 };
      }

      // De-duplicate sources by page_id, keeping the best-scoring chunk.
      const sourceMap = new Map<number, ChunkCandidate>();
      for (const c of chunks) {
        const prev = sourceMap.get(c.page_id);
        if (!prev || c.score > prev.score) sourceMap.set(c.page_id, c);
      }
      const ranked = Array.from(sourceMap.values()).sort(
        (a, b) => b.score - a.score
      );
      const sources = ranked.map((c) => ({
        pageId: c.page_id,
        title: c.title,
        url: c.url,
        confluenceId: c.confluence_id,
        excerpt: c.content.substring(0, 200) + (c.content.length > 200 ? "..." : ""),
        relevance: c.score,
      }));

      const footer = this.buildSourceFooter(sources);
      return { answer: answer + footer, sources, confidence };
    }

    // ---- 2. Fallback: page-level retrieval (legacy / pre-chunked DBs) ------
    logger.info("No chunks matched, falling back to page-level retrieval");
    const pages = await this.searchRelevantPages(searchQuery);

    if (pages.length === 0) {
      return {
        answer: this.pick(this.NO_ANSWER_VARIANTS),
        sources: [],
        confidence: 0,
      };
    }

    const { answer, confidence, grounded } = await this.generateAnswer(
      question,
      pages,
      history
    );

    if (!grounded) {
      return { answer, sources: [], confidence: 0 };
    }

    const sources = pages.map((p) => ({
      pageId: p.page_id,
      title: p.title,
      url: p.url,
      excerpt: p.content.substring(0, 200) + (p.content.length > 200 ? "..." : ""),
      relevance: p.score,
    }));

    const footer = this.buildSourceFooter(sources);
    return { answer: answer + footer, sources, confidence };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new QAService();
