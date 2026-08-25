import * as z from "zod";
import { env } from "@/src/config";
import { normalizeDomain } from "@/src/lib/domain";
import type { Icp } from "@/src/pipeline/types";

/**
 * Contact enrichment via Hunter.io's Domain Search.
 *
 * Verified against https://hunter.io/api-documentation on 2026-08-21:
 *   GET https://api.hunter.io/v2/domain-search
 *       ?domain=<host>&limit=<n>&api_key=<key>
 *   -> { data: { domain, organization, pattern, emails: [{ value, type,
 *        confidence, first_name, last_name, position, seniority, department,
 *        decision_maker, verification: { status } }] }, meta: { results } }
 *   Status codes: 400 invalid params · 401 no valid API key · 403 rate limit
 *   reached · 429 usage (plan) limit reached · 451 personal data withheld.
 *   Rate limit: 15 req/s, 500 req/min. Free plans reject limit + offset > 10.
 *
 * This module is the only place in the pipeline that talks to a non-LLM
 * third-party API, and it is on the critical path of a demo, so it never
 * throws: every failure comes back as a `note` and the lead is briefed
 * without a named contact.
 */

export const HUNTER_DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search";

const TIMEOUT_MS = 8_000;

/**
 * A Domain Search costs one credit whatever the limit, and free plans reject
 * `limit + offset > 10` — so ask for the free-tier ceiling in one call and do
 * the ranking here rather than paginating.
 */
export const HUNTER_MAX_RESULTS = 10;

/**
 * Hunter's confidence is a guess at whether the address is real. Below this
 * we keep the person and drop the address: a bounced first touch costs more
 * than an email we had to look up by hand.
 */
export const MIN_EMAIL_CONFIDENCE = 70;

export type EnrichedContact = {
  name: string;
  role: string;
  email?: string;
};

export type EnrichResult = {
  contact?: EnrichedContact;
  /** Why there is no contact, or what was dropped from the one there is. */
  note?: string;
};

// --- Who to ask for when Hunter has nobody -------------------------------

/**
 * Static "who to reach" by company-size band. A 12-person company has no VP
 * of Marketing to write to, and a 900-person one will not route a cold email
 * to its founder.
 */
export const TARGET_ROLE_BY_BAND = {
  small: "Founder/CEO",
  mid: "Head of Marketing",
  large: "VP Marketing",
} as const;

export type CompanySizeBand = keyof typeof TARGET_ROLE_BY_BAND;

function largestNumber(text: string): number | undefined {
  let largest: number | undefined;
  for (const match of text.matchAll(/(\d[\d,]*)\s*(k\b|\+)?/gi)) {
    const base = Number.parseInt((match[1] ?? "").replace(/,/g, ""), 10);
    if (!Number.isFinite(base)) continue;
    const value = match[2]?.toLowerCase() === "k" ? base * 1000 : base;
    if (largest === undefined || value > largest) largest = value;
  }
  return largest;
}

/**
 * Read a headcount band out of the ICP's free-text `companySize`. Prefers a
 * number that is actually next to the word "employees" so a revenue or
 * funding figure in the same string cannot inflate the band.
 */
export function companySizeBand(icp: Icp): CompanySizeBand {
  const size = icp.companySize ?? "";

  const headcount =
    /(\d[\d,]*\s*(?:k\b|\+)?(?:\s*(?:to|-|–|—)\s*\d[\d,]*\s*(?:k\b|\+)?)?)[^.;]{0,20}?(?:employees|headcount|staff|people|fte)/i.exec(
      size,
    );

  const count = largestNumber(headcount?.[1] ?? size);

  if (count !== undefined) {
    if (count >= 500) return "large";
    if (count >= 60) return "mid";
    return "small";
  }

  // No numbers at all — fall back to the language of the band.
  const text = `${size} ${icp.industry ?? ""}`.toLowerCase();
  if (/enterprise|fortune|multinational|series\s*[d-z]\b|public company/.test(text)) {
    return "large";
  }
  if (/pre-?seed|bootstrapped|solo|founder-led|micro|1-\d\b/.test(text)) {
    return "small";
  }
  return "mid";
}

/**
 * The role to address when enrichment found nobody. Pure — no network, no
 * model — so the brief stage can always name a target.
 */
export function suggestTargetRole(icp: Icp): string {
  return TARGET_ROLE_BY_BAND[companySizeBand(icp)];
}

// --- Ranking Hunter's results --------------------------------------------

/** Hunter's own `seniority` vocabulary: junior | senior | executive. */
const SENIORITY_WEIGHT: Record<string, number> = {
  executive: 30,
  senior: 18,
  junior: 2,
};

/** Hunter's own `department` vocabulary, weighted for who buys marketing. */
const DEPARTMENT_WEIGHT: Record<string, number> = {
  marketing: 30,
  communication: 22,
  executive: 20,
  management: 12,
  sales: 10,
  product: 6,
  design: 4,
};

/** Titles Hunter classifies loosely; the words themselves are the signal. */
const TITLE_WEIGHTS: Array<[RegExp, number]> = [
  [/\bcmo\b|\bchief marketing\b|\bchief growth\b/i, 28],
  [/\b(vp|vice president|head|director)\b[^,]{0,30}\b(marketing|growth|demand|brand|revenue)\b/i, 24],
  [/\b(founder|co-?founder|ceo|owner|managing director)\b/i, 20],
  [/\b(growth|demand gen(?:eration)?|performance marketing|lifecycle)\b/i, 14],
  [/\bmarketing\b|\bbrand\b|\bcontent\b/i, 8],
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HunterEmailSchema = z.object({
  value: z.string().nullish(),
  type: z.string().nullish(),
  confidence: z.number().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  position: z.string().nullish(),
  seniority: z.string().nullish(),
  department: z.string().nullish(),
  decision_maker: z.boolean().nullish(),
  verification: z.object({ status: z.string().nullish() }).nullish(),
});
type HunterEmail = z.infer<typeof HunterEmailSchema>;

const HunterResponseSchema = z.object({
  data: z
    .object({
      organization: z.string().nullish(),
      emails: z.array(HunterEmailSchema).nullish(),
    })
    .nullish(),
  errors: z
    .array(z.object({ id: z.string().nullish(), details: z.string().nullish() }))
    .nullish(),
});

function fullName(person: HunterEmail): string {
  return [person.first_name, person.last_name]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Rank one person for "who should receive a cold pitch about marketing".
 * The band tilts it: at a 15-person company the founder IS the marketing
 * department; at a 600-person one the founder never sees the email.
 */
export function scorePerson(person: HunterEmail, band: CompanySizeBand): number {
  const position = person.position?.trim() ?? "";
  let score = 0;

  score += SENIORITY_WEIGHT[person.seniority?.toLowerCase() ?? ""] ?? 0;
  score += DEPARTMENT_WEIGHT[person.department?.toLowerCase() ?? ""] ?? 0;

  for (const [pattern, weight] of TITLE_WEIGHTS) {
    if (pattern.test(position)) {
      score += weight;
      break;
    }
  }

  if (person.decision_maker) score += 10;
  // A generic inbox (info@, hello@) is never a person worth naming.
  if (person.type?.toLowerCase() === "generic") score -= 30;
  // Confidence is a tie-breaker, not a qualification.
  score += Math.round(Math.max(0, Math.min(100, person.confidence ?? 0)) / 10);

  const foundersFirst = band === "small";
  if (foundersFirst && /\b(founder|co-?founder|ceo|owner)\b/i.test(position)) {
    score += 14;
  }
  if (!foundersFirst && person.department?.toLowerCase() === "marketing") {
    score += 10;
  }
  // A leader with no marketing remit at a big company is not the buyer.
  if (band === "large" && /\b(founder|co-?founder|ceo|owner)\b/i.test(position)) {
    score -= 8;
  }

  return score;
}

/** Keep the address only when Hunter is confident it is a real, personal one. */
function usableEmail(person: HunterEmail): string | undefined {
  const value = person.value?.trim().toLowerCase() ?? "";
  if (!EMAIL_RE.test(value)) return undefined;
  if (person.type?.toLowerCase() === "generic") return undefined;
  if ((person.confidence ?? 0) < MIN_EMAIL_CONFIDENCE) return undefined;
  if (person.verification?.status?.toLowerCase() === "invalid") return undefined;
  return value;
}

/** Documented Hunter status codes, as a note a human can act on. */
function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return "hunter rejected the request (400)";
    case 401:
      return "enrichment skipped (HUNTER_API_KEY was rejected)";
    case 402:
    case 429:
      return "enrichment skipped (Hunter usage limit reached)";
    case 403:
      return "enrichment skipped (Hunter rate limit reached)";
    case 451:
      return "no contact found (Hunter withholds this company's people)";
    default:
      return `hunter request failed (http ${status})`;
  }
}

/**
 * Look up the best person to pitch at `domain`.
 *
 * Never throws and never blocks the run for more than 8s: a missing key,
 * a quota wall, a timeout and an empty result set all come back as a `note`.
 */
export async function enrichContact(
  domain: string,
  icp: Icp,
): Promise<EnrichResult> {
  const apiKey = env.HUNTER_API_KEY?.trim();
  if (!apiKey) return { note: "enrichment skipped (no HUNTER_API_KEY)" };

  const host = normalizeDomain(domain);
  if (!host) return { note: `enrichment skipped (unusable domain "${domain}")` };

  const url = new URL(HUNTER_DOMAIN_SEARCH_URL);
  url.searchParams.set("domain", host);
  url.searchParams.set("limit", String(HUNTER_MAX_RESULTS));
  url.searchParams.set("api_key", apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!response.ok) return { note: describeStatus(response.status) };

    const parsed = HunterResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { note: "hunter returned an unrecognised payload" };
    }

    const band = companySizeBand(icp);
    // A contact we cannot name is not a contact — role inboxes are dropped here.
    const people = (parsed.data.data?.emails ?? []).filter((person) =>
      Boolean(fullName(person)),
    );

    if (people.length === 0) return { contact: undefined, note: "no contact found" };

    const best = people.reduce((winner, person) =>
      scorePerson(person, band) > scorePerson(winner, band) ? person : winner,
    );

    const email = usableEmail(best);

    return {
      contact: {
        name: fullName(best),
        // Hunter often has the person but not the title.
        role: best.position?.trim() || suggestTargetRole(icp),
        ...(email ? { email } : {}),
      },
      ...(!email && best.value?.trim()
        ? {
            note: `email withheld (Hunter confidence ${
              best.confidence ?? 0
            }, needs ${MIN_EMAIL_CONFIDENCE})`,
          }
        : {}),
    };
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      note: aborted
        ? `hunter timed out after ${TIMEOUT_MS}ms`
        : `hunter lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
