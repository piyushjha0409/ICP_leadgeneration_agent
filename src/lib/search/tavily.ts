/**
 * Tavily Search API provider.
 *
 * Free "Researcher" plan: 1,000 credits a month, 1 credit per `basic` search,
 * no credit card. Kept as the fallback (or the primary, via SEARCH_PROVIDER)
 * next to Firecrawl.
 *
 * API shape verified against https://docs.tavily.com/documentation/api-reference/endpoint/search
 * on 2026-08-23: POST https://api.tavily.com/search, `Authorization: Bearer
 * tvly-…`, JSON body, `results[]` of `{ title, url, content, score }`.
 */
import {
  asRecord,
  describeFetchError,
  errorDetail,
  toSearchResult,
} from "./shared";
import type {
  ResolvedSearchOptions,
  SearchOutcome,
  SearchProvider,
  SearchResult,
} from "./types";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const KEY_ENV_VAR = "TAVILY_API_KEY";

/** Search sits in front of an LLM call; a slow one blocks a pipeline slot. */
const TIMEOUT_MS = 8_000;

/** One Tavily search. Costs exactly 1 credit (search_depth `basic`). */
async function tavilySearch(
  query: string,
  opts: ResolvedSearchOptions,
): Promise<SearchOutcome> {
  const apiKey = process.env[KEY_ENV_VAR]?.trim();
  if (!apiKey) return { error: `search disabled (no ${KEY_ENV_VAR})` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        // Bearer header, not an `api_key` body field — the body form is the
        // deprecated shape and 401s on newer keys.
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        query,
        // `basic` is 1 credit; `advanced` is 2 and we cannot afford it monthly.
        search_depth: "basic",
        topic: opts.topic,
        max_results: opts.maxResults,
      }),
    });

    if (!response.ok) {
      // 429 = rate limited, 432 = plan credits exhausted, 433 = PAYG overage.
      return {
        error: `tavily http ${response.status}${await errorDetail(response)}`,
      };
    }

    const body: unknown = await response.json();
    const rawResults = asRecord(body)?.results;
    if (!Array.isArray(rawResults)) {
      return { error: "tavily response had no results array" };
    }

    const results = rawResults
      .map((raw) => {
        const item = asRecord(raw);
        return item
          ? toSearchResult({
              url: item.url,
              title: item.title,
              content: item.content,
            })
          : null;
      })
      .filter((result): result is SearchResult => result !== null);

    return { provider: "tavily", results };
  } catch (err) {
    return { error: describeFetchError(err, TIMEOUT_MS) };
  } finally {
    clearTimeout(timer);
  }
}

export const tavilyProvider: SearchProvider = {
  id: "tavily",
  keyEnvVar: KEY_ENV_VAR,
  isConfigured: () => Boolean(process.env[KEY_ENV_VAR]?.trim()),
  search: tavilySearch,
};
