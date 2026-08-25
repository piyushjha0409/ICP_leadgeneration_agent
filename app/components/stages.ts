import type { PipelineStage } from "@/src/pipeline/types";

/**
 * The six pipeline stages as the user sees them. One source for the setup
 * page's "what happens" strip, the run page's front line, and the wire's
 * stage column — so the same words appear everywhere a stage is named.
 */
export const STAGES: {
  stage: Exclude<PipelineStage, "run">;
  name: string;
  blurb: string;
}[] = [
  { stage: "icp", name: "Profile", blurb: "Reads your site and pins down who you sell to." },
  { stage: "hunt", name: "Hunt", blurb: "Plans four search angles and pulls in candidate companies." },
  { stage: "scan", name: "Scan", blurb: "Checks each one for a reason to buy now." },
  { stage: "qualify", name: "Score", blurb: "Ranks fit, pain and timing out of 100." },
  { stage: "enrich", name: "Contacts", blurb: "Finds the person to write to." },
  { stage: "brief", name: "Brief", blurb: "Writes the angle and a first email." },
];

export const STAGE_INDEX: Record<string, number> = Object.fromEntries(
  STAGES.map((item, index) => [item.stage, index]),
);

export function stageName(stage: PipelineStage): string {
  if (stage === "run") return "Run";
  return STAGES[STAGE_INDEX[stage] ?? -1]?.name ?? stage;
}

/** The six why-now signals, in the words the hero uses. */
export const SIGNAL_NAMES: Record<string, string> = {
  funding: "Fresh funding",
  new_marketing_leader: "New marketing leader",
  hiring_marketing: "Hiring for marketing",
  weak_digital_presence: "Weak digital presence",
  losing_to_competitors: "Losing to competitors",
  launch_or_rebrand: "Launch or rebrand",
};
