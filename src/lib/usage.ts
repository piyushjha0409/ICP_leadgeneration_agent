import type { ChatUsage } from "@openrouter/sdk/models";
import { rateFor } from "@/src/config";

/** Per-model token counters. */
export type ModelUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

/**
 * Token usage accumulated across an arbitrary number of LLM calls, broken
 * down per model so cost can be computed at each model's own rate.
 */
export type UsageTotals = ModelUsage & {
  byModel: Record<string, ModelUsage>;
  /**
   * Sum of `usage.cost` as reported by OpenRouter — the authoritative figure
   * when it is non-zero. On the `:free` model variants it is 0, which is the
   * truth: inference is free and web search is billed by Firecrawl/Tavily in credits,
   * not dollars, so neither number is hiding a charge.
   */
  reportedCostUsd: number;
};

export function emptyUsage(): UsageTotals {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byModel: {},
    reportedCostUsd: 0,
  };
}

/** Fold a single OpenRouter `usage` payload into a running total. */
export function recordUsage(
  totals: UsageTotals,
  model: string,
  usage: ChatUsage | undefined,
): UsageTotals {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;

  totals.calls += 1;
  totals.promptTokens += promptTokens;
  totals.completionTokens += completionTokens;
  totals.totalTokens += totalTokens;
  totals.reportedCostUsd += usage?.cost ?? 0;

  const perModel = (totals.byModel[model] ??= {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
  perModel.calls += 1;
  perModel.promptTokens += promptTokens;
  perModel.completionTokens += completionTokens;
  perModel.totalTokens += totalTokens;

  return totals;
}

/** Merge one accumulator into another (e.g. a stage total into a run total). */
export function mergeUsage(
  into: UsageTotals,
  ...others: UsageTotals[]
): UsageTotals {
  for (const other of others) {
    into.calls += other.calls;
    into.promptTokens += other.promptTokens;
    into.completionTokens += other.completionTokens;
    into.totalTokens += other.totalTokens;
    into.reportedCostUsd += other.reportedCostUsd;

    for (const [model, usage] of Object.entries(other.byModel)) {
      const perModel = (into.byModel[model] ??= {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
      perModel.calls += usage.calls;
      perModel.promptTokens += usage.promptTokens;
      perModel.completionTokens += usage.completionTokens;
      perModel.totalTokens += usage.totalTokens;
    }
  }
  return into;
}

/**
 * Estimate inference spend from token counts × published per-model rates.
 *
 * `rateFor` prices every `:free` model at 0, so the default configuration
 * estimates exactly $0 rather than "unpriced". A paid model with no entry in
 * the rate table also contributes 0 — the result is a floor, so treat a $0
 * estimate as meaningful only when every model in `byModel` is a `:free` one.
 */
export function estimateCostUsd(totals: UsageTotals): number {
  let cost = 0;
  for (const [model, usage] of Object.entries(totals.byModel)) {
    const rate = rateFor(model);
    if (!rate) continue;
    cost += (usage.promptTokens / 1_000_000) * rate.inputPerMTok;
    cost += (usage.completionTokens / 1_000_000) * rate.outputPerMTok;
  }
  // Sub-cent runs are normal; keep enough precision to stay meaningful.
  return Number(cost.toFixed(6));
}
