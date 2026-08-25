import { NextResponse } from "next/server";
import { getFeedback, getLatestRun } from "@/src/lib/store";

export const dynamic = "force-dynamic";

/** GET — the latest saved run plus the feedback map, or `{empty: true}`. */
export async function GET() {
  const [run, feedback] = await Promise.all([getLatestRun(), getFeedback()]);

  if (!run) {
    return NextResponse.json({ empty: true, feedback });
  }

  return NextResponse.json({
    empty: false,
    id: run.id,
    startedAt: run.startedAt,
    icp: run.icp,
    leads: run.leads,
    disqualified: run.disqualified,
    stats: run.stats,
    feedback,
  });
}
