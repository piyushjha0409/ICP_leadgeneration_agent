/**
 * Model IDs used by the pipeline, routed through OpenRouter
 * (https://openrouter.ai/api/v1). Override via env vars without touching code.
 *
 * Rainmaker runs at zero marginal cost: both defaults are `:free` variants,
 * and web search is Firecrawl's (or Tavily's) free tier (`src/lib/search/`)
 * rather than OpenRouter's pay-per-result `web` plugin.
 *
 * Defaults (verified against the live OpenRouter catalog on 2026-08-23):
 * - strategist -> nvidia/nemotron-3-ultra-550b-a55b:free: the largest free
 *   reasoning model (1M context). Chosen over z-ai/glm-5.2:free after live
 *   probing on 2026-08-23: glm-5.2:free consistently returned
 *   "Provider returned error" while ultra answered with clean JSON. Our
 *   structured outputs are prompt-contract + zod (structured.ts), so the
 *   missing native structured-outputs flag on ultra is irrelevant.
 * - operator   -> nvidia/nemotron-3-super-120b-a12b:free: 120B hybrid MoE
 *   activating only 12B params, so it is fast enough for the volume stages
 *   (hunt, scan, drafts); 262k context, structured outputs supported.
 *
 * Free variants are throttled account-wide (~20 requests/minute, 50/day with
 * no credit balance). `src/lib/llm.ts` throttles and retries accordingly, and
 * PIPELINE_DEFAULTS below is sized to fit inside the daily allowance.
 */
export const MODELS = {
  strategist:
    process.env.OPENROUTER_MODEL_STRATEGIST ??
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  operator:
    process.env.OPENROUTER_MODEL_OPERATOR ??
    "nvidia/nemotron-3-super-120b-a12b:free",
} as const;

/** USD price per 1M tokens for a model. */
export type ModelRate = {
  inputPerMTok: number;
  outputPerMTok: number;
};

/** What every `:free` variant costs, by definition. */
const FREE_RATE: ModelRate = { inputPerMTok: 0, outputPerMTok: 0 };

/**
 * Published OpenRouter list prices, keyed by canonical model id. Used to
 * estimate run cost from token counts. The defaults are free, so a default
 * run estimates exactly $0 — the paid entries are kept for the upgrade path
 * (set OPENROUTER_MODEL_* to one of these and the estimate stays honest).
 */
const RATE_TABLE: Record<string, ModelRate> = {
  "nvidia/nemotron-3-ultra-550b-a55b:free": FREE_RATE,
  "z-ai/glm-5.2:free": FREE_RATE,
  "nvidia/nemotron-3-super-120b-a12b:free": FREE_RATE,
  "openai/gpt-5.6-sol": { inputPerMTok: 2.5, outputPerMTok: 15 },
  "openai/gpt-5.6-luna": { inputPerMTok: 0.2, outputPerMTok: 1.2 },
};

export const MODEL_RATES: Record<string, ModelRate> = { ...RATE_TABLE };

/**
 * Rate lookup. Any `:free` model id is 0/0 whether or not it is in the table,
 * so swapping in another free variant still estimates exactly zero rather
 * than "unknown". A paid model with no published rate returns undefined —
 * `estimateCostUsd` then contributes 0 for it, which makes the estimate a
 * floor, never a claim that the run was free.
 */
export function rateFor(model: string): ModelRate | undefined {
  const known = MODEL_RATES[model];
  if (known) return known;
  return model.endsWith(":free") ? FREE_RATE : undefined;
}

/**
 * Positive-integer env override, falling back when unset or nonsense. Shared
 * with the search providers for their own `*_MAX_RPM` / `*_CONCURRENCY` knobs.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Tuning knobs for the pipeline. Overridable per-run by the caller, and at
 * boot via the RAINMAKER_* env vars.
 *
 * Sized for the OpenRouter free tier's 50-requests-per-day ceiling. One run
 * with these defaults costs:
 *
 *   1 icp + 1 hunt-angles + 4 hunt + 10 scan + 1 qualify + 1 pitch-angles
 *   + 5 drafts  ≈  23 LLM calls  ≤  50/day
 *
 * (plus 4 + 2×10 = 24 web searches: 48 Firecrawl credits at 2 per search, or
 * 24 Tavily credits at 1 — either against 1,000 free per month). That leaves
 * headroom for `structuredChat`'s one retry on malformed JSON, and room for
 * two runs in a day. Raising these knobs spends the day's budget.
 */
export const PIPELINE_DEFAULTS = {
  /** How many distinct search angles the hunt stage generates. */
  maxAngles: envInt("RAINMAKER_MAX_ANGLES", 4),
  /** How many companies to ask for per angle. */
  perAngle: envInt("RAINMAKER_PER_ANGLE", 5),
  /** Hard cap on candidates carried into the (expensive) scan stage. */
  maxCandidates: envInt("RAINMAKER_MAX_CANDIDATES", 10),
  /** Parallel angles during hunt (each = 1 search + 1 LLM call). */
  huntConcurrency: envInt("RAINMAKER_HUNT_CONCURRENCY", 2),
  /** Parallel candidates during scan (each = 2 searches + 1 LLM call). */
  scanConcurrency: envInt("RAINMAKER_SCAN_CONCURRENCY", 2),
  /**
   * How many of the top-scored leads get a contact lookup and an outreach
   * brief. Enrichment costs Hunter credits and briefing costs tokens, so both
   * are spent only on the leads someone will actually call.
   */
  topN: envInt("RAINMAKER_TOP_N", 5),
  /** Parallel Hunter.io lookups during enrich (no LLM calls). */
  enrichConcurrency: envInt("RAINMAKER_ENRICH_CONCURRENCY", 3),
  /** Parallel draft-message calls during brief. */
  briefConcurrency: envInt("RAINMAKER_BRIEF_CONCURRENCY", 2),
  /** Characters of the agency's own site fed to the ICP stage. */
  agencyPageChars: envInt("RAINMAKER_AGENCY_PAGE_CHARS", 8000),
  /** Characters of a candidate's homepage fed to the scan stage. */
  candidatePageChars: envInt("RAINMAKER_CANDIDATE_PAGE_CHARS", 3000),
} as const;

/**
 * Environment variables. All are optional at load time — callers are
 * responsible for surfacing a helpful error when a value is actually needed
 * but missing.
 */
export const env = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  /**
   * Web search keys. Firecrawl is the default provider; Tavily is the
   * fallback (or the primary, via SEARCH_PROVIDER). With neither set, hunt
   * and scan run without web evidence.
   */
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  /** `firecrawl` | `tavily` | `auto` (default) — see `src/lib/search/index.ts`. */
  SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
  HUNTER_API_KEY: process.env.HUNTER_API_KEY,
};
