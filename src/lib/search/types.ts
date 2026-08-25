export type SearchProviderId = "firecrawl" | "tavily";

export type SearchResult = {
  title: string;
  url: string;
  /**
   * Relevant extract from the page — the provider's snippet, or scraped page
   * text when the provider returns it. Always trimmed to a prompt-safe size.
   */
  content: string;
};

export type SearchSuccess = {
  /** Which provider actually answered (matters when one fell back to another). */
  provider: SearchProviderId;
  results: SearchResult[];
};
export type SearchFailure = { error: string };
export type SearchOutcome = SearchSuccess | SearchFailure;

export function isSearchSuccess(
  outcome: SearchOutcome,
): outcome is SearchSuccess {
  return "results" in outcome;
}

export type WebSearchOptions = {
  /** Results to request (1–20). Default 8. */
  maxResults?: number;
  /** `general` unless a stage wants fresh press. */
  topic?: "general" | "news";
};

/** `WebSearchOptions` after `webSearch()` has applied defaults and clamps. */
export type ResolvedSearchOptions = {
  maxResults: number;
  topic: "general" | "news";
};

export type SearchProvider = {
  id: SearchProviderId;
  /** The env var that turns this provider on. */
  keyEnvVar: string;
  isConfigured: () => boolean;
  /** Same contract as `webSearch()`: resolves to results or an error, never throws. */
  search: (query: string, opts: ResolvedSearchOptions) => Promise<SearchOutcome>;
};
