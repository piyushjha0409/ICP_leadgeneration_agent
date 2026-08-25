import { z } from "zod";

/**
 * Ideal Customer Profile — describes the kind of company rainmaker should be
 * hunting for.
 */
export const IcpSchema = z.object({
  industry: z.string(),
  companySize: z.string(),
  geography: z.string(),
  services: z.array(z.string()),
  painSolved: z.string(),
  disqualifiers: z.array(z.string()),
});
export type Icp = z.infer<typeof IcpSchema>;

/** A candidate company discovered while sourcing leads. */
export const CandidateSchema = z.object({
  name: z.string(),
  domain: z.string(),
  /** Where we found it — the evidence URL when we have one, else the angle. */
  source: z.string(),
  /** One line on why this company matches the ICP. */
  why: z.string().optional(),
  /** Canonical URL of the page the company was found on. */
  sourceUrl: z.string().optional(),
  /** Label of the hunt search angle that surfaced it. */
  discoveredVia: z.string().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** A buying signal observed for a candidate company. */
export const SignalSchema = z.object({
  type: z.enum([
    "funding",
    "new_marketing_leader",
    "hiring_marketing",
    "weak_digital_presence",
    "losing_to_competitors",
    "launch_or_rebrand",
  ]),
  evidence: z.string(),
  sourceUrl: z.string(),
  date: z.string().optional(),
});
export type Signal = z.infer<typeof SignalSchema>;

/** A fully-scored, contact-enriched lead ready for outreach. */
export const LeadSchema = z.object({
  company: CandidateSchema,
  signals: z.array(SignalSchema),
  score: z.number(),
  scoreReasons: z.array(z.string()),
  contact: z
    .object({
      name: z.string(),
      role: z.string(),
      email: z.string().optional(),
    })
    .optional(),
  pitchAngle: z.string().optional(),
  draftMessage: z.string().optional(),
  /** Set by the qualify stage when the company fails a hard ICP rule. */
  disqualified: z.boolean().optional(),
  disqualifiedReason: z.string().optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

/**
 * A candidate after the scan stage: same company, now carrying whatever
 * why-now signals we could evidence. `scanError` records a stage failure
 * without dropping the company from the run.
 */
export const ScannedCandidateSchema = z.object({
  company: CandidateSchema,
  signals: z.array(SignalSchema),
  /** Readable excerpt of the homepage, used to ground digital-presence calls. */
  homepageExcerpt: z.string().optional(),
  /** Why the homepage could not be read, when it could not. */
  homepageError: z.string().optional(),
  scanError: z.string().optional(),
});
export type ScannedCandidate = z.infer<typeof ScannedCandidateSchema>;

/** The stages of the pipeline, in order. */
export type PipelineStage =
  | "icp"
  | "hunt"
  | "scan"
  | "qualify"
  | "enrich"
  | "brief"
  | "run";

/**
 * Progress event emitted as the pipeline advances. Phase 1 collects these
 * into an array; Phase 2 forwards them over SSE.
 */
export type PipelineEvent = {
  stage: PipelineStage;
  message: string;
  data?: unknown;
  /** ms since the run started; filled in by the orchestrator. */
  at?: number;
};

export type OnEvent = (event: PipelineEvent) => void;
