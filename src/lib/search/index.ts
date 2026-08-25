/**
 * Web search — the pipeline's only search path, behind one provider-agnostic
 * contract.
 *
 * Two providers: Firecrawl (`firecrawl.ts`) and Tavily (`tavily.ts`), each
 * turned on by its API key. With both keys present, `SEARCH_PROVIDER` picks
 * which goes first (default: Firecrawl) and the other is a fallback for
 * *errors* only. An empty result set is an answer, not a failure — it is
 * never second-guessed by spending a second provider's credits.
 *
 * Contract: `webSearch()` NEVER throws. Callers get `{ provider, results }`
 * or `{ error }`, so a dead search degrades one angle or one scan rather than
 * failing the run. Results are model input, so nothing here is trusted: the
 * stages re-check every URL the model hands back against the URLs given here.
 */
import { firecrawlProvider } from "./firecrawl";
import { tavilyProvider } from "./tavily";
import type {
  ResolvedSearchOptions,
  SearchOutcome,
  SearchProvider,
  SearchResult,
  WebSearchOptions,
} from "./types";

export { isSearchSuccess } from "./types";
export type {
  SearchFailure,
  SearchOutcome,
  SearchProvider,
  SearchProviderId,
  SearchResult,
  SearchSuccess,
  WebSearchOptions,
} from "./types";

/** Both providers accept 20; more only costs credits and prompt room. */
const MAX_RESULTS_CAP = 20;
const DEFAULT_MAX_RESULTS = 8;

/** Preference order when both keys are set; SEARCH_PROVIDER moves one first. */
const PROVIDERS: readonly SearchProvider[] = [firecrawlProvider, tavilyProvider];

export type ProviderResolution =
  | { providers: SearchProvider[] }
  | { error: string };

/**
 * Which providers `webSearch()` will try, in order — or why none can run.
 * Naming an unconfigured provider in SEARCH_PROVIDER is an error rather than
 * a silent fallback, so a missing key shows up in the health check instead
 * of as a quietly different provider.
 */
export function resolveSearchProviders(): ProviderResolution {
  const configured = PROVIDERS.filter((provider) => provider.isConfigured());
  const preferred = (process.env.SEARCH_PROVIDER ?? "").trim().toLowerCase();

  if (preferred && preferred !== "auto") {
    const named = PROVIDERS.find((provider) => provider.id === preferred);
    if (!named) {
      return {
        error: `unknown SEARCH_PROVIDER "${preferred}" (use firecrawl or tavily)`,
      };
    }
    if (!named.isConfigured()) {
      return {
        error: `search disabled (SEARCH_PROVIDER=${named.id} but ${named.keyEnvVar} is not set)`,
      };
    }
    return {
      providers: [named, ...configured.filter((provider) => provider !== named)],
    };
  }

  if (configured.length === 0) {
    return {
      error: `search disabled (set ${PROVIDERS.map((p) => p.keyEnvVar).join(" or ")})`,
    };
  }
  return { providers: configured };
}

/**
 * Run one web search through the configured provider(s). Never throws.
 * Returns `{ error }` when no provider is configured, the query is empty, or
 * every provider in turn failed (errors joined, in the order tried).
 */
export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchOutcome> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { error: "empty search query" };

  const resolution = resolveSearchProviders();
  if ("error" in resolution) return { error: resolution.error };

  const resolved: ResolvedSearchOptions = {
    maxResults: Math.min(
      MAX_RESULTS_CAP,
      Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)),
    ),
    topic: opts.topic ?? "general",
  };

  const errors: string[] = [];
  for (const provider of resolution.providers) {
    const outcome = await provider.search(trimmedQuery, resolved);
    if ("results" in outcome) return outcome;
    errors.push(`${provider.id}: ${outcome.error}`);
  }
  return { error: errors.join("; ") };
}

/**
 * Render results as a numbered block for a prompt. Stages wrap this in their
 * own header/instructions — the wording stays in the stage file, the shape
 * stays here so hunt and scan present results identically.
 */
export function formatSearchResults(results: readonly SearchResult[]): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.title}`,
        `url: ${result.url}`,
        `content: ${result.content || "(no snippet)"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** Merge several result sets, keeping first-seen order and dropping dupes. */
export function dedupeResults(
  ...sets: readonly (readonly SearchResult[])[]
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const set of sets) {
    for (const result of set) {
      const key = result.url.trim().replace(/\/+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
    }
  }

  return merged;
}
