import type { ChatMessages } from "@openrouter/sdk/models";
import { MODELS, PIPELINE_DEFAULTS } from "@/src/config";
import { fetchPageText, isPageFetchSuccess } from "@/src/lib/fetchPage";
import { structuredChat } from "@/src/lib/structured";
import type { UsageTotals } from "@/src/lib/usage";
import { IcpSchema, type Icp, type OnEvent } from "@/src/pipeline/types";

/**
 * Stage 1 — turn "who we are" into "who we should sell to".
 *
 * The ICP produced here is the single input every later stage is anchored to,
 * so it is written to be *searchable*: concrete industries, size bands and
 * geographies that a web query can actually target, not agency-brochure prose.
 */

export type DeriveIcpInput = {
  agencyUrl?: string;
  description?: string;
};

export type DeriveIcpOptions = {
  onEvent?: OnEvent;
  /** Characters of the agency site to feed the model. */
  pageChars?: number;
};

export type IcpStageResult = {
  icp: Icp;
  usage: UsageTotals;
  /** Text pulled from the agency's own site, when a URL was supplied. */
  agencySiteText?: string;
  agencySiteError?: string;
};

/**
 * The ICP rendered verbatim for downstream prompts. Every later stage quotes
 * this block, so hunt/scan/qualify are all reasoning about the same target.
 */
export function formatIcpBlock(icp: Icp): string {
  return [
    "=== IDEAL CUSTOMER PROFILE (verbatim — this is the target) ===",
    `Industry / vertical: ${icp.industry}`,
    `Company size: ${icp.companySize}`,
    `Geography: ${icp.geography}`,
    `Services the agency sells them: ${icp.services.join(", ")}`,
    `Pain the agency solves: ${icp.painSolved}`,
    `Disqualifiers (never a fit): ${icp.disqualifiers.join("; ")}`,
    "=== END IDEAL CUSTOMER PROFILE ===",
  ].join("\n");
}

export const ICP_SYSTEM_PROMPT = `You are a B2B demand-generation strategist. You define Ideal Customer Profiles for marketing agencies.

Your output describes the agency's BUYERS — the companies the agency should sell its services to. It never describes the agency itself. This is the most common mistake; do not make it.

An ICP is only useful if a researcher can take it and run web searches that surface named companies. So every field must be concrete and checkable from the outside:
- Prefer "seed to Series A B2B SaaS, 10-80 employees, US and UK" over "innovative growth-stage technology companies".
- Name real industry categories and sub-verticals, not adjectives.
- Size must be an employee and/or funding-stage band.
- Geography must be named regions or countries.

Infer sensibly from whatever evidence you are given. If the agency's positioning is vague, choose the tightest defensible profile implied by its services and pricing level rather than hedging — a narrow ICP that can be searched beats a broad one that cannot.`;

/** Field-by-field contract, restated in prose so the model fills each with the right *kind* of content. */
export const ICP_FIELD_GUIDE = `Field guide:
- industry: the buyer's industry and sub-vertical, comma-separated. Include funding stage or business model when it defines the buyer.
- companySize: an employee-count band, plus funding stage or revenue band if relevant. e.g. "10-100 employees, post-seed to Series B".
- geography: named countries/regions where the agency can realistically serve and sell. e.g. "United States and Canada, English-speaking".
- services: the agency's services that this buyer actually needs. 3-6 short items, each a service name, not a sentence.
- painSolved: 1-2 sentences on the specific commercial pain this buyer feels that the agency removes. Written from the buyer's point of view, in their language.
- disqualifiers: 3-6 concrete exclusion rules used to reject bad-fit companies later. Each must be checkable from public information. Include at least the obvious structural ones (e.g. other marketing agencies, companies too large to need an outside team, wrong geography, wrong business model).`;

export function buildIcpUserPrompt(
  input: DeriveIcpInput,
  siteText?: string,
  siteError?: string,
): string {
  const sections: string[] = [
    "Define the Ideal Customer Profile for the marketing agency described below.",
    "",
    "=== AGENCY EVIDENCE (verbatim) ===",
  ];

  if (input.description?.trim()) {
    sections.push(
      "Self-description provided by the agency:",
      `"""${input.description.trim()}"""`,
    );
  }

  if (input.agencyUrl?.trim()) {
    sections.push("", `Agency website: ${input.agencyUrl.trim()}`);
    if (siteText) {
      sections.push(
        "Readable text extracted from that website:",
        `"""${siteText}"""`,
      );
    } else if (siteError) {
      sections.push(
        `(The website could not be read: ${siteError}. Work from the self-description and the domain name alone; do not invent site content.)`,
      );
    }
  }

  sections.push(
    "=== END AGENCY EVIDENCE ===",
    "",
    ICP_FIELD_GUIDE,
    "",
    "Base every field on the evidence above. Where the evidence is silent, make the most probable inference for an agency of this type and size — but never contradict the evidence.",
  );

  return sections.join("\n");
}

/**
 * Derive the ICP from an agency URL and/or a free-text description.
 * At least one of the two must be present.
 */
export async function deriveIcp(
  input: DeriveIcpInput,
  opts: DeriveIcpOptions = {},
): Promise<IcpStageResult> {
  const { onEvent } = opts;
  const hasUrl = Boolean(input.agencyUrl?.trim());
  const hasDescription = Boolean(input.description?.trim());

  if (!hasUrl && !hasDescription) {
    throw new Error("deriveIcp requires an agencyUrl, a description, or both.");
  }

  let siteText: string | undefined;
  let siteError: string | undefined;

  if (hasUrl) {
    const url = input.agencyUrl!.trim();
    onEvent?.({ stage: "icp", message: `Reading ${url}` });

    const page = await fetchPageText(
      url,
      opts.pageChars ?? PIPELINE_DEFAULTS.agencyPageChars,
    );

    if (isPageFetchSuccess(page)) {
      siteText = page.text;
      onEvent?.({
        stage: "icp",
        message: `Read ${page.text.length} characters from ${page.url}`,
        data: { url: page.url, title: page.title },
      });
    } else {
      siteError = page.error;
      onEvent?.({
        stage: "icp",
        message: `Could not read ${page.url}: ${page.error}`,
        data: { url: page.url, error: page.error },
      });
    }
  }

  onEvent?.({ stage: "icp", message: "Deriving the ideal customer profile" });

  const messages: ChatMessages[] = [
    { role: "system", content: ICP_SYSTEM_PROMPT },
    { role: "user", content: buildIcpUserPrompt(input, siteText, siteError) },
  ];

  const { value: icp, usage } = await structuredChat(
    MODELS.strategist,
    messages,
    IcpSchema,
    { schemaName: "Icp", temperature: 0.3, maxTokens: 2000 },
  );

  onEvent?.({
    stage: "icp",
    message: `ICP: ${icp.industry} — ${icp.companySize} — ${icp.geography}`,
    data: icp,
  });

  return { icp, usage, agencySiteText: siteText, agencySiteError: siteError };
}
