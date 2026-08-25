import { NextResponse } from "next/server";
import * as z from "zod";
import { runPipeline } from "@/src/pipeline/run";

/**
 * Temporary Phase 1 endpoint: runs the whole pipeline and returns the final
 * JSON in one response. Phase 2 replaces this with an SSE stream fed by the
 * same `onEvent` callback.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Six stages, four of them web-searching; the default serverless ceiling is
// far too low.
export const maxDuration = 300;

const RunRequestSchema = z
  .object({
    agencyUrl: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    maxAngles: z.number().int().min(1).max(12).optional(),
    perAngle: z.number().int().min(1).max(10).optional(),
    maxCandidates: z.number().int().min(1).max(40).optional(),
  })
  .refine((body) => Boolean(body.agencyUrl || body.description), {
    message: "Provide at least one of `agencyUrl` or `description`.",
  });

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = RunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request body.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const { agencyUrl, description, maxAngles, perAngle, maxCandidates } =
    parsed.data;

  try {
    const result = await runPipeline(
      { agencyUrl, description },
      { maxAngles, perAngle, maxCandidates },
    );

    return NextResponse.json({
      icp: result.icp,
      leads: result.leads,
      disqualified: result.disqualified,
      candidates: result.candidates,
      events: result.events,
      warnings: result.warnings,
      stats: {
        durationMs: result.stats.durationMs,
        perStage: result.stats.perStage,
        usage: result.stats.usage,
        estCostUsd: result.stats.estCostUsd,
        reportedCostUsd: result.stats.reportedCostUsd,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[/api/run] pipeline failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
