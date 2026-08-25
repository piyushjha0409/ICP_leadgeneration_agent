import * as z from "zod";
import { MODELS, PIPELINE_DEFAULTS } from "@/src/config";
import { mapWithLimit } from "@/src/lib/concurrency";
import {
  homepageUrl,
  isHttpUrl,
  matchesAnyDomain,
  normalizeDomain,
} from "@/src/lib/domain";
import { fetchPageText, isPageFetchSuccess } from "@/src/lib/fetchPage";
import {
  dedupeResults,
  formatSearchResults,
  isSearchSuccess,
  webSearch,
  type SearchResult,
} from "@/src/lib/search";
import { structuredChat, usageFromError } from "@/src/lib/structured";
import { emptyUsage, mergeUsage, type UsageTotals } from "@/src/lib/usage";
import { formatIcpBlock } from "@/src/pipeline/icp";
import {
  SignalSchema,
  type Candidate,
  type Icp,
  type OnEvent,
  type ScannedCandidate,
  type Signal,
} from "@/src/pipeline/types";

/**
 * Stage 3 — find the "why now" for each candidate.
 *
 * Fit alone does not create a deal; timing does. This stage looks for six
 * specific triggers, each of which has to come back with a citable source.
 * The candidate's real homepage text is fetched and passed in so that
 * "weak digital presence" is a judgement about a page we actually read
 * rather than a guess.
 *
 * The evidence the model may use is assembled here, before the call: two
 * web searches (one money/people-shaped, one launch/news-shaped) plus the
 * homepage. If both searches fail the scan still runs — the homepage alone is
 * enough to judge weak_digital_presence, and the prompt says so.
 */

const ScanSignalsSchema = z.object({ signals: z.array(SignalSchema) });

export type ScanOptions = {
  onEvent?: OnEvent;
  /** Characters of homepage text to pass to the model. */
  pageChars?: number;
};

export type ScanResult = {
  scanned: ScannedCandidate;
  usage: UsageTotals;
};

export type ScanAllOptions = ScanOptions & {
  concurrency?: number;
};

export type ScanAllResult = {
  scanned: ScannedCandidate[];
  usage: UsageTotals;
  errors: string[];
};

/** One line per signal type, so the model tags consistently across runs. */
export const SIGNAL_DEFINITIONS = `The six signal types, and what each one means:
- funding: the company publicly announced raising capital (any stage, including debt or a large grant). Recent rounds matter most.
- new_marketing_leader: the company appointed a new CMO, VP/Head/Director of Marketing, or growth lead, recently enough that they are still shaping their plan.
- hiring_marketing: the company currently has open marketing, growth, demand-gen, content, SEO, lifecycle or paid-media roles advertised.
- weak_digital_presence: the company's own public web presence is thin, stale or broken — no blog or a blog abandoned long ago, no case studies, unclear positioning, template/placeholder site, no pricing page, dormant social accounts.
- losing_to_competitors: public evidence that rivals are outpacing them — competitors outranking them on their own category terms, comparison/"alternatives" pages framing them as the weaker option, lost review-site share, press or analyst commentary on losing ground.
- launch_or_rebrand: the company recently launched a product, entered a new market or segment, or rebranded — all of which create an immediate need for demand.`;

export const SCAN_SYSTEM_PROMPT = `You are a B2B sales researcher establishing whether a specific company has a reason to buy marketing services RIGHT NOW.

You cannot search. Your evidence is exactly what the message below provides: a SEARCH RESULTS block (retrieved just now, sometimes empty) and the company's homepage text. Report only what those support.

${SIGNAL_DEFINITIONS}

Hard rules:
- Every signal needs evidence AND a sourceUrl. The evidence is the concrete fact — the round size, the job title advertised, the person appointed, the launch — in one sentence, quoting or closely paraphrasing the source. "They seem to need marketing" is not evidence.
- The sourceUrl must be copied exactly from the url line of one of the provided search results — the only exception is weak_digital_presence, which cites the company's own homepage URL. A sourceUrl that appears nowhere in the provided results is treated as fabricated and the signal is thrown away. Do not cite a homepage for a funding round or a search-results page for anything.
- Do not infer a signal from another signal. Recent funding does not imply hiring; hiring does not imply a new leader. Each signal stands on its own source.
- If you find nothing credible, return an empty signals array. That is a correct and useful answer — many companies genuinely have no trigger right now. A fabricated or padded signal is far worse than an empty list, because a human will act on it.
- Only tag a company with the same signal type once, using the strongest evidence.
- Do not report signals about a different company with a similar name. If you cannot confirm the results are about this exact company at this exact domain, return nothing.
- Include a date (YYYY-MM-DD or YYYY-MM) whenever the source states one. Prefer events from the last 12 months; ignore anything older than about 2 years unless it is still the company's current state.`;

/**
 * The two queries every candidate gets, composed in code so the wording is a
 * constant rather than something a model improvises per company. One aims at
 * money and people (funding, marketing leadership, open roles), the other at
 * motion (launches, rebrands, press).
 */
export function buildScanQueries(candidate: Candidate): [string, string] {
  const name = `"${candidate.name}"`;
  return [
    `${name} funding OR raised OR "Series" OR CMO OR "VP Marketing" OR hiring marketing`,
    `${name} ${candidate.domain} launch OR rebrand OR "new product" news`,
  ];
}

export function buildScanPrompt(
  candidate: Candidate,
  icp: Icp,
  homepage: { url: string; text?: string; error?: string },
  search: { results: readonly SearchResult[]; unavailable?: boolean },
): string {
  const sections: string[] = [
    formatIcpBlock(icp),
    "",
    "=== COMPANY TO INVESTIGATE ===",
    `Name: ${candidate.name}`,
    `Domain: ${candidate.domain}`,
    `Website: ${homepage.url}`,
  ];

  if (candidate.why) {
    sections.push(`Why it was shortlisted: ${candidate.why}`);
  }
  if (candidate.sourceUrl) {
    sections.push(`Where it was found: ${candidate.sourceUrl}`);
  }
  sections.push("=== END COMPANY ===", "");

  if (search.results.length > 0) {
    sections.push(
      "=== SEARCH RESULTS (retrieved just now — the only source you may cite) ===",
      formatSearchResults(search.results),
      "=== END SEARCH RESULTS ===",
      "",
    );
  } else {
    sections.push(
      search.unavailable
        ? "=== NO SEARCH RESULTS AVAILABLE: web search failed for this company ==="
        : "=== NO SEARCH RESULTS: the searches for this company returned nothing ===",
      "",
      "You therefore have no outside evidence. funding, new_marketing_leader, hiring_marketing, losing_to_competitors and launch_or_rebrand are all unreportable — do not guess at them from memory. weak_digital_presence is still assessable from the homepage text below, if it is present.",
      "",
    );
  }

  if (homepage.text) {
    sections.push(
      "=== HOMEPAGE TEXT (fetched just now, verbatim) ===",
      `"""${homepage.text}"""`,
      "=== END HOMEPAGE TEXT ===",
      "",
      `Judge weak_digital_presence from this text specifically: does it show clear positioning, recent content, case studies, proof? If the presence is genuinely weak, cite ${homepage.url} as the sourceUrl and quote what is missing or stale. If the site is strong, do not report the signal at all.`,
    );
  } else {
    sections.push(
      `=== HOMEPAGE COULD NOT BE READ: ${homepage.error ?? "unknown error"} ===`,
      "",
      "Note: an HTTP 403 or similar means the site blocked an automated request — that is NOT evidence of a weak site, so do not report weak_digital_presence on that basis. A DNS failure, a 5xx error, or a site that is genuinely a placeholder may be evidence, but confirm it in the search results above before reporting it.",
    );
  }

  sections.push(
    "",
    `Using only the material above, report every one of the six signal types you can evidence for ${candidate.name} (${candidate.domain}). Report only what you can cite. Return an empty array if there is nothing.`,
  );

  return sections.join("\n");
}

/**
 * Drop signals that fail the evidence contract rather than trusting them.
 * `sourcedDomains` are the domains of the search results the model was given;
 * a citation from anywhere else was recalled, not read.
 */
function cleanSignals(
  raw: Signal[],
  homepage: string,
  sourcedDomains: ReadonlySet<string>,
): Signal[] {
  const seen = new Set<string>();
  const cleaned: Signal[] = [];
  const sameAsHomepage = (url: string) =>
    Boolean(homepage) &&
    url.replace(/\/+$/, "") === homepage.replace(/\/+$/, "");

  for (const signal of raw) {
    const evidence = signal.evidence?.trim() ?? "";
    // Anything this short is a label, not evidence.
    if (evidence.length < 12) continue;

    const sourceUrl = signal.sourceUrl?.trim() ?? "";
    if (!isHttpUrl(sourceUrl)) continue;

    // One signal per type — keep the first, which is the model's strongest.
    if (seen.has(signal.type)) continue;

    if (signal.type === "weak_digital_presence") {
      // The homepage we fetched, or a page from the results, and nothing else.
      if (
        !sameAsHomepage(sourceUrl) &&
        !matchesAnyDomain(sourceUrl, sourcedDomains)
      ) {
        continue;
      }
    } else {
      // A homepage citation only makes sense for a presence judgement.
      if (sameAsHomepage(sourceUrl)) continue;
      // Everything else must come from a page we actually handed the model.
      if (!matchesAnyDomain(sourceUrl, sourcedDomains)) continue;
    }

    seen.add(signal.type);
    cleaned.push({
      type: signal.type,
      evidence,
      sourceUrl,
      ...(signal.date?.trim() ? { date: signal.date.trim() } : {}),
    });
  }

  return cleaned;
}

/**
 * Investigate one candidate for why-now signals.
 * Never throws — a failed scan comes back as a candidate with no signals and
 * a `scanError`, so one dead company cannot sink the run.
 */
export async function scanCandidate(
  candidate: Candidate,
  icp: Icp,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const { onEvent } = opts;
  const url = homepageUrl(candidate.domain) || candidate.domain;

  onEvent?.({
    stage: "scan",
    message: `Scanning ${candidate.name}`,
    data: { domain: candidate.domain },
  });

  // Homepage and both searches are independent — fetch them together.
  const [queryA, queryB] = buildScanQueries(candidate);
  const [page, searchA, searchB] = await Promise.all([
    fetchPageText(url, opts.pageChars ?? PIPELINE_DEFAULTS.candidatePageChars),
    webSearch(queryA, { maxResults: 6 }),
    webSearch(queryB, { maxResults: 6 }),
  ]);

  const homepageExcerpt = isPageFetchSuccess(page) ? page.text : undefined;
  const homepageError = isPageFetchSuccess(page) ? undefined : page.error;

  const results = dedupeResults(
    isSearchSuccess(searchA) ? searchA.results : [],
    isSearchSuccess(searchB) ? searchB.results : [],
  );
  // Both searches down means the homepage is the only evidence there is; the
  // scan still runs, because weak_digital_presence is judged from it.
  const searchUnavailable = !isSearchSuccess(searchA) && !isSearchSuccess(searchB);

  if (searchUnavailable) {
    const reason = !isSearchSuccess(searchA) ? searchA.error : "search failed";
    onEvent?.({
      stage: "scan",
      message: `${candidate.name}: no search results (${reason}) — judging from the homepage only`,
      data: { domain: candidate.domain, error: reason },
    });
  }

  const sourcedDomains = new Set(
    results.map((result) => normalizeDomain(result.url)).filter(Boolean),
  );

  try {
    const result = await structuredChat(
      MODELS.operator,
      [
        { role: "system", content: SCAN_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildScanPrompt(
            candidate,
            icp,
            {
              url,
              text: homepageExcerpt,
              error: homepageError,
            },
            { results, unavailable: searchUnavailable },
          ),
        },
      ],
      ScanSignalsSchema,
      {
        schemaName: "Signals",
        temperature: 0.2,
        maxTokens: 2500,
      },
    );

    const signals = cleanSignals(result.value.signals, url, sourcedDomains);

    onEvent?.({
      stage: "scan",
      message: `${candidate.name}: ${signals.length} signal${
        signals.length === 1 ? "" : "s"
      }${signals.length ? ` (${signals.map((s) => s.type).join(", ")})` : ""}`,
      data: { domain: candidate.domain, signals },
    });

    return {
      scanned: {
        company: candidate,
        signals,
        homepageExcerpt,
        homepageError,
      },
      usage: result.usage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent?.({
      stage: "scan",
      message: `${candidate.name} scan failed: ${message}`,
      data: { domain: candidate.domain, error: message },
    });

    return {
      scanned: {
        company: candidate,
        signals: [],
        homepageExcerpt,
        homepageError,
        scanError: message,
      },
      // Failed attempts still cost tokens; keep them in the total.
      usage: usageFromError(err) ?? emptyUsage(),
    };
  }
}

/** Scan every candidate, two at a time by default. */
export async function scanAll(
  candidates: readonly Candidate[],
  icp: Icp,
  opts: ScanAllOptions = {},
): Promise<ScanAllResult> {
  const { concurrency = PIPELINE_DEFAULTS.scanConcurrency, ...scanOpts } = opts;
  const usage = emptyUsage();
  const errors: string[] = [];

  opts.onEvent?.({
    stage: "scan",
    message: `Scanning ${candidates.length} companies for why-now signals`,
  });

  const results = await mapWithLimit(candidates, concurrency, (candidate) =>
    scanCandidate(candidate, icp, scanOpts),
  );

  const scanned = results.map((result) => {
    mergeUsage(usage, result.usage);
    if (result.scanned.scanError) {
      errors.push(`${result.scanned.company.name}: ${result.scanned.scanError}`);
    }
    return result.scanned;
  });

  const withSignals = scanned.filter((item) => item.signals.length > 0).length;
  opts.onEvent?.({
    stage: "scan",
    message: `${withSignals} of ${scanned.length} companies have at least one signal`,
    data: {
      totalSignals: scanned.reduce((sum, item) => sum + item.signals.length, 0),
    },
  });

  return { scanned, usage, errors };
}
