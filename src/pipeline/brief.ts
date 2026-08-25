import * as z from "zod";
import { MODELS, PIPELINE_DEFAULTS } from "@/src/config";
import { mapWithLimit } from "@/src/lib/concurrency";
import { normalizeDomain } from "@/src/lib/domain";
import { suggestTargetRole } from "@/src/lib/enrich";
import { structuredChat, usageFromError } from "@/src/lib/structured";
import { emptyUsage, mergeUsage, type UsageTotals } from "@/src/lib/usage";
import { formatIcpBlock } from "@/src/pipeline/icp";
import {
  LeadSchema,
  type Icp,
  type Lead,
  type OnEvent,
  type Signal,
} from "@/src/pipeline/types";

/**
 * Stage 6 — turn a ranked lead into something a human can send today.
 *
 * Two shapes of call, for two different jobs. Pitch angles are batched into a
 * single strategist call because an angle is a positioning decision and
 * positioning is comparative — written one at a time, every angle comes back
 * as "help them grow". Drafts are per-lead operator calls because a message
 * is about one company, and one bad draft must not cost the other seven.
 *
 * Only the top-N leads are briefed. The rest pass through untouched: a draft
 * for a lead nobody will call is spend with no buyer.
 */

const PitchAngleSchema = z.object({
  /** Must echo one of the domains given in the input list. */
  domain: z.string(),
  pitchAngle: z.string(),
});
const PitchAnglesSchema = z.object({ angles: z.array(PitchAngleSchema) });

const DraftSchema = z.object({ draftMessage: z.string() });

export type BriefOptions = {
  onEvent?: OnEvent;
  /** How many of the highest-scoring leads to brief. */
  topN?: number;
  /** Parallel draft calls. */
  concurrency?: number;
};

export type BriefResult = {
  /** Every lead given, in the same order, with the top-N now carrying a brief. */
  leads: Lead[];
  usage: UsageTotals;
  /** Non-fatal per-lead failures, kept for the run report. */
  errors: string[];
  /** How many leads came back with a draft message. */
  briefed: number;
};

/** Bounds the cleaner enforces. The prompt asks for 60-120. */
export const DRAFT_MIN_WORDS = 40;
export const DRAFT_MAX_WORDS = 190;

/** Placeholders make a draft unsendable, which defeats the whole stage. */
const PLACEHOLDER_RE = /\[[^\]\n]{1,40}\]|\{\{[^}\n]{1,40}\}\}|<[A-Za-z][A-Za-z ]{1,28}>/;

/** Which signal makes the best opening line, strongest first. */
const SIGNAL_STRENGTH: Record<Signal["type"], number> = {
  funding: 6,
  new_marketing_leader: 6,
  launch_or_rebrand: 5,
  hiring_marketing: 4,
  losing_to_competitors: 3,
  weak_digital_presence: 2,
};

/**
 * The hook. A dated fact outranks an undated one of the same kind — "you
 * raised in March" is a reason to write this week; "you raised" is not.
 */
export function strongestSignal(signals: readonly Signal[]): Signal | undefined {
  const ranked = [...signals].sort((a, b) => {
    const weight =
      SIGNAL_STRENGTH[b.type] +
      (b.date ? 1 : 0) -
      (SIGNAL_STRENGTH[a.type] + (a.date ? 1 : 0));
    if (weight !== 0) return weight;
    // ISO dates (YYYY-MM-DD or YYYY-MM) sort correctly as strings.
    return (b.date ?? "").localeCompare(a.date ?? "");
  });
  return ranked[0];
}

function formatSignal(signal: Signal): string {
  return `  - [${signal.type}]${signal.date ? ` (${signal.date})` : " (no date)"} ${
    signal.evidence
  } — source: ${signal.sourceUrl}`;
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

// --- Pitch angles ---------------------------------------------------------

export const PITCH_ANGLE_SYSTEM_PROMPT = `You are the head of strategy at a marketing agency, writing the one-line reason each of these companies should take a call this month.

A pitch angle answers three things in a single breath: why an agency at all, why THIS agency, and why now. It is written for the person who will make the call, not for the prospect — so it is blunt, not polished.

Rules:
- 1 to 2 sentences. No greeting, no sign-off, no preamble.
- Anchor it on the company's own evidence. Name the fact: the round, the hire, the launch, the specific gap on their site. Prefer the dated fact.
- Connect that fact to ONE service the agency actually sells, from the ICP's service list. One, not three.
- An angle that would read identically for another company on this list has failed. If you have written "help them scale their growth", delete it and write what is actually true of this company.
- Never invent evidence to make an angle stronger. When a company's evidence is thin, say what the realistic play is and let it be modest.
- No agency-brochure vocabulary: no world-class, cutting-edge, synergy, unlock, supercharge, game-changing.
- Return exactly one angle per company, keyed by the domain string given verbatim. Do not add companies, do not skip companies.`;

export function buildPitchAnglesPrompt(
  leads: readonly Lead[],
  icp: Icp,
): string {
  const blocks = leads.map((lead, index) => {
    const lines: string[] = [
      `--- COMPANY ${index + 1} ---`,
      `domain: ${lead.company.domain}`,
      `name: ${lead.company.name}`,
      `ICP-fit score: ${lead.score}/100`,
    ];

    if (lead.company.why) lines.push(`shortlisted because: ${lead.company.why}`);

    if (lead.signals.length === 0) {
      lines.push("signals: NONE FOUND — no why-now trigger was evidenced.");
    } else {
      lines.push(`signals (${lead.signals.length}):`);
      for (const signal of lead.signals) lines.push(formatSignal(signal));
    }

    if (lead.scoreReasons.length > 0) {
      lines.push(`why it scored ${lead.score}: ${lead.scoreReasons.join("; ")}`);
    }

    lines.push(
      lead.contact
        ? `contact found: ${lead.contact.name} — ${lead.contact.role}`
        : `no contact found; the pitch will go to a ${suggestTargetRole(icp)}`,
    );

    return lines.join("\n");
  });

  return [
    formatIcpBlock(icp),
    "",
    `=== COMPANIES TO WRITE ANGLES FOR (${leads.length}) ===`,
    blocks.join("\n"),
    "=== END COMPANIES ===",
    "",
    `Write exactly ${leads.length} pitch angles — one per company, keyed by the exact domain string given above.`,
    "Each angle: 1-2 sentences, built on that company's own signals, pointing at one named service from the ICP.",
  ].join("\n");
}

// --- Draft first-touch message -------------------------------------------

export const DRAFT_SYSTEM_PROMPT = `You write first-touch outreach emails for a marketing agency.

Your drafts are sent as written. Nobody rewrites them, nobody fact-checks them — so anything you invent goes out under a real person's name, to a real prospect, and costs the agency the account.

You write like a specific human who read about this company ten minutes ago: short sentences, concrete nouns, no throat-clearing, no performance of enthusiasm. The only bar that matters is whether a busy operator replies instead of deleting it in two seconds.`;

export const DRAFT_RULES = `HARD REQUIREMENTS
- 60 to 120 words. Plain text email body only: no subject line, no signature, no markdown, no bullet points.
- FIRST SENTENCE: the strongest dated signal in the brief, as a congratulation or an observation. Nothing comes before it — no "hope you're well", no throat-clearing.
- SECOND BEAT: connect that signal to exactly ONE capability from the agency's service list, and say concretely what it would do for them. One service. Not a menu.
- LAST LINE: a low-friction ask — a 15-minute call, or "worth a look?". One ask, one question mark.
- If a first name is given below, open by addressing them by it. If no name is given, open with the observation itself — never "Hi there", never "Hello Team", and never invent a name.
- EVERY fact in the message must appear in the brief below. If a number, a competitor, a tool, a headcount or a plan is not in the brief, it does not go in the email.
- No placeholders, ever. "[Name]", "[Company]", "{{first_name}}", "[Your name]" and "X" stand-ins make the draft unsendable. Write the real words or leave the sentence out.

BANNED — a draft containing any of these is a failed draft
- Generic flattery: "I love what you're doing", "big fan of the brand", "impressive growth", "you're crushing it".
- Fake familiarity: "great catching up", "as discussed", "following up on our chat", "circling back", "reaching back out".
- "I hope this email finds you well" and every variant of it.
- Buzzword soup: synergy, leverage, unlock, supercharge, game-changing, best-in-class, world-class, 10x, "in today's landscape", "the current climate".
- More than one exclamation mark in the whole message. Zero is better than one.
- A paragraph of agency credentials, awards or client logos. They did not ask.`;

export function buildDraftPrompt(
  lead: Lead,
  icp: Icp,
  pitchAngle: string | undefined,
): string {
  const hook = strongestSignal(lead.signals);

  const sections: string[] = [
    formatIcpBlock(icp),
    "",
    `The agency's services, verbatim — pick exactly one: ${icp.services.join(", ")}`,
    "",
    `=== BRIEF: ${lead.company.name} (${lead.company.domain}) ===`,
  ];

  if (lead.contact) {
    const firstName = firstNameOf(lead.contact.name);
    sections.push(
      `Recipient: ${lead.contact.name} — ${lead.contact.role}`,
      firstName
        ? `Address them by first name: ${firstName}`
        : "No usable first name — open with the observation instead.",
    );
  } else {
    sections.push(
      `Recipient: no named contact was found. This will be sent to whoever holds the ${suggestTargetRole(
        icp,
      )} role. Do not name them, do not guess a name, do not write "Hi there".`,
    );
  }

  if (lead.company.why) {
    sections.push(`Why they were shortlisted: ${lead.company.why}`);
  }

  if (hook) {
    sections.push(
      "",
      "STRONGEST DATED SIGNAL — this is your opening line:",
      formatSignal(hook),
    );
  }

  if (lead.signals.length > 0) {
    sections.push(
      "",
      `ALL EVIDENCE FOUND (${lead.signals.length}) — everything you are allowed to reference:`,
      ...lead.signals.map(formatSignal),
    );
  } else {
    sections.push(
      "",
      "ALL EVIDENCE FOUND: none. No dated trigger was evidenced for this company.",
      "Open on the concrete observation from the research below instead — and do not invent a trigger, a round or a hire.",
    );
  }

  if (lead.scoreReasons.length > 0) {
    sections.push(
      "",
      `Research notes (score ${lead.score}/100): ${lead.scoreReasons.join("; ")}`,
    );
  }

  if (pitchAngle) {
    sections.push("", `The agreed pitch angle for this company: ${pitchAngle}`);
  }

  sections.push(
    "=== END BRIEF ===",
    "",
    DRAFT_RULES,
    "",
    "Write the email body now, 60-120 words, ready to send as-is.",
  );

  return sections.join("\n");
}

/** Words, counted the way a human would count them. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Repair what is safely repairable and reject what is not. A draft that
 * still contains a placeholder or runs to twice the requested length is not
 * sendable, and shipping it unmarked is worse than shipping no draft.
 */
export function cleanDraft(raw: string): string | null {
  let text = raw.replace(/\r\n?/g, "\n").trim();

  // Models occasionally wrap the body in a fence or quotes despite the contract.
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }

  // A subject line was explicitly not asked for; drop it rather than the draft.
  text = text.replace(/^subject\s*:.*\n+/i, "").trim();

  // A trailing "[Your name]" sign-off is the model admitting it has no
  // signature to use — cut those lines instead of failing the whole draft.
  const lines = text.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    if (
      last === "" ||
      (PLACEHOLDER_RE.test(last) && last.length <= 40) ||
      /^(best|thanks|cheers|regards|best regards|sincerely)[,.!]?$/i.test(last)
    ) {
      lines.pop();
      continue;
    }
    break;
  }
  text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!text) return null;
  if (PLACEHOLDER_RE.test(text)) return null;

  const words = wordCount(text);
  if (words < DRAFT_MIN_WORDS || words > DRAFT_MAX_WORDS) return null;

  return text;
}

// --- The stage ------------------------------------------------------------

type Target = { lead: Lead; index: number };

/** The top `topN` leads by score, keeping input order for equal scores. */
function pickTargets(leads: readonly Lead[], topN: number): Target[] {
  return leads
    .map((lead, index) => ({ lead, index }))
    .sort((a, b) => b.lead.score - a.lead.score || a.index - b.index)
    .slice(0, Math.max(0, topN));
}

async function pitchAngles(
  targets: readonly Target[],
  icp: Icp,
  usage: UsageTotals,
  errors: string[],
  onEvent?: OnEvent,
): Promise<Map<string, string>> {
  const byDomain = new Map<string, string>();
  const leads = targets.map((target) => target.lead);

  try {
    const result = await structuredChat(
      MODELS.strategist,
      [
        { role: "system", content: PITCH_ANGLE_SYSTEM_PROMPT },
        { role: "user", content: buildPitchAnglesPrompt(leads, icp) },
      ],
      PitchAnglesSchema,
      {
        schemaName: "PitchAngles",
        temperature: 0.4,
        // Batched output scales with the number of leads being briefed.
        maxTokens: Math.min(4000, 600 + leads.length * 220),
      },
    );
    mergeUsage(usage, result.usage);

    for (const angle of result.value.angles) {
      const key = normalizeDomain(angle.domain);
      const text = angle.pitchAngle.trim();
      if (key && text && !byDomain.has(key)) byDomain.set(key, text);
    }

    onEvent?.({
      stage: "brief",
      message: `Pitch angles written for ${byDomain.size} of ${leads.length} leads`,
      data: { angles: byDomain.size },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`pitch angles failed: ${message}`);
    // Failed attempts still cost tokens; keep them in the total.
    mergeUsage(usage, usageFromError(err) ?? emptyUsage());
    onEvent?.({
      stage: "brief",
      message: `Pitch angles failed: ${message} — drafting from signals alone`,
      data: { error: message },
    });
  }

  return byDomain;
}

/**
 * Write pitch angles and first-touch drafts for the highest-scoring leads.
 *
 * Never rejects: a lead whose draft fails comes back exactly as it went in,
 * with the reason recorded in `errors`.
 */
export async function briefLeads(
  leads: readonly Lead[],
  icp: Icp,
  opts: BriefOptions = {},
): Promise<BriefResult> {
  const {
    onEvent,
    topN = PIPELINE_DEFAULTS.topN,
    concurrency = PIPELINE_DEFAULTS.briefConcurrency,
  } = opts;

  const usage = emptyUsage();
  const errors: string[] = [];

  if (leads.length === 0) {
    onEvent?.({ stage: "brief", message: "Nothing to brief" });
    return { leads: [], usage, errors, briefed: 0 };
  }

  const targets = pickTargets(leads, topN);
  if (targets.length === 0) {
    onEvent?.({ stage: "brief", message: "Nothing to brief" });
    return { leads: [...leads], usage, errors, briefed: 0 };
  }

  onEvent?.({
    stage: "brief",
    message: `Briefing the top ${targets.length} of ${leads.length} leads`,
    data: { topN: targets.length, total: leads.length },
  });

  const angleByDomain = await pitchAngles(targets, icp, usage, errors, onEvent);

  const drafted = await mapWithLimit(targets, concurrency, async (target) => {
    const { lead, index } = target;
    const pitchAngle = angleByDomain.get(normalizeDomain(lead.company.domain));

    onEvent?.({
      stage: "brief",
      message: `Drafting first touch for ${lead.company.name}`,
      data: { domain: lead.company.domain },
    });

    try {
      const result = await structuredChat(
        MODELS.operator,
        [
          { role: "system", content: DRAFT_SYSTEM_PROMPT },
          { role: "user", content: buildDraftPrompt(lead, icp, pitchAngle) },
        ],
        DraftSchema,
        { schemaName: "DraftMessage", temperature: 0.6, maxTokens: 900 },
      );

      const draftMessage = cleanDraft(result.value.draftMessage);

      if (!draftMessage) {
        errors.push(
          `${lead.company.name}: draft rejected (placeholder text or outside ${DRAFT_MIN_WORDS}-${DRAFT_MAX_WORDS} words)`,
        );
        onEvent?.({
          stage: "brief",
          message: `${lead.company.name}: draft rejected as unsendable`,
          data: { domain: lead.company.domain },
        });
        return { index, pitchAngle, usage: result.usage };
      }

      onEvent?.({
        stage: "brief",
        message: `${lead.company.name}: draft ready (${wordCount(draftMessage)} words)`,
        data: { domain: lead.company.domain, words: wordCount(draftMessage) },
      });

      return { index, pitchAngle, draftMessage, usage: result.usage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${lead.company.name}: ${message}`);
      onEvent?.({
        stage: "brief",
        message: `${lead.company.name} brief failed: ${message}`,
        data: { domain: lead.company.domain, error: message },
      });
      // Failed attempts still cost tokens; keep them in the total.
      return {
        index,
        pitchAngle,
        usage: usageFromError(err) ?? emptyUsage(),
      };
    }
  });

  const byIndex = new Map<number, (typeof drafted)[number]>();
  for (const item of drafted) {
    mergeUsage(usage, item.usage);
    byIndex.set(item.index, item);
  }

  let briefed = 0;
  const briefedLeads = leads.map((lead, index) => {
    const brief = byIndex.get(index);
    if (!brief?.pitchAngle && !brief?.draftMessage) return lead;
    if (brief.draftMessage) briefed += 1;

    // Round-trip through the schema so nothing unvalidated escapes the stage.
    return LeadSchema.parse({
      ...lead,
      ...(brief.pitchAngle ? { pitchAngle: brief.pitchAngle } : {}),
      ...(brief.draftMessage ? { draftMessage: brief.draftMessage } : {}),
    });
  });

  onEvent?.({
    stage: "brief",
    message: `${briefed} of ${targets.length} leads have a sendable first touch`,
    data: { briefed, attempted: targets.length },
  });

  return { leads: briefedLeads, usage, errors, briefed };
}
