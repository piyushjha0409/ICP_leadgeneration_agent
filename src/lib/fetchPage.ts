/**
 * Dependency-free page-text extraction. Used to ground the ICP stage in the
 * agency's own site and the scan stage in a candidate's homepage, so
 * "weak digital presence" judgements are based on real copy rather than the
 * model's imagination.
 */

const TIMEOUT_MS = 10_000;

/** A real browser UA — a lot of marketing sites 403 obvious bots. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Guard against multi-MB pages before we start running regexes over them. */
const MAX_HTML_CHARS = 1_500_000;

export type PageFetchSuccess = { url: string; text: string; title?: string };
export type PageFetchFailure = { url: string; error: string };
export type PageFetchResult = PageFetchSuccess | PageFetchFailure;

export function isPageFetchSuccess(
  result: PageFetchResult,
): result is PageFetchSuccess {
  return "text" in result;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Strip markup down to readable prose. Not a parser — deliberately. */
export function htmlToText(html: string): { text: string; title?: string } {
  let working = html.slice(0, MAX_HTML_CHARS);

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(working);
  const title = titleMatch
    ? collapse(decodeEntities(titleMatch[1] ?? "")) || undefined
    : undefined;

  const descMatch =
    /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(
      working,
    ) ??
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i.exec(
      working,
    );
  const description = descMatch
    ? collapse(decodeEntities(descMatch[1] ?? "")) || undefined
    : undefined;

  // Remove comments and any element whose text content is not prose.
  working = working.replace(/<!--[\s\S]*?-->/g, " ");
  working = working.replace(
    /<(script|style|noscript|svg|canvas|iframe|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  // A stray unclosed <script>/<style> would otherwise leak code into the text.
  working = working.replace(/<(script|style)\b[^>]*>[\s\S]*$/i, " ");

  // Preserve block structure as newlines before dropping tags.
  working = working.replace(/<br\s*\/?>/gi, "\n");
  working = working.replace(
    /<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|td|th|header|main|blockquote|figcaption)\s*>/gi,
    "\n",
  );
  working = working.replace(/<li\b[^>]*>/gi, "\n- ");
  working = working.replace(/<[^>]+>/g, " ");

  working = decodeEntities(working);

  const body = collapse(working);
  const lead = [title, description].filter(Boolean).join(" — ");
  const text = lead ? `${lead}\n\n${body}` : body;

  return { text, title };
}

function collapse(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    // Non-breaking and zero-width spaces that survive entity decoding.
    .replace(/[\u00a0\u200b\u2007\u202f\ufeff]/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Add a scheme when the caller passed a bare domain. */
function coerceUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Fetch a page and return readable text, truncated to `maxChars`.
 * Never throws — failures come back as `{ url, error }` so a dead candidate
 * site degrades one signal instead of the whole run.
 */
export async function fetchPageText(
  url: string,
  maxChars = 8000,
): Promise<PageFetchResult> {
  const target = coerceUrl(url);
  if (!target) return { url, error: "empty url" };

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return { url: target, error: `invalid url: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: target, error: `unsupported protocol: ${parsed.protocol}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      return {
        url: parsed.toString(),
        error: `http ${response.status} ${response.statusText}`.trim(),
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/|xml|json/i.test(contentType)) {
      return { url: parsed.toString(), error: `non-text content-type: ${contentType}` };
    }

    const html = await response.text();
    const { text, title } = htmlToText(html);

    if (!text) {
      return { url: parsed.toString(), error: "no readable text extracted" };
    }

    return {
      url: parsed.toString(),
      text: text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text,
      title,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "AbortError" || err.name === "TimeoutError"
          ? `timed out after ${TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return { url: parsed.toString(), error: message };
  } finally {
    clearTimeout(timer);
  }
}
