import { NextResponse } from "next/server";
import * as z from "zod";
import { setFeedback } from "@/src/lib/store";

export const dynamic = "force-dynamic";

const FeedbackRequestSchema = z.object({
  domain: z.string().trim().min(1),
  direction: z.enum(["up", "down"]),
});

/**
 * POST {domain, direction} — records a thumbs up/down for a lead's domain.
 * Posting the same direction twice clears it (a toggle), so the client can
 * treat a click as "set to this" without tracking prior state itself.
 */
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

  const parsed = FeedbackRequestSchema.safeParse(body);
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

  const { domain, direction } = parsed.data;
  const result = await setFeedback(domain, direction);

  return NextResponse.json({ domain, direction: result });
}
