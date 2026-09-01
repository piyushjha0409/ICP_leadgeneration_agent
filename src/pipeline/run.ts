import { PIPELINE_DEFAULTS } from "@/src/config";
import { mapWithLimit } from "@/src/lib/concurrency";
import { normalizeDomain } from "@/src/lib/domain";
import { enrichContact } from "@/src/lib/enrich";
import {
  emptyUsage,
  estimateCostUsd,
  mergeUsage,
  type UsageTotals,
} from "@/src/lib/usage";
import { deriveIcp, type DeriveIcpInput } from "@/src/pipeline/icp";
import { huntCandidates } from "@/src/pipeline/hunt";
import { scanAll } from "@/src/pipeline/scan";
import { qualifyLeads } from "@/src/pipeline/qualify";
import { briefLeads } from "@/src/pipeline/brief";
import type {
  Candidate,
  Icp,
  Lead,
  OnEvent,
  PipelineEvent,
  PipelineStage,
  ScannedCandidate,
} from "@/src/pipeline/types";

/**
 * The orchestrator: icp -> hunt -> scan -> qualify -> enrich -> brief.
 *
 * Every event is both pushed to the returned array and handed to `onEvent`.
 * Phase 1's route reads the array; Phase 2 will stream the callback over SSE
 * without this file changing.
 */

export type RunInput = DeriveIcpInput;

export type RunOptions = {
  onEvent?: OnEvent;
  maxAngles?: number;
  perAngle?: number;
  maxCandidates?: number;
  /**
   * Extra domains to keep out of the hunt results, alongside the agency's
   * own domain — e.g. companies already surfaced by a previous run. Purely a
   * passthrough to `huntCandidates`'s existing `excludeDomains` option.
   */
  excludeDomains?: string[];
  /**
   * How many of the highest-scoring leads get a contact lookup and an
   * outreach brief. Everything below the cut is still returned, just
   * un-enriched and un-briefed.
   */
  topN?: number;
};

export type RunStats = {
  durationMs: number;
  /** Wall-clock ms per stage. */
  perStage: Record<PipelineStage, number>;
  usage: UsageTotals;
  /** Token-rate estimate. $0 on the default `:free` models. */
  estCostUsd: number;
  /** OpenRouter's own figure, when reported. $0 on `:free` models. */
  reportedCostUsd: number;
};

export type RunResult = {
  icp: Icp;
  candidates: Candidate[];
  scanned: ScannedCandidate[];
  leads: Lead[];
  disqualified: Lead[];
  events: PipelineEvent[];
  /** Non-fatal problems (a failed angle, a failed scan) worth surfacing. */
  warnings: string[];
  stats: RunStats;
};

export async function runPipeline(
  input: RunInput,
  opts: RunOptions = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const events: PipelineEvent[] = [];
  const warnings: string[] = [];
  const usage = emptyUsage();
  const perStage: Record<PipelineStage, number> = {
    icp: 0,
    hunt: 0,
    scan: 0,
    qualify: 0,
    enrich: 0,
    brief: 0,
    run: 0,
  };

  const onEvent: OnEvent = (event) => {
    const stamped: PipelineEvent = { ...event, at: Date.now() - startedAt };
    events.push(stamped);
    opts.onEvent?.(stamped);
  };

  /** Run a stage, record its wall-clock time even when it throws. */
  const timed = async <T>(stage: PipelineStage, fn: () => Promise<T>) => {
    const stageStart = Date.now();
    try {
      return await fn();
    } finally {
      perStage[stage] = Date.now() - stageStart;
    }
  };

  onEvent({
    stage: "run",
    message: "Starting run",
    data: {
      agencyUrl: input.agencyUrl,
      hasDescription: Boolean(input.description?.trim()),
    },
  });

  // --- 1. ICP -------------------------------------------------------------
  const icpResult = await timed("icp", () => deriveIcp(input, { onEvent }));
  mergeUsage(usage, icpResult.usage);
  const { icp } = icpResult;
  if (icpResult.agencySiteError) {
    warnings.push(`agency site: ${icpResult.agencySiteError}`);
  }

  // --- 2. Hunt ------------------------------------------------------------
  // Keep the agency out of its own candidate list, plus any caller-supplied
  // domains (e.g. leads already surfaced by an earlier run).
  const excludeDomains = [
    normalizeDomain(input.agencyUrl),
    ...(opts.excludeDomains ?? []),
  ].filter(Boolean);

  const huntResult = await timed("hunt", () =>
    huntCandidates(icp, {
      onEvent,
      excludeDomains,
      maxAngles: opts.maxAngles ?? PIPELINE_DEFAULTS.maxAngles,
      perAngle: opts.perAngle ?? PIPELINE_DEFAULTS.perAngle,
      maxCandidates: opts.maxCandidates ?? PIPELINE_DEFAULTS.maxCandidates,
    }),
  );
  mergeUsage(usage, huntResult.usage);
  warnings.push(...huntResult.errors.map((error) => `hunt: ${error}`));

  const { candidates } = huntResult;

  if (candidates.length === 0) {
    onEvent({
      stage: "run",
      message: "No candidates found — stopping before scan",
    });
    perStage.run = Date.now() - startedAt;
    return {
      icp,
      candidates: [],
      scanned: [],
      leads: [],
      disqualified: [],
      events,
      warnings,
      stats: {
        durationMs: Date.now() - startedAt,
        perStage,
        usage,
        estCostUsd: estimateCostUsd(usage),
        reportedCostUsd: Number(usage.reportedCostUsd.toFixed(6)),
      },
    };
  }

  // --- 3. Scan ------------------------------------------------------------
  const scanResult = await timed("scan", () =>
    scanAll(candidates, icp, { onEvent }),
  );
  mergeUsage(usage, scanResult.usage);
  warnings.push(...scanResult.errors.map((error) => `scan: ${error}`));

  // --- 4. Qualify ---------------------------------------------------------
  const qualifyResult = await timed("qualify", () =>
    qualifyLeads(scanResult.scanned, icp, { onEvent }),
  );
  mergeUsage(usage, qualifyResult.usage);
  if (qualifyResult.unscored.length > 0) {
    warnings.push(
      `qualify: no verdict returned for ${qualifyResult.unscored.join(", ")}`,
    );
  }
  if (qualifyResult.withoutReasons.length > 0) {
    warnings.push(
      `qualify: scored without reasons — ${qualifyResult.withoutReasons.join(", ")}`,
    );
  }

  // Enrichment and briefing are spent only on the leads someone will call.
  const topN = opts.topN ?? PIPELINE_DEFAULTS.topN;

  // --- 5. Enrich ----------------------------------------------------------
  // `qualifyLeads` returns leads highest-score-first, so the top of the list
  // is the shortlist worth spending Hunter credits on.
  const enrichedLeads = await timed("enrich", async () => {
    const scored = qualifyResult.leads;
    const targets = scored.slice(0, topN);

    if (targets.length === 0) {
      onEvent({ stage: "enrich", message: "No leads to enrich" });
      return scored;
    }

    onEvent({
      stage: "enrich",
      message: `Finding the right person at the top ${targets.length} compan${
        targets.length === 1 ? "y" : "ies"
      }`,
    });

    const contacts = await mapWithLimit(
      targets,
      PIPELINE_DEFAULTS.enrichConcurrency,
      async (lead) => {
        const result = await enrichContact(lead.company.domain, icp);

        onEvent({
          stage: "enrich",
          message: result.contact
            ? `${lead.company.name}: ${result.contact.name} — ${
                result.contact.role
              }${result.contact.email ? ` · ${result.contact.email}` : ""}`
            : `${lead.company.name}: ${result.note ?? "no contact found"}`,
          data: {
            domain: lead.company.domain,
            contact: result.contact,
            note: result.note,
          },
        });

        return result;
      },
    );

    // One missing key is one warning, not eight identical ones.
    const notes = new Set(
      contacts
        .filter((result) => !result.contact)
        .map((result) => result.note ?? "no contact found"),
    );
    for (const note of notes) warnings.push(`enrich: ${note}`);

    const found = contacts.filter((result) => result.contact).length;
    onEvent({
      stage: "enrich",
      message: `${found} of ${targets.length} leads have a named contact`,
      data: { found, attempted: targets.length },
    });

    return scored.map((lead, index) => {
      const contact = contacts[index]?.contact;
      return contact ? { ...lead, contact } : lead;
    });
  });

  // --- 6. Brief -----------------------------------------------------------
  const briefResult = await timed("brief", () =>
    briefLeads(enrichedLeads, icp, {
      onEvent,
      topN,
      concurrency: PIPELINE_DEFAULTS.briefConcurrency,
    }),
  );
  mergeUsage(usage, briefResult.usage);
  warnings.push(...briefResult.errors.map((error) => `brief: ${error}`));

  const leads = briefResult.leads;

  const durationMs = Date.now() - startedAt;
  perStage.run = durationMs;

  const estCostUsd = estimateCostUsd(usage);

  onEvent({
    stage: "run",
    message: `Done — ${leads.length} qualified leads, ${
      briefResult.briefed
    } ready to send, in ${(durationMs / 1000).toFixed(1)}s`,
    data: {
      candidates: candidates.length,
      leads: leads.length,
      briefed: briefResult.briefed,
      disqualified: qualifyResult.disqualified.length,
      estCostUsd,
    },
  });

  return {
    icp,
    candidates,
    scanned: scanResult.scanned,
    leads,
    disqualified: qualifyResult.disqualified,
    events,
    warnings,
    stats: {
      durationMs,
      perStage,
      usage,
      estCostUsd,
      reportedCostUsd: Number(usage.reportedCostUsd.toFixed(6)),
    },
  };
}
