import * as z from "zod";
import { MODELS } from "@/src/config";
import { normalizeDomain } from "@/src/lib/domain";
import { structuredChat } from "@/src/lib/structured";
import { emptyUsage, type UsageTotals } from "@/src/lib/usage";
import { formatIcpBlock } from "@/src/pipeline/icp";
import {
  LeadSchema,
  type Icp,
  type Lead,
  type OnEvent,
  type ScannedCandidate,
} from "@/src/pipeline/types";

/**
 * Stage 4 — score everything in one pass.
 *
 * Scoring is done as a single batched call rather than one call per company,
 * because a score is only meaningful relative to the rest of the list. Judging
 * companies in isolation produces a pile of 80s; judging them together forces
 * the model to rank.
 */

/**
 * Structural checks only. Semantic limits — a score in range, at least one
 * reason — are repaired in code below rather than enforced here. The shared
 * output contract tells the model empty arrays are acceptable, so a `.min(1)`
 * on scoreReasons aborted whole batches live whenever the model left a
 * disqualified company's reasons empty. One malformed company must not cost
 * the run every other score.
 */
const EvaluationSchema = z.object({
  /** Must echo one of the domains given in the input list. */
  domain: z.string(),
  score: z.number(),
  scoreReasons: z
    .array(z.string())
    .describe(
      'One line per rubric dimension, in order: "Fit: <points> — <reason>", "Pain: <points> — <reason>", "Timing: <points> — <reason>", plus at most one extra note. Required for every company, disqualified ones included — never empty.',
    ),
  disqualified: z.boolean(),
  disqualifiedReason: z.string().optional(),
});
const EvaluationsSchema = z.object({
  evaluations: z.array(EvaluationSchema),
});

export type QualifyOptions = {
  onEvent?: OnEvent;
  /** Characters of homepage text included per company for fit context. */
  excerptChars?: number;
};

export type QualifyResult = {
  /** Qualified leads, highest score first. */
  leads: Lead[];
  /** Disqualified companies, kept for transparency. */
  disqualified: Lead[];
  usage: UsageTotals;
  /** Domains the model failed to return a verdict for. */
  unscored: string[];
  /** Domains that got a score but no reasons; a placeholder was substituted. */
  withoutReasons: string[];
};

export const QUALIFY_RUBRIC = `SCORING RUBRIC — score = fit + pain + timing, out of 100.

1. FIT (0-40) — how precisely does this company match the ICP?
   35-40: bullseye on industry, size and geography.
   25-34: right industry and geography, size band slightly off.
   15-24: adjacent industry or a stretch on two dimensions.
   0-14: only loosely related to the ICP.

2. PAIN / NEED EVIDENCE (0-30) — is there visible evidence they need what this agency sells?
   24-30: the gap is documented — a weak or stale presence, a role they are hiring to fill, competitors clearly outperforming them.
   15-23: plausible need implied by one concrete observation.
   6-14: need is inferred from category, not from evidence.
   0-5: no evidence of need; they may already have this handled well in-house.

3. TIMING / WHY NOW (0-30) — is there a trigger making this the right month to reach out?
   24-30: a strong, dated, recent trigger (funding, new marketing leader, launch/rebrand) with a source.
   15-23: a real but softer or older trigger, or active marketing hiring.
   6-14: one weak or undated signal.
   0-5: no why-now signal at all.

Calibration rules:
- Signals are the evidence base. A company with zero signals cannot score above 15 on pain and above 5 on timing — but zero signals is NOT a disqualification, it just means we cannot time the outreach.
- Never credit a company for a signal it does not have in the list below. Do not infer.
- Use the whole range. If every company scores in the 70s, you have not ranked them.`;

export const QUALIFY_DISQUALIFY_RULES = `DISQUALIFICATION — set disqualified=true, and give a one-line disqualifiedReason, when any of these is true:
- The company is itself a marketing, advertising, creative, branding, PR, SEO or growth agency, a consultancy, or a freelancer. They are a competitor, not a buyer.
- The company is far larger than the ICP band — big enough that it certainly runs a full in-house marketing team and buys only from enterprise vendors.
- The company is in the wrong geography for the ICP.
- The company is in the wrong industry or has the wrong business model for the ICP (e.g. pure B2C when the ICP is B2B).
- The company trips any of the ICP's own listed disqualifiers.
- The entry is not an operating company at all — it is a publication, directory, job board, conference, government body or non-profit — or the company is defunct or has been acquired.

Do NOT disqualify merely for a low score, an absence of signals, or an unreachable website. Score those low instead. Disqualification is for structural mismatches only.`;

export const QUALIFY_SYSTEM_PROMPT = `You are the head of new business at a marketing agency, deciding which companies your team will spend this week pitching. You are known for being hard to impress.

You will be given the agency's ICP and a list of researched companies with the why-now signals found for each. Score every company on the rubric, rank them honestly, and cut the ones that are structurally wrong.

Principles:
- Judge the companies against each other, not in isolation. A ranked list is the product.
- Every scoreReason must cite something specific from that company's own data — a named signal, a concrete ICP mismatch, an observation about their site. Reasons that would read identically for any company are worthless; do not write them.
- Disqualified companies get scoreReasons too. The verdict goes in disqualifiedReason; the rubric reading still goes in scoreReasons, so a reader can see how close it came.
- Be sceptical. Weak evidence deserves a low score, not a generous one.
- Return exactly one evaluation for every company given, using the company's domain verbatim as the key. Do not add companies, do not skip companies.`;

export function buildQualifyPrompt(
  scanned: readonly ScannedCandidate[],
  icp: Icp,
  excerptChars: number,
): string {
  const companies = scanned.map((item, index) => {
    const lines: string[] = [
      `--- COMPANY ${index + 1} ---`,
      `domain: ${item.company.domain}`,
      `name: ${item.company.name}`,
    ];

    if (item.company.why) lines.push(`shortlisted because: ${item.company.why}`);
    if (item.company.discoveredVia) {
      lines.push(`found via: ${item.company.discoveredVia}`);
    }

    if (item.signals.length === 0) {
      lines.push(
        item.scanError
          ? "signals: NONE — research failed for this company, so absence of signals is not evidence either way."
          : "signals: NONE FOUND — research ran and turned up no credible why-now trigger.",
      );
    } else {
      lines.push(`signals (${item.signals.length}):`);
      for (const signal of item.signals) {
        lines.push(
          `  - [${signal.type}]${signal.date ? ` (${signal.date})` : ""} ${
            signal.evidence
          } — source: ${signal.sourceUrl}`,
        );
      }
    }

    if (item.homepageExcerpt) {
      lines.push(
        `homepage excerpt: "${item.homepageExcerpt
          .slice(0, excerptChars)
          .replace(/\s+/g, " ")
          .trim()}"`,
      );
    } else if (item.homepageError) {
      lines.push(`homepage: could not be read (${item.homepageError})`);
    }

    return lines.join("\n");
  });

  return [
    formatIcpBlock(icp),
    "",
    QUALIFY_RUBRIC,
    "",
    QUALIFY_DISQUALIFY_RULES,
    "",
    `=== COMPANIES TO SCORE (${scanned.length}) ===`,
    companies.join("\n"),
    "=== END COMPANIES ===",
    "",
    `Return exactly ${scanned.length} evaluations — one per company, keyed by the exact domain string given above.`,
    "For each: score (0-100, the rubric total); disqualified (true/false); disqualifiedReason when disqualified is true; and scoreReasons — required for EVERY company, disqualified ones included, never an empty array.",
    'scoreReasons is three short strings in this order, each opening with its dimension and the points you gave it: "Fit: 32 — <specific reason>", "Pain: 18 — <specific reason>", "Timing: 6 — <specific reason>". The three must add up to the score. Add at most one extra note after them.',
  ].join("\n");
}

/**
 * Score every scanned candidate in one batched strategist call.
 * Qualified leads come back sorted by score descending; disqualified
 * companies are returned separately rather than thrown away.
 */
export async function qualifyLeads(
  scanned: readonly ScannedCandidate[],
  icp: Icp,
  opts: QualifyOptions = {},
): Promise<QualifyResult> {
  const { onEvent, excerptChars = 400 } = opts;

  if (scanned.length === 0) {
    onEvent?.({ stage: "qualify", message: "Nothing to qualify" });
    return {
      leads: [],
      disqualified: [],
      usage: emptyUsage(),
      unscored: [],
      withoutReasons: [],
    };
  }

  onEvent?.({
    stage: "qualify",
    message: `Scoring ${scanned.length} companies against the ICP`,
  });

  const { value, usage } = await structuredChat(
    MODELS.strategist,
    [
      { role: "system", content: QUALIFY_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildQualifyPrompt(scanned, icp, excerptChars),
      },
    ],
    EvaluationsSchema,
    {
      schemaName: "Evaluations",
      temperature: 0.2,
      // Batched output scales with the candidate count.
      maxTokens: Math.min(8000, 900 + scanned.length * 320),
    },
  );

  const byDomain = new Map<string, z.infer<typeof EvaluationSchema>>();
  for (const evaluation of value.evaluations) {
    const key = normalizeDomain(evaluation.domain);
    if (key && !byDomain.has(key)) byDomain.set(key, evaluation);
  }

  const leads: Lead[] = [];
  const disqualified: Lead[] = [];
  const unscored: string[] = [];
  const withoutReasons: string[] = [];

  for (const item of scanned) {
    const evaluation = byDomain.get(normalizeDomain(item.company.domain));

    if (!evaluation) {
      unscored.push(item.company.domain);
      // Surfaced rather than dropped, so a scoring gap is visible not silent.
      leads.push(
        LeadSchema.parse({
          company: item.company,
          signals: item.signals,
          score: 0,
          scoreReasons: ["The scoring model returned no verdict for this company."],
        }),
      );
      continue;
    }

    const disqualifiedReason =
      evaluation.disqualifiedReason?.trim() || "Structural mismatch with the ICP.";

    // The prompt asks for 3-4; trim rather than fail the whole batch.
    const scoreReasons = evaluation.scoreReasons
      .map((reason) => reason.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (scoreReasons.length === 0) {
      // A verdict with no reasons is still a verdict. Substitute something
      // honest and flag it, rather than letting one company fail the batch.
      withoutReasons.push(item.company.domain);
      scoreReasons.push(
        evaluation.disqualified
          ? disqualifiedReason
          : "The scoring model returned a score but no reasons for it.",
      );
    }

    const lead = LeadSchema.parse({
      company: item.company,
      signals: item.signals,
      score: Math.round(Math.max(0, Math.min(100, evaluation.score))),
      scoreReasons,
      ...(evaluation.disqualified
        ? { disqualified: true, disqualifiedReason }
        : {}),
    });

    if (evaluation.disqualified) disqualified.push(lead);
    else leads.push(lead);
  }

  const byScoreDesc = (a: Lead, b: Lead) => b.score - a.score;
  leads.sort(byScoreDesc);
  disqualified.sort(byScoreDesc);

  onEvent?.({
    stage: "qualify",
    message: `${leads.length} qualified, ${disqualified.length} disqualified`,
    data: {
      top: leads.slice(0, 3).map((lead) => ({
        name: lead.company.name,
        score: lead.score,
      })),
      unscored,
      withoutReasons,
    },
  });

  return { leads, disqualified, usage, unscored, withoutReasons };
}
