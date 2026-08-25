import type { SearchResult } from "./types";

/** Providers return snippets; this is a belt-and-braces cap on prompt size. */
export const MAX_SNIPPET_CHARS = 1200;

export function trimContent(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars
    ? `${collapsed.slice(0, maxChars)}…`
    : collapsed;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Shape-check one raw result rather than trusting the response body. Anything
 * without an http(s) URL is dropped — a citation the stages cannot verify is
 * worth nothing.
 */
export function toSearchResult(
  raw: { url?: unknown; title?: unknown; content?: unknown },
  maxChars: number = MAX_SNIPPET_CHARS,
): SearchResult | null {
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return null;

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const content = typeof raw.content === "string" ? raw.content : "";

  return { title: title || url, url, content: trimContent(content, maxChars) };
}

/** The message callers see for a failed `fetch`. */
export function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError"
      ? `search timed out after ${timeoutMs}ms`
      : err.message;
  }
  return String(err);
}

/**
 * Body excerpt for a non-2xx error message. Prefers a JSON `error` field
 * (both providers send one), else the first 200 chars of the raw body.
 */
export async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let detail = text;
  try {
    const parsed: unknown = JSON.parse(text);
    const message = asRecord(parsed)?.error;
    if (typeof message === "string" && message.trim()) detail = message;
  } catch {
    // not JSON — use the raw text
  }
  const compact = detail.replace(/\s+/g, " ").trim().slice(0, 200);
  return compact ? ` — ${compact}` : "";
}
