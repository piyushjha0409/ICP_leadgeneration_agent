import { OpenRouter } from "@openrouter/sdk";
import type {
  ChatMessages,
  ChatRequestPlugin,
  ChatResult,
  ChatUsage,
} from "@openrouter/sdk/models";
import { createRateLimiter, sleep } from "@/src/lib/rateLimit";

export { createRateLimiter, type RateLimiter } from "@/src/lib/rateLimit";

/**
 * Lazily-constructed OpenRouter client. `apiKey` is read from
 * OPENROUTER_API_KEY at call time (not at import time), so importing this
 * module never throws even if the key isn't set yet — that matters for
 * `next build`, which imports route handlers without env vars present.
 */
let client: OpenRouter | undefined;

export function getClient(): OpenRouter {
  if (!client) {
    client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  }
  return client;
}

/* -------------------------------------------------------------------------
 * Free-tier throttling
 *
 * OpenRouter's `:free` model variants share one account-wide budget — about
 * 20 requests/minute (and 50/day without a credit balance). The pipeline fans
 * out deliberately (hunt angles, scans, drafts), so left alone it would burst
 * straight into 429s. Two defences, both here so no stage has to know:
 *
 *   1. a client-side sliding-window limiter that admits at most
 *      RATE_LIMIT.maxRequests calls per RATE_LIMIT.windowMs, kept just under
 *      the published ceiling so a request is delayed rather than rejected;
 *   2. a 429/5xx-aware retry with exponential backoff inside `chat()`.
 * ---------------------------------------------------------------------- */

export const RATE_LIMIT = {
  /** Requests admitted per window. Under OpenRouter's ~20 RPM free ceiling. */
  maxRequests: envInt("OPENROUTER_MAX_RPM", 15),
  windowMs: 60_000,
} as const;

/** Backoff before retry 1 and retry 2. A Retry-After header overrides these. */
const RETRY_BACKOFF_MS = [2_000, 8_000] as const;
const MAX_RETRIES = RETRY_BACKOFF_MS.length;

/** However long a server asks us to wait, never park a run for longer. */
const MAX_RETRY_AFTER_MS = 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The single gate every `chat()` call passes through. */
const limiter = createRateLimiter(RATE_LIMIT.maxRequests, RATE_LIMIT.windowMs);

/** HTTP status off an SDK error (`OpenRouterError.statusCode`) or a raw one. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown } | null;
  };
  for (const value of [
    candidate.statusCode,
    candidate.status,
    candidate.response?.status,
  ]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * `Retry-After` off the error, when the SDK exposes response headers
 * (`OpenRouterError.headers` is a `Headers`). Accepts both the seconds and
 * the HTTP-date form.
 */
function retryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const headers = (err as { headers?: unknown }).headers;

  let raw: string | null | undefined;
  if (headers && typeof (headers as Headers).get === "function") {
    raw = (headers as Headers).get("retry-after");
  } else if (headers && typeof headers === "object") {
    const bag = headers as Record<string, unknown>;
    const value = bag["retry-after"] ?? bag["Retry-After"];
    if (typeof value === "string") raw = value;
  }
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

/** Delay before the next attempt, or null when the error is not retryable. */
function retryDelayMs(err: unknown, attempt: number): number | null {
  const status = statusOf(err);
  const retryable = status === 429 || (status !== undefined && status >= 500 && status < 600);
  if (!retryable) return null;
  return retryAfterMs(err) ?? RETRY_BACKOFF_MS[attempt] ?? null;
}

export type ChatOptions = {
  maxTokens?: number;
  temperature?: number;
  /**
   * OpenRouter plugins. Kept for completeness; the pipeline no longer passes
   * any — web search moved to its own providers (`src/lib/search/`) because
   * the `web` plugin bills per result.
   */
  plugins?: ChatRequestPlugin[];
};

export type ChatOutcome = {
  text: string;
  usage: ChatUsage | undefined;
  raw: ChatResult;
};

/**
 * Send a chat completion via OpenRouter and return the assistant's text
 * content plus usage. Every call waits for a rate-limit slot first, and a
 * 429 or 5xx is retried twice with backoff before it is allowed to throw.
 */
export async function chat(
  model: string,
  messages: ChatMessages[],
  opts: ChatOptions = {},
): Promise<ChatOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    // Each attempt is a real request, so each one takes its own slot.
    await limiter.acquire();

    try {
      return await sendOnce(model, messages, opts);
    } catch (err) {
      const delay = attempt < MAX_RETRIES ? retryDelayMs(err, attempt) : null;
      if (delay === null) throw err;
      await sleep(delay);
    }
  }
}

async function sendOnce(
  model: string,
  messages: ChatMessages[],
  opts: ChatOptions,
): Promise<ChatOutcome> {
  const response = await getClient().chat.send({
    chatRequest: {
      model,
      messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      plugins: opts.plugins,
      stream: false,
    },
  });

  // The SDK's return type is a union with the streaming response shape even
  // when `stream: false` is passed; narrow it at runtime.
  if (!("choices" in response)) {
    throw new Error("Expected a non-streaming chat completion response.");
  }
  const result: ChatResult = response;

  const message = result.choices[0]?.message;
  const content = message?.content;

  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }

  return { text, usage: result.usage, raw: result };
}
