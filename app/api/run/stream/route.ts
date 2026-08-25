import { NextResponse } from "next/server";
import * as z from "zod";
import { getSeenDomains, saveRun } from "@/src/lib/store";
import { runPipeline } from "@/src/pipeline/run";
import type { RunStats } from "@/src/pipeline/run";
import type { Icp, Lead, PipelineEvent } from "@/src/pipeline/types";

/**
 * SSE run endpoint. Wires `runPipeline`'s `onEvent` callback straight onto
 * the response stream so the client sees each pipeline step as it happens,
 * then closes with a `result` (or `error`) frame. This is the streaming
 * sibling of the Phase 1 `/api/run` endpoint — it does not change pipeline
 * behaviour, only how the same events are delivered.
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

/** Shape of every SSE `data:` frame this endpoint emits. Exported (type-only)
 * so the client can parse frames against the same contract. */
export type SseFrame =
  | { type: "event"; event: PipelineEvent }
  | {
      type: "result";
      icp: Icp;
      leads: Lead[];
      disqualified: Lead[];
      stats: RunStats;
    }
  | { type: "error"; message: string };

function sseLine(frame: SseFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

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

  const { agencyUrl, description, maxAngles, perAngle, maxCandidates } =
    parsed.data;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (frame: SseFrame) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseLine(frame)));
      };

      if (!process.env.OPENROUTER_API_KEY) {
        send({
          type: "error",
          message: "OPENROUTER_API_KEY is not set on the server.",
        });
        closed = true;
        controller.close();
        return;
      }

      const startedAt = Date.now();

      try {
        const excludeDomains = await getSeenDomains();

        const result = await runPipeline(
          { agencyUrl, description },
          {
            maxAngles,
            perAngle,
            maxCandidates,
            excludeDomains,
            onEvent: (event) => send({ type: "event", event }),
          },
        );

        await saveRun({
          id:
            typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `run_${startedAt}_${Math.random().toString(36).slice(2)}`,
          startedAt,
          icp: result.icp,
          leads: result.leads,
          disqualified: result.disqualified,
          stats: result.stats,
        });

        send({
          type: "result",
          icp: result.icp,
          leads: result.leads,
          disqualified: result.disqualified,
          stats: result.stats,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[/api/run/stream] pipeline failed:", err);
        send({ type: "error", message });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
