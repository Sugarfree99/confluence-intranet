import { Pool } from "pg";
import { config } from "../config";
import EmbeddingService from "./embeddingService";
import LLMService from "./llmService";
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

interface Candidate {
  id: number;
  page_id: number;
  content: string;
  chunk_type: string;
  title: string;
  url: string;
  space_key: string;
  vectorScore?: number;
  bm25Score?: number;
  rrfScore?: number;
}

interface PageCandidate {
  page_id: number;
  title: string;
  url: string;
  space_key: string;
  content: string;
  score: number;
}

/**
 * Page-level RAG:
 *   1. Hybrid retrieval over chunks (vector cosine + BM25) with RRF fusion
 *      — used only to identify the most relevant *pages*.
 *   2. Load full page bodies from `pages.content`.
 *   3. Grounded answer generation against the full page text.
 */
export class QAService {
  private pool: Pool;
  private embeddingService: any;
  private llm: any;

  // Tunable retrieval parameters
  private readonly VECTOR_TOPK = 20;
  private readonly BM25_TOPK = 20;
  private readonly RRF_K = 60; // standard RRF constant
  private readonly FINAL_PAGES = 3; // top-N full pages sent to the LLM
  // Defensive cap so a runaway page can't blow the context window.
  private readonly MAX_PAGE_CHARS = 120_000;

  constructor() {
    this.pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
    });
    this.embeddingService = EmbeddingService;
    this.llm = LLMService;
  }

  // ---------- helpers ----------

  private cosine(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  private toTsQuery(question: string): string {
    return question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => `${w}:*`)
      .join(" | ");
  }

  // ---------- retrieval stages ----------

  private async vectorSearch(question: string): Promise<Candidate[]> {
    const qEmb = await this.embeddingService.generateEmbedding(question);
    if (!qEmb || qEmb.length === 0) return [];

    // Small corpus → fetch and compute cosine in app. Replace with pgvector
    // (`embedding <=> $1`) once the extension is enabled.
    const result = await this.pool.query(
      `SELECT c.id, c.page_id, c.content, c.chunk_type,
              p.title, p.url, p.space_key, e.embedding
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN pages p  ON p.id = c.page_id`
    );

    const scored: Candidate[] = [];
    for (const row of result.rows as any[]) {
      const emb: number[] = Array.isArray(row.embedding)
        ? row.embedding.map((v: any) => Number(v))
        : [];
      if (emb.length !== qEmb.length) continue;
      scored.push({
        id: row.id,
        page_id: row.page_id,
        content: row.content,
        chunk_type: row.chunk_type,
        title: row.title,
        url: row.url,
        space_key: row.space_key,
        vectorScore: this.cosine(qEmb, emb),
      });
    }
    scored.sort((a, b) => (b.vectorScore || 0) - (a.vectorScore || 0));
    return scored.slice(0, this.VECTOR_TOPK);
  }

  private async bm25Search(question: string): Promise<Candidate[]> {
    const tsQuery = this.toTsQuery(question);
    if (!tsQuery) return [];

    const result = await this.pool.query(
      `SELECT c.id, c.page_id, c.content, c.chunk_type,
              p.title, p.url, p.space_key,
              ts_rank_cd(to_tsvector('simple', c.content),
                         to_tsquery('simple', $1)) AS score
         FROM chunks c
         JOIN pages  p ON p.id = c.page_id
        WHERE to_tsvector('simple', c.content) @@ to_tsquery('simple', $1)
        ORDER BY score DESC
        LIMIT $2`,
      [tsQuery, this.BM25_TOPK]
    );

    return (result.rows as any[]).map((row) => ({
      id: row.id,
      page_id: row.page_id,
      content: row.content,
      chunk_type: row.chunk_type,
      title: row.title,
      url: row.url,
      space_key: row.space_key,
      bm25Score: Number(row.score),
    }));
  }

  /** Reciprocal Rank Fusion of two ranked lists. */
  private fuse(vector: Candidate[], bm25: Candidate[]): Candidate[] {
    const map = new Map<number, Candidate>();
    const merge = (list: Candidate[]) => {
      list.forEach((c, idx) => {
        const existing = map.get(c.id) || { ...c, rrfScore: 0 };
        existing.rrfScore = (existing.rrfScore || 0) + 1 / (this.RRF_K + idx + 1);
        if (c.vectorScore !== undefined) existing.vectorScore = c.vectorScore;
        if (c.bm25Score !== undefined) existing.bm25Score = c.bm25Score;
        existing.title = existing.title || c.title;
        existing.url = existing.url || c.url;
        existing.content = existing.content || c.content;
        existing.page_id = existing.page_id || c.page_id;
        existing.chunk_type = existing.chunk_type || c.chunk_type;
        existing.space_key = existing.space_key || c.space_key;
        map.set(c.id, existing);
      });
    };
    merge(vector);
    merge(bm25);
    return Array.from(map.values()).sort(
      (a, b) => (b.rrfScore || 0) - (a.rrfScore || 0)
    );
  }

  /** Hybrid + RRF pipeline. Returns final top-K candidates. */
  async searchRelevantChunks(question: string, limit?: number): Promise<Candidate[]> {
    const k = limit || 20;
    try {
      const [vec, bm] = await Promise.all([
        this.vectorSearch(question),
        this.bm25Search(question),
      ]);
      const fused = this.fuse(vec, bm);
      return fused.slice(0, k);
    } catch (error) {
      logger.error("Hybrid retrieval failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Aggregate chunk-level RRF scores per page, then load full page bodies
   * for the top-N pages.
   */
  async findRelevantPages(question: string, limit?: number): Promise<PageCandidate[]> {
    const n = limit || this.FINAL_PAGES;
    const chunks = await this.searchRelevantChunks(question, 50);
    if (chunks.length === 0) return [];

    // Aggregate by page_id using sum of RRF scores (favors pages with multiple
    // matching chunks while still respecting the strongest match).
    const pageScores = new Map<number, number>();
    for (const c of chunks) {
      const score = c.rrfScore ?? c.vectorScore ?? c.bm25Score ?? 0;
      pageScores.set(c.page_id, (pageScores.get(c.page_id) || 0) + score);
    }

    const topPageIds = Array.from(pageScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([pid]) => pid);

    if (topPageIds.length === 0) return [];

    const result = await this.pool.query(
      `SELECT id, title, url, space_key, content
         FROM pages
        WHERE id = ANY($1::int[])`,
      [topPageIds]
    );

    const byId = new Map<number, any>();
    for (const row of result.rows as any[]) byId.set(row.id, row);

    return topPageIds
      .map((pid) => {
        const row = byId.get(pid);
        if (!row) return null;
        const full: string = row.content || "";
        const content =
          full.length > this.MAX_PAGE_CHARS
            ? full.substring(0, this.MAX_PAGE_CHARS) + "\n…(avkortat)"
            : full;
        return {
          page_id: row.id,
          title: row.title,
          url: row.url,
          space_key: row.space_key,
          content,
          score: pageScores.get(pid) || 0,
        } as PageCandidate;
      })
      .filter((p): p is PageCandidate => p !== null);
  }

  // ---------- generation ----------

  private async generateAnswer(
    question: string,
    pages: PageCandidate[]
  ): Promise<{ answer: string; confidence: number }> {
    if (pages.length === 0) {
      return {
        answer: "Jag kunde inte hitta relevant information för din fråga.",
        confidence: 0,
      };
    }

    if (!this.llm.isConfigured()) {
      const context = pages.map((p) => p.content).join("\n\n");
      return {
        answer: `Baserat på dokumentationen: ${context.substring(0, 400)}...`,
        confidence: 0.4,
      };
    }

    const context = pages
      .map((p, i) => `[${i + 1}] ${p.title}\n${p.content}`)
      .join("\n\n---\n\n");

    const prompt = `Du är en assistent som svarar på frågor om företagets interna dokumentation. Använd ENBART informationen i kontexten nedan. Om svaret inte finns där, säg det rakt ut.

Svara på svenska, kort och konkret. Inkludera INTE några källhänvisningar, fotnoter eller referenser som [1], [2] osv. i ditt svar.

Fråga: ${question}

Kontext:
${context}

Svar:`;

    try {
      const answer = await this.llm.generate(prompt, { temperature: 0.2 });
      const topScore = pages[0]?.score ?? 0.5;
      // Defensive scrub: remove any leftover [1], [2], [1, 2] style citations.
      const clean = answer
        .replace(/\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
        .trim();
      return { answer: clean, confidence: Math.min(1, topScore) };
    } catch (error) {
      logger.error("Answer generation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        answer: "Ett fel inträffade när jag försökte besvara din fråga.",
        confidence: 0,
      };
    }
  }

  async answerQuestion(question: string): Promise<QAResult> {
    logger.info("Answering question", { question });
    const pages = await this.findRelevantPages(question);

    if (pages.length === 0) {
      return {
        answer:
          "Jag kunde inte hitta relevant information för din fråga. Prova en annan formulering.",
        sources: [],
        confidence: 0,
      };
    }

    const { answer, confidence } = await this.generateAnswer(question, pages);

    const sources = pages.map((p) => ({
      pageId: p.page_id,
      title: p.title,
      url: p.url,
      excerpt: p.content.substring(0, 200) + (p.content.length > 200 ? "..." : ""),
      relevance: p.score,
    }));

    return { answer, sources, confidence };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export default new QAService();
