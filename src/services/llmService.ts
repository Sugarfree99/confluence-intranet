import axios from "axios";
import * as winston from "winston";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});

/**
 * Thin wrapper around Gemini's generateContent API for chat-style
 * completions used by reranking and grounded answer generation.
 */
export class LLMService {
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || "";
    this.model = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Models to try in order when the primary model is overloaded (503).
   * gemini-2.5-flash is often the most rate-limited; flash-lite and 1.5
   * usually have spare capacity.
   */
  private fallbackModels(): string[] {
    const env = process.env.GEMINI_FALLBACK_MODELS;
    if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
    return ["gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash"];
  }

  private async callOnce(model: string, body: any): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    const response = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 60_000,
    });
    return (
      response.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || ""
    );
  }

  async generate(
    prompt: string,
    opts: { temperature?: number; responseMimeType?: string } = {}
  ): Promise<string> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not configured");

    const body: any = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
      },
    };
    if (opts.responseMimeType) {
      body.generationConfig.responseMimeType = opts.responseMimeType;
    }

    const modelsToTry = [this.model, ...this.fallbackModels().filter((m) => m !== this.model)];
    const maxAttemptsPerModel = 4;
    let lastError: any;

    for (const model of modelsToTry) {
      for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
        try {
          const text = await this.callOnce(model, body);
          if (!text) {
            logger.warn("LLM returned empty response", { model });
          }
          if (model !== this.model) {
            logger.info(`LLM succeeded via fallback model ${model}`);
          }
          return text;
        } catch (error: any) {
          lastError = error;
          const status = error?.response?.status;
          const transient = status === 429 || (status >= 500 && status < 600) || error.code === "ECONNABORTED";
          if (!transient) {
            // Hard error (4xx other than 429): no point retrying or falling back.
            throw error;
          }
          if (attempt === maxAttemptsPerModel) break; // try next model
          // Exponential backoff with jitter: 1s, 2s, 4s, 8s.
          const baseDelay = 1000 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 250);
          const delayMs = baseDelay + jitter;
          logger.warn(`LLM ${status || error.code} on ${model}, retrying in ${delayMs}ms`, {
            attempt,
            model,
          });
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      logger.warn(`LLM exhausted retries on ${model}, trying next fallback`);
    }
    throw lastError;
  }
}

export default new LLMService();
