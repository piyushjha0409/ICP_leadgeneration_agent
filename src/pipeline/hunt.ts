import * as z from "zod";
import type { ChatMessages } from "@openrouter/sdk/models";
import { MODELS, PIPELINE_DEFAULTS } from "@/src/config";
import { mapWithLimit } from "@/src/lib/concurrency";
import {
  isHttpUrl,
  matchesAnyDomain,
  normalizeDomain,
  normalizeName,
} from "@/src/lib/domain";
import {
  formatSearchResults,
  isSearchSuccess,
  webSearch,
  type SearchResult,
} from "@/src/lib/search";
import { structuredChat, usageFromError } from "@/src/lib/structured";
import { emptyUsage, mergeUsage, type UsageTotals } from "@/src/lib/usage";
import { formatIcpBlock } from "@/src/pipeline/icp";
import { CandidateSchema, type Candidate, type Icp, type OnEvent } from "@/src/pipeline/types";

/**
 * Stage 2 — find real companies that match the ICP.
 *
 * Two steps: the operator invents diverse *search angles* (cheap, no web),
 * then, per angle, the search provider (Firecrawl, or Tavily) runs the query and the operator extracts companies
 * from those results (parallelised). Angles are deliberately heterogeneous —
 * hiring, funding, directories and news each surface a different slice of the
 * market, and querying one way repeatedly just returns the same twenty
 * companies.
 *
 * Search happens BEFORE the model, not inside it: if the search fails there is
 * nothing to extract from, so the angle is skipped without spending an LLM
 * call from the free tier's daily budget.
 */

export const AngleKindSchema = z.enum([
  "hiring",
  "funding",
  "directory",
  "news",
]);
export type AngleKind = z.infer<typeof AngleKindSchema>;

export const SearchAngleSchema = z.object({
  label: z.string(),
  kind: AngleKindSchema,
  /** The web query to run, phrased as someone would actually type it. */
  query: z.string(),
  rationale: z.string().optional(),
});
export type SearchAngle = z.infer<typeof SearchAngleSchema>;

const SearchAnglesSchema = z.object({ angles: z.array(SearchAngleSchema) });

const FoundCompanySchema = z.object({
  name: z.string(),
  domain: z.string(),
  why: z.string(),
  sourceUrl: z.string(),
});
const FoundCompaniesSchema = z.object({
  companies: z.array(FoundCompanySchema),
});

/**
 * Aggregators, media and social sites. Models routinely return the *source*
 * of a listing as though it were the company; these are never the lead.
 */
const NON_COMPANY_DOMAINS = new Set([
  "linkedin.com",
  "crunchbase.com",
  "pitchbook.com",
  "techcrunch.com",
  "forbes.com",
  "bloomberg.com",
  "reuters.com",
  "businesswire.com",
  "prnewswire.com",
  "globenewswire.com",
  "medium.com",
  "substack.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "reddit.com",
  "wikipedia.org",
  "glassdoor.com",
  "indeed.com",
  "greenhouse.io",
  "lever.co",
  "ycombinator.com",
  "producthunt.com",
  "g2.com",
  "capterra.com",
  "clutch.co",
  "angel.co",
  "wellfound.com",
  "builtin.com",
  "eu-startups.com",
  "sifted.eu",
  "axios.com",
  "cnbc.com",
  "wsj.com",
  "ft.com",
]);

/** Matches the domain itself and any subdomain of it (jobs.linkedin.com). */
function isNonCompanyDomain(domain: string): boolean {
  if (NON_COMPANY_DOMAINS.has(domain)) return true;
  for (const blocked of NON_COMPANY_DOMAINS) {
    if (domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

export type HuntOptions = {
  maxAngles?: number;
  perAngle?: number;
  maxCandidates?: number;
  concurrency?: number;
  /** Domains to exclude — used to keep the agency out of its own results. */
  excludeDomains?: string[];
  onEvent?: OnEvent;
};

export type HuntResult = {
  candidates: Candidate[];
  angles: SearchAngle[];
  usage: UsageTotals;
  /** Non-fatal per-angle failures, kept for the run report. */
  errors: string[];
};

export const HUNT_ANGLES_SYSTEM_PROMPT = `You are a B2B lead researcher planning how to find companies on the open web.

Your job right now is NOT to name companies. It is to design search angles — distinct queries that will each surface a *different* set of companies matching an Ideal Customer Profile.

A good angle set is diverse by construction. Cover these four kinds:
- hiring: companies advertising marketing roles (a marketing hire means budget exists and a gap is being filled).
- funding: companies that recently raised (new money almost always means new growth targets).
- directory: curated lists, industry directories, "top N" roundups, accelerator/portfolio pages, awards lists.
- news: launches, rebrands, market entries, expansion announcements.

Rules:
- Every query must be a realistic web search string — the words a researcher would actually type. No boolean operator soup, no site: chains longer than one clause.
- Bake the ICP's industry, size band and geography into the query wording.
- Prefer queries that return LISTS of companies over queries that return one company.
- Make angles genuinely different from each other. Two queries that would return the same page are one angle, not two.
- Include a recency word (e.g. the current year, "recently", "this quarter") on funding and news angles.`;

export function buildAnglesPrompt(icp: Icp, maxAngles: number): string {
  return [
    formatIcpBlock(icp),
    "",
    `Design exactly ${maxAngles} search angles for finding companies that match the ICP above.`,
    "",
    "Distribute them across the four kinds — at minimum one `hiring`, one `funding`, one `directory` and one `news` angle. Spend any remaining angles on whichever kinds are richest for this particular ICP.",
    "",
    "For each angle give:",
    "- label: a 2-5 word name for the angle.",
    "- kind: one of hiring | funding | directory | news.",
    "- query: the exact web search string to run.",
    "- rationale: one short line on why this angle surfaces ICP-matching companies.",
  ].join("\n");
}

export const HUNT_SEARCH_SYSTEM_PROMPT = `You are a B2B lead researcher extracting company names from web search results.

You cannot search. The SEARCH RESULTS block in the message below is everything you have — extract only from it, and report ONLY companies that genuinely appear in it.

Hard rules — these matter more than returning a full list:
- Every company you name must be a real, currently-operating company that appears in the provided SEARCH RESULTS. Never recall a company from memory, never guess, never pad the list.
- Every company must have a sourceUrl, and it MUST be copied exactly from the url line of one of the provided results. A sourceUrl that is not one of those URLs is treated as fabricated and the company is thrown away. If you cannot point to one of the provided results, drop the company.
- domain must be the company's own primary website domain (e.g. "acme.com"), never the domain of the article, job board, directory or news site you found it on.
- Never return the source itself as a company. LinkedIn, Crunchbase, TechCrunch, job boards, directories and news outlets are where you found the lead, not the lead.
- Never return marketing/advertising/creative/SEO/growth agencies, consultancies or freelancers. The buyer hires those; it is not one of those.
- Returning FEWER companies is correct and expected. If the results contain nothing credible, return an empty array. An empty array is a valid, useful answer. A fabricated company is a total failure.
- The "why" must cite something concrete from the source (a role being hired, a round size, a launch), not a restatement of the ICP.`;

export function buildAngleSearchPrompt(
  icp: Icp,
  angle: SearchAngle,
  perAngle: number,
  results: readonly SearchResult[],
): string {
  return [
    formatIcpBlock(icp),
    "",
    `SEARCH ANGLE: ${angle.label} (${angle.kind})`,
    `Query that was run: ${angle.query}`,
    "",
    "=== SEARCH RESULTS (retrieved just now — the only source you may use) ===",
    formatSearchResults(results),
    "=== END SEARCH RESULTS ===",
    "",
    `From these results, name up to ${perAngle} companies that match the ICP above. Fewer is fine. Zero is fine.`,
    "",
    "For each company report:",
    "- name: the company's real name.",
    "- domain: its own website domain, bare (no https://, no www., no path).",
    "- why: one line, citing the concrete fact from the result that makes it a match (the role it is hiring, the round it raised, the launch it announced).",
    "- sourceUrl: the url of the numbered result where you saw that fact, copied exactly.",
    "",
    "Before listing a company, check it against the ICP disqualifiers. If it trips one, leave it out.",
  ].join("\n");
}

/**
 * Normalize, validate and reject a raw model-reported company.
 * `sourcedDomains` are the domains of the results the model was actually
 * given: a citation outside that set was not read, it was remembered, so the
 * company goes in the bin rather than into the pipeline unsourced.
 */
function toCandidate(
  raw: z.infer<typeof FoundCompanySchema>,
  angle: SearchAngle,
  excluded: Set<string>,
  sourcedDomains: ReadonlySet<string>,
): Candidate | null {
  const domain = normalizeDomain(raw.domain);
  if (!domain) return null;
  if (isNonCompanyDomain(domain)) return null;
  if (excluded.has(domain)) return null;

  const name = raw.name.trim();
  if (!name) return null;

  const sourceUrl =
    isHttpUrl(raw.sourceUrl) && matchesAnyDomain(raw.sourceUrl, sourcedDomains)
      ? raw.sourceUrl.trim()
      : undefined;
  if (!sourceUrl) return null;

  const candidate: Candidate = {
    name,
    domain,
    source: sourceUrl,
    why: raw.why.trim() || undefined,
    discoveredVia: angle.label,
    sourceUrl,
  };

  // Round-trip through the schema so nothing unvalidated escapes the stage.
  const parsed = CandidateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Find ICP-matching companies across several web search angles.
 * Angles run in parallel (default 2 at a time); an angle whose search or
 * extraction fails is recorded and skipped rather than failing the hunt.
 */
export async function huntCandidates(
  icp: Icp,
  opts: HuntOptions = {},
): Promise<HuntResult> {
  const {
    maxAngles = PIPELINE_DEFAULTS.maxAngles,
    perAngle = PIPELINE_DEFAULTS.perAngle,
    maxCandidates = PIPELINE_DEFAULTS.maxCandidates,
    concurrency = PIPELINE_DEFAULTS.huntConcurrency,
    onEvent,
  } = opts;

  const usage = emptyUsage();
  const errors: string[] = [];

  const excluded = new Set(
    (opts.excludeDomains ?? [])
      .map((domain) => normalizeDomain(domain))
      .filter(Boolean),
  );

  onEvent?.({ stage: "hunt", message: `Planning ${maxAngles} search angles` });

  const anglesResult = await structuredChat(
    MODELS.operator,
    [
      { role: "system", content: HUNT_ANGLES_SYSTEM_PROMPT },
      { role: "user", content: buildAnglesPrompt(icp, maxAngles) },
    ],
    SearchAnglesSchema,
    { schemaName: "SearchAngles", temperature: 0.8, maxTokens: 1500 },
  );
  mergeUsage(usage, anglesResult.usage);

  const angles = anglesResult.value.angles.slice(0, maxAngles);
  onEvent?.({
    stage: "hunt",
    message: `Searching ${angles.length} angles: ${angles
      .map((angle) => angle.label)
      .join(", ")}`,
    data: angles,
  });

  const perAngleResults = await mapWithLimit(
    angles,
    concurrency,
    async (angle) => {
      onEvent?.({
        stage: "hunt",
        message: `Searching: ${angle.label}`,
        data: { angle },
      });

      // Search first. With no results there is nothing to extract, so the
      // angle is abandoned before it can spend an LLM call.
      const search = await webSearch(angle.query, {
        maxResults: Math.min(10, Math.max(5, perAngle * 2)),
      });

      if (!isSearchSuccess(search)) {
        errors.push(`${angle.label}: ${search.error}`);
        onEvent?.({
          stage: "hunt",
          message: `${angle.label} skipped: ${search.error}`,
          data: { angle: angle.label, error: search.error },
        });
        return { candidates: [] as Candidate[], usage: emptyUsage() };
      }

      if (search.results.length === 0) {
        errors.push(`${angle.label}: search returned no results`);
        onEvent?.({
          stage: "hunt",
          message: `${angle.label} skipped: search returned no results`,
          data: { angle: angle.label },
        });
        return { candidates: [] as Candidate[], usage: emptyUsage() };
      }

      // Only URLs the model was actually shown count as a citation.
      const sourcedDomains = new Set(
        search.results
          .map((result) => normalizeDomain(result.url))
          .filter(Boolean),
      );

      try {
        const result = await structuredChat(
          MODELS.operator,
          [
            { role: "system", content: HUNT_SEARCH_SYSTEM_PROMPT },
            {
              role: "user",
              content: buildAngleSearchPrompt(
                icp,
                angle,
                perAngle,
                search.results,
              ),
            },
          ] satisfies ChatMessages[],
          FoundCompaniesSchema,
          {
            schemaName: "FoundCompanies",
            temperature: 0.3,
            maxTokens: 2500,
          },
        );

        const found = result.value.companies
          .map((raw) => toCandidate(raw, angle, excluded, sourcedDomains))
          .filter((candidate): candidate is Candidate => candidate !== null);

        onEvent?.({
          stage: "hunt",
          message: `${angle.label}: ${found.length} usable ${
            found.length === 1 ? "company" : "companies"
          }`,
          data: { angle: angle.label, companies: found.map((c) => c.domain) },
        });

        return { candidates: found, usage: result.usage };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${angle.label}: ${message}`);
        onEvent?.({
          stage: "hunt",
          message: `${angle.label} failed: ${message}`,
          data: { angle: angle.label, error: message },
        });
        // Failed attempts still cost tokens; keep them in the total.
        return {
          candidates: [] as Candidate[],
          usage: usageFromError(err) ?? emptyUsage(),
        };
      }
    },
  );

  // Dedupe across angles: domain is authoritative, name is the safety net for
  // the same company reached via two different domains.
  const byDomain = new Map<string, Candidate>();
  const seenNames = new Set<string>();

  for (const { candidates, usage: angleUsage } of perAngleResults) {
    mergeUsage(usage, angleUsage);

    for (const candidate of candidates) {
      if (byDomain.has(candidate.domain)) continue;

      const nameKey = normalizeName(candidate.name);
      if (nameKey && seenNames.has(nameKey)) continue;

      byDomain.set(candidate.domain, candidate);
      if (nameKey) seenNames.add(nameKey);
    }
  }

  const candidates = [...byDomain.values()].slice(0, maxCandidates);

  onEvent?.({
    stage: "hunt",
    message: `Found ${candidates.length} unique candidates`,
    data: { candidates },
  });

  return { candidates, angles, usage, errors };
}
