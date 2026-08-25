/**
 * Firecrawl search provider (`POST https://api.firecrawl.dev/v2/search`).
 *
 * API shape verified against https://docs.firecrawl.dev/api-reference/endpoint/search
 * on 2026-08-25: `Authorization: Bearer fc-…`, JSON body `{ query, limit,
 * sources: [{ type: "web" | "news" }], timeout, scrapeOptions? }`; reply
 * `{ success, data: { web: [{ url, title, description, markdown? }], news: […] }, creditsUsed }`.
 *
 * Credits: 2 per search for up to 10 results (4 for 11–20), plus 1 per result
 * page when FIRECRAWL_SCRAPE_RESULTS is on. Free plan: 1,000 credits/month,
 * 10 search requests/minute, 2 concurrent requests; exceeding either is a 429.
 * The limiter and gate below keep a fanned-out run under both, and a 429 or
 * 5xx that slips through is retried with backoff (honouring Retry-After).
 */
import { envInt } from "../../config";
import { pLimit } from "../concurrency";
import { createRateLimiter, sleep } from "../rateLimit";
import {
  asRecord,
  describeFetchError,
  errorDetail,
  MAX_SNIPPET_CHARS,
  toSearchResult,
} from "./shared";
import type {
  ResolvedSearchOptions,
  SearchOutcome,
  SearchProvider,
  SearchResult,
} from "./types";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const KEY_ENV_VAR = "FIRECRAWL_API_KEY";

/** Search-only answers in a few seconds; scraping every result does not. */
const SEARCH_TIMEOUT_MS = 15_000;
const SCRAPE_TIMEOUT_MS = 45_000;

/** Scraped markdown is the whole page — worth more prompt room than a snippet. */
const MAX_SCRAPED_CHARS = 2_500;

/** Firecrawl rejects queries over 500 characters. */
const MAX_QUERY_CHARS = 500;

/** Backoff before retry 1 and retry 2; a Retry-After header overrides these. */
const RETRY_BACKOFF_MS = [2_000, 8_000] as const;
const MAX_RETRIES = RETRY_BACKOFF_MS.length;

/** However long the server asks us to wait, never park a scan for longer. */
const MAX_RETRY_AFTER_MS = 30_000;

export const FIRECRAWL_LIMITS = {
  /** Search requests admitted per minute. The free plan allows 10. */
  maxRpm: envInt("FIRECRAWL_MAX_RPM", 10),
  /** In-flight searches at once. The free plan allows 2. */
  concurrency: envInt("FIRECRAWL_CONCURRENCY", 2),
} as const;

/** Both gates are module-level: every stage shares the one account budget. */
const limiter = createRateLimiter(FIRECRAWL_LIMITS.maxRpm, 60_000);
const gate = pLimit(FIRECRAWL_LIMITS.concurrency);

/**
 * Opt-in: have Firecrawl scrape each result and return its markdown instead
 * of a snippet. Much richer evidence for scan, but +1 credit per result and
 * a much slower call — off by default so a run stays ~48 credits.
 */
export function scrapeResultsEnabled(): boolean {
  const raw = process.env.FIRECRAWL_SCRAPE_RESULTS?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
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

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** v2 nests results under `data.web` / `data.news`; tolerate a flat array too. */
function rawResults(body: unknown): unknown[] | null {
  const data = asRecord(body)?.data;
  if (Array.isArray(data)) return data;

  const buckets = asRecord(data);
  if (!buckets) return null;

  const collected: unknown[] = [];
  for (const key of ["web", "news"]) {
    const bucket = buckets[key];
    if (Array.isArray(bucket)) collected.push(...bucket);
  }
  return collected;
}

function toResult(raw: unknown, scraped: boolean): SearchResult | null {
  const item = asRecord(raw);
  if (!item) return null;

  const markdown =
    scraped && typeof item.markdown === "string" ? item.markdown.trim() : "";
  // Web results carry `description`; news results carry `snippet`.
  const snippet =
    typeof item.description === "string"
      ? item.description
      : typeof item.snippet === "string"
        ? item.snippet
        : "";

  return toSearchResult(
    { url: item.url, title: item.title, content: markdown || snippet },
    markdown ? MAX_SCRAPED_CHARS : MAX_SNIPPET_CHARS,
  );
}

async function firecrawlSearch(
  query: string,
  opts: ResolvedSearchOptions,
): Promise<SearchOutcome> {
  const apiKey = process.env[KEY_ENV_VAR]?.trim();
  if (!apiKey) return { error: `search disabled (no ${KEY_ENV_VAR})` };

  const scrape = scrapeResultsEnabled();
  const timeoutMs = scrape ? SCRAPE_TIMEOUT_MS : SEARCH_TIMEOUT_MS;

  const body = JSON.stringify({
    query: query.slice(0, MAX_QUERY_CHARS),
    limit: opts.maxResults,
    sources: [{ type: opts.topic === "news" ? "news" : "web" }],
    // Server-side budget just inside the client abort, so Firecrawl gives up
    // cleanly rather than us dropping the connection on it.
    timeout: timeoutMs - 1_000,
    ...(scrape
      ? {
          scrapeOptions: {
            formats: [{ type: "markdown" }],
            onlyMainContent: true,
          },
        }
      : {}),
  });

  return gate(async () => {
    for (let attempt = 0; ; attempt += 1) {
      // Each attempt is a real request, so each one takes its own RPM slot.
      await limiter.acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(FIRECRAWL_SEARCH_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
        });

        if (!response.ok) {
          if (attempt < MAX_RETRIES && isRetryable(response.status)) {
            const delay = retryAfterMs(response) ?? RETRY_BACKOFF_MS[attempt];
            // Drain so the connection can be reused, then back off.
            await response.arrayBuffer().catch(() => undefined);
            await sleep(delay);
            continue;
          }
          // 401 = bad key, 402 = out of credits, 408 = server-side timeout.
          return {
            error: `firecrawl http ${response.status}${await errorDetail(response)}`,
          };
        }

        const payload: unknown = await response.json();
        const record = asRecord(payload);
        if (record?.success === false) {
          const message =
            typeof record.error === "string" ? record.error : "request failed";
          return { error: `firecrawl: ${message}` };
        }

        const raw = rawResults(payload);
        if (!raw) return { error: "firecrawl response had no results array" };

        const results = raw
          .map((item) => toResult(item, scrape))
          .filter((result): result is SearchResult => result !== null);

        return { provider: "firecrawl", results };
      } catch (err) {
        return { error: describeFetchError(err, timeoutMs) };
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

export const firecrawlProvider: SearchProvider = {
  id: "firecrawl",
  keyEnvVar: KEY_ENV_VAR,
  isConfigured: () => Boolean(process.env[KEY_ENV_VAR]?.trim()),
  search: firecrawlSearch,
};
