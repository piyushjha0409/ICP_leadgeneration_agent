import * as z from "zod";
import type { ChatMessages } from "@openrouter/sdk/models";
import { chat, type ChatOptions, type ChatOutcome } from "@/src/lib/llm";
import { emptyUsage, recordUsage, type UsageTotals } from "@/src/lib/usage";

/**
 * Structured-output helper: ask a model for JSON, validate it against a zod
 * schema, and give the model exactly one chance to fix its own mistake before
 * giving up. Nothing downstream of this file ever sees unvalidated model
 * output.
 */

export class StructuredOutputError extends Error {
  readonly model: string;
  readonly attempts: number;
  readonly lastText: string;
  readonly usage: UsageTotals;

  constructor(args: {
    message: string;
    model: string;
    attempts: number;
    lastText: string;
    usage: UsageTotals;
  }) {
    super(args.message);
    this.name = "StructuredOutputError";
    this.model = args.model;
    this.attempts = args.attempts;
    this.lastText = args.lastText;
    this.usage = args.usage;
  }
}

export type StructuredOptions = ChatOptions & {
  /** Human-readable schema name, quoted to the model for clarity. */
  schemaName?: string;
  /** Override the auto-derived JSON Schema text. */
  schemaText?: string;
  /** Total attempts including the first. Default 2 (i.e. one retry). */
  maxAttempts?: number;
};

/**
 * Tokens are still billed for attempts that failed validation, so recover
 * them from the error rather than under-reporting the run's cost.
 */
export function usageFromError(err: unknown): UsageTotals | undefined {
  return err instanceof StructuredOutputError ? err.usage : undefined;
}

export type StructuredResult<T> = {
  value: T;
  usage: UsageTotals;
  /** Raw assistant text of the successful attempt. */
  text: string;
  attempts: number;
};

/** Render a zod schema as JSON Schema text to inline in the prompt. */
export function schemaToPromptText(schema: z.ZodType): string {
  try {
    const jsonSchema = z.toJSONSchema(schema, {
      io: "input",
      target: "draft-2020-12",
      // Types with no JSON Schema equivalent shouldn't abort the whole prompt.
      unrepresentable: "any",
    }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return JSON.stringify(jsonSchema, null, 2);
  } catch {
    return "";
  }
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Find the first balanced JSON object/array, ignoring braces inside strings. */
function findBalanced(text: string): string | null {
  const startIndex = (() => {
    const brace = text.indexOf("{");
    const bracket = text.indexOf("[");
    if (brace === -1) return bracket;
    if (bracket === -1) return brace;
    return Math.min(brace, bracket);
  })();
  if (startIndex === -1) return null;

  const open = text[startIndex] as "{" | "[";
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }

  return null;
}

/**
 * Pull JSON out of an assistant reply: handles bare JSON, ```json fences,
 * and JSON buried in a sentence of preamble. Throws when nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/^\ufeff/, "").trim();
  if (!cleaned) throw new Error("model returned an empty reply");

  const attempts: string[] = [];

  // Fenced block first — it is the most explicit signal of intent.
  const fence = /```(?:json|json5|javascript)?\s*\n?([\s\S]*?)```/i.exec(cleaned);
  if (fence?.[1]) attempts.push(fence[1].trim());

  attempts.push(cleaned);

  const balanced = findBalanced(cleaned);
  if (balanced) attempts.push(balanced);

  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // Second chance: strip trailing commas, a very common model slip.
      try {
        return JSON.parse(attempt.replace(/,(\s*[}\]])/g, "$1"));
      } catch {
        // try the next candidate
      }
    }
  }

  throw new Error(
    `no valid JSON found in reply (first 200 chars: ${cleaned.slice(0, 200)})`,
  );
}

function buildContractMessage(
  schema: z.ZodType,
  opts: StructuredOptions,
): ChatMessages {
  const schemaText = opts.schemaText ?? schemaToPromptText(schema);
  const name = opts.schemaName ? ` (\`${opts.schemaName}\`)` : "";

  const parts = [
    "OUTPUT CONTRACT — this overrides any formatting preference above.",
    "",
    "Reply with ONLY a single JSON value. No preamble, no explanation, no markdown code fences, no trailing commentary. Your entire reply must be parseable by JSON.parse.",
  ];

  if (schemaText) {
    parts.push(
      "",
      `It must validate against this JSON Schema${name}:`,
      schemaText,
    );
  }

  parts.push(
    "",
    "Rules:",
    "- Include every required property.",
    "- Omit optional properties you have no real value for. Never emit null, \"\", \"unknown\" or \"N/A\" as filler.",
    "- Do not add properties that are not in the schema, and do not wrap the result in an extra envelope key.",
    "- Strings are plain text, not markdown.",
    "- Arrays may be empty when you genuinely have nothing to report. An empty array is always better than an invented entry.",
  );

  return { role: "system", content: parts.join("\n") };
}

/**
 * Send `messages` to `model` and return a value validated by `schema`.
 * Retries once with the validation error appended; throws
 * `StructuredOutputError` after `maxAttempts` failures.
 */
export async function structuredChat<T>(
  model: string,
  messages: ChatMessages[],
  schema: z.ZodType<T>,
  opts: StructuredOptions = {},
): Promise<StructuredResult<T>> {
  const { schemaName, schemaText, maxAttempts = 2, ...chatOpts } = opts;
  const usage = emptyUsage();

  const conversation: ChatMessages[] = [
    ...messages,
    buildContractMessage(schema, { schemaName, schemaText }),
  ];

  let lastText = "";
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    let outcome: ChatOutcome;
    try {
      outcome = await chat(model, conversation, chatOpts);
    } catch (err) {
      // Transport/provider failures are not something the model can fix by
      // re-reading its own output — surface them immediately.
      throw new StructuredOutputError({
        message: `${model} request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        model,
        attempts: attempt,
        lastText,
        usage,
      });
    }

    recordUsage(usage, model, outcome.usage);
    lastText = outcome.text;

    try {
      const parsed = parseJsonLoose(outcome.text);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { value: result.data, usage, text: outcome.text, attempts: attempt };
      }
      lastError = `JSON did not match the schema — ${describeZodError(result.error)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxAttempts) {
      conversation.push(
        { role: "assistant", content: outcome.text || "(empty reply)" },
        {
          role: "user",
          content: [
            `Your previous reply could not be used. Error: ${lastError}`,
            "",
            "Reply again with ONLY the corrected JSON value. Do not apologise, do not explain, do not use code fences. Keep the real content you already gathered — fix only the structure.",
          ].join("\n"),
        },
      );
    }
  }

  throw new StructuredOutputError({
    message: `${model} failed to produce valid JSON${
      schemaName ? ` for ${schemaName}` : ""
    } after ${maxAttempts} attempts. Last error: ${lastError}`,
    model,
    attempts: maxAttempts,
    lastText,
    usage,
  });
}
