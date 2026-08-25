# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Rainmaker — an autonomous ICP (Ideal Customer Profile) lead-generation agent for marketing agencies, built for the Orion Agents hackathon. A Next.js web app: the user describes their agency (or pastes its URL), the pipeline hunts the open web for matching companies, detects "why-now" buying signals, scores prospects, and produces ranked dossiers with a contact, pitch angle, and sendable draft email. `rainmaker-pitch.html` at the repo root is the standalone pitch page — it is a deliverable of its own and the source of the app's design tokens; don't modify it during app work.

## Hard constraint: no Anthropic

By explicit owner requirement, the product must contain **no Anthropic dependencies, SDKs, or models**. All LLM calls go through `@openrouter/sdk` with non-Anthropic models. `grep -ri anthropic src/ app/` must stay empty. (Claude Code building this repo is fine; shipping Anthropic code in it is not.)

## Commands

- `npm run dev` — dev server (localhost:3000)
- `npm run build` — production build; also the main verification gate
- `npx tsc --noEmit` — typecheck (use this, it's clean)
- `npm run lint` — **currently broken upstream**: typescript-eslint does not yet support the pinned TypeScript 7.x. Not a project bug; rely on `tsc` + `build` instead.
- No test runner is configured. Verification so far: typecheck, build, and disposable scratch tests written outside the repo.

Live runs require `.env` (gitignored, `chmod 600`, see `.env.example`): `OPENROUTER_API_KEY` (required), `FIRECRAWL_API_KEY` (web search, the default provider) and/or `TAVILY_API_KEY` (fallback, or primary via `SEARCH_PROVIDER=tavily`) — with neither, hunt skips every angle and scan falls back to homepage-only; `HUNTER_API_KEY` (optional — contact enrichment degrades gracefully without it); `SEARCH_PROVIDER`, `FIRECRAWL_MAX_RPM`, `FIRECRAWL_CONCURRENCY`, `FIRECRAWL_SCRAPE_RESULTS`, `OPENROUTER_MODEL_STRATEGIST` / `OPENROUTER_MODEL_OPERATOR` and the `RAINMAKER_*` caps (optional overrides of the defaults in `src/config.ts` / `src/lib/search/firecrawl.ts`).

## Free by construction

The whole product runs on free tiers: both default models are OpenRouter `:free` variants (`$0` in and out) and web search is Firecrawl's free plan (1,000 credits/month, 2 per search of ≤10 results, no card; capped at **10 search requests/minute and 2 concurrent**, which `search/firecrawl.ts` gates client-side) with Tavily's free Researcher plan (1,000 credits/month, 1 per search) as the fallback. A default run is ~24 searches = 48 Firecrawl credits. OpenRouter's `:free` variants are capped account-wide at **20 requests/minute and 50 requests/day** (1,000/day after a one-time $10 credit purchase), which is why `PIPELINE_DEFAULTS` is sized to ~23 LLM calls per run and `llm.ts` throttles. Don't reintroduce the OpenRouter `web` plugin — it bills per result.

## Architecture

Two layers: a pure server-side pipeline (`src/pipeline/`) and a Next.js App Router UI (`app/`) that invokes it through API routes.

### Pipeline

`src/pipeline/run.ts` → `runPipeline(input, opts)` orchestrates six sequential stages, each an independent module returning its value plus token usage:

```
icp → hunt → scan → qualify → enrich → brief
```

- **icp** — strategist model derives the ICP from an agency URL (page fetched) or description
- **hunt** — operator plans ~4 diverse search angles (hiring/funding/directory/news), then per angle: web search *first*, operator extracts companies from those results (concurrency-capped). A failed or empty search skips the angle with no LLM call — the daily budget is too small to spend on nothing. Dedupe by domain with name fallback; aggregator blocklist stops LinkedIn/TechCrunch/etc. being returned *as* leads
- **scan** — per candidate: two composed search queries (funding/leadership/hiring, and launch/rebrand/news) merged and deduped by URL, plus the company's fetched homepage → the six signal types defined in `types.ts`; every signal needs evidence + sourceUrl. Both searches failing is survivable: the scan proceeds homepage-only and the prompt says so, so `weak_digital_presence` stays assessable
- **qualify** — ONE batched strategist call scoring all candidates (batching forces ranking; isolated scoring yields "a pile of 80s"); explicit 40/30/30 fit/pain/timing rubric; disqualification is structural-only
- **enrich** — Hunter.io domain search (top-N leads only, one credit per query); `suggestTargetRole()` is the no-key/no-result fallback
- **brief** — batched strategist pitch angles + per-lead operator draft emails; `strongestSignal()` pre-computes the dated hook in code rather than trusting the model to pick it

**Model roles** (`src/config.ts`): `MODELS.strategist` (judgment: icp, qualify, angles — default `nvidia/nemotron-3-ultra-550b-a55b:free`; `z-ai/glm-5.2:free` was rejected after live probes returned provider errors) vs `MODELS.operator` (volume: hunt, scan, drafts — default `nvidia/nemotron-3-super-120b-a12b:free`). `PIPELINE_DEFAULTS` holds concurrency caps, candidate caps, topN, all `RAINMAKER_*`-overridable and all sized against the 50-calls/day ceiling (the per-run call math is a comment in `config.ts` — keep it accurate when you change a cap). `rateFor()` prices any `:free` id at 0, so `estCostUsd` is exactly $0 by default rather than "unpriced".

**LLM plumbing** (`src/lib/`): `llm.ts` — lazy OpenRouter client (`chat()` narrows the SDK's response union at runtime via `"choices" in response`; that quirk is real, keep it), plus the two free-tier defences every call passes through: a module-level sliding-window rate limiter (15 req/min, `OPENROUTER_MAX_RPM`, admission serialised through a promise chain so concurrent stages can't all grab the same slot) and a 429/5xx retry with 2s/8s backoff honouring `Retry-After` from `OpenRouterError.headers`. `structured.ts` — `structuredChat()` builds the JSON contract from the same zod schema that validates the reply (via `z.toJSONSchema`), retries once on parse/validation failure only (never on transport errors), and returns usage — including usage recovered from *failed* calls via `usageFromError()`. `rateLimit.ts` — that `createRateLimiter`, shared with the search providers. `search/` — `index.ts` is the dispatcher: `webSearch()` tries the configured providers in order (Firecrawl first unless `SEARCH_PROVIDER` says otherwise; naming an unconfigured provider is an error, not a silent swap), falls to the next provider on *error only* — never on empty results — and never throws, returning `{provider, results}` or `{error}`. `firecrawl.ts` — `POST https://api.firecrawl.dev/v2/search`, `Bearer fc-…`, `sources: [{type: "web"|"news"}]`, results under `data.web`/`data.news`, 2 credits per search; its own module-level 10-RPM limiter + 2-slot `pLimit` gate (`FIRECRAWL_MAX_RPM` / `FIRECRAWL_CONCURRENCY`) and a 429/5xx retry honouring `Retry-After`; `FIRECRAWL_SCRAPE_RESULTS=1` opts into per-result page markdown (+1 credit/result, 2,500-char cap). `tavily.ts` — `search_depth: "basic"` = 1 credit, 8s timeout. `ChatOptions.plugins` still exists but nothing passes it.

### Conventions the pipeline depends on (preserve when editing)

- **Prompts are exported consts colocated in their stage file** — that is the tuning surface; edit prompts there, not inline strings.
- **Model output is never trusted**: every stage cleans in code after the schema validates (`cleanSignals`, `cleanDraft`, `toCandidate` round-trips through zod, homepage citations only valid for weak-presence signals, placeholder-containing drafts rejected outright). Since the model is now handed its search results rather than fetching them, hunt and scan also enforce **citation membership** in code: a `sourceUrl` whose host doesn't match one of the supplied result URLs (`matchesAnyDomain` in `domain.ts`, subdomain-tolerant) was recalled, not read — hunt drops the company, `cleanSignals` drops the signal.
- **Empty results are legitimate** — prompts explicitly prefer zero results over invented ones; don't "fix" that.
- **Failure isolation**: a failed angle/scan/draft becomes a warning event + passthrough, never a thrown run. Only stage-level orchestration errors abort.
- **Two cost numbers**: `estCostUsd` (token math from rates in `config.ts`) and `reportedCostUsd` (OpenRouter's own figure, the authoritative one). On the default `:free` models both are legitimately $0; search spend is Firecrawl/Tavily credits, which appear in neither.

### Web app

- `app/page.tsx` — setup: hero with the isobar pressure field (`components/Isobars.tsx`, deterministic contours — the app's one decorative element) and the input "station" card (website / describe-it switch → sessionStorage handoff to `/run`; bare domains get `https://` prepended), last-hunt strip, six-stage strip
- `app/api/run/stream/route.ts` — POST returns an SSE `ReadableStream`; bridges `runPipeline`'s `onEvent` callback to `data:` frames (`type: "event" | "result" | "error"`), persists the finished run, and feeds `store.seenDomains` back in as hunt's `excludeDomains` (cross-run dedupe)
- `app/run/page.tsx` — consumes that stream with a hand-rolled fetch/reader parser (chunk-buffered on `\n\n`, StrictMode-guarded; feed ids are taken *before* the state updater so batched frames can't share a key); the six stages as a "front line", a readout strip, and the "wire" feed (signal events amber, warnings detected by wording and red-labelled)
- `app/leads/page.tsx` — ranked dossier sheets: barometer scale (`components/Gauge.tsx`), Fit /40 · Pain /30 · Timing /30 rows parsed from the `Fit:`/`Pain:`/`Timing:` prefixes qualify puts on `scoreReasons` (unprefixed reasons fall into an "Also" row, never dropped), signal tags → sourceUrl, reach/angle/first-email with copy, "Good lead / Not a fit" toggle via `/api/feedback`
- `src/lib/store.ts` — lowdb at `data/db.json` (gitignored), `globalThis`-cached singleton for dev hot-reload; keeps last 10 runs, feedback map, seenDomains
- Styling: no CSS framework; the palette in `app/globals.css` is ported from `rainmaker-pitch.html` and pinned (dark "signal console": bg `#0A0F16`, accent `#3BB4FF`, amber `#F5B33D`). Type is self-hosted by `next/font` in `app/layout.tsx`: Bricolage Grotesque (display — wordmark, one claim per page, big readouts; used with restraint), Schibsted Grotesk (body), Martian Mono (instrument labels; its `wdth` axis narrowed to 85–90 on the wire and tags). `components/stages.ts` is the single source of stage names/blurbs and signal names, shared by all three pages. UI work follows the brief in `.agents/skills/frontend-design/SKILL.md` — structure should encode real data (ranks, the rubric, the six signal types), not decorate

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
