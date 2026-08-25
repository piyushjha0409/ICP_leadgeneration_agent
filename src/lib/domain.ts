/**
 * Domain helpers shared by hunt (dedupe), scan (homepage fetch) and qualify
 * (matching model output back to candidates). Deliberately string-only — no
 * public-suffix list, no dependency.
 */

/**
 * Reduce anything domain-ish to a bare comparable host:
 * `https://WWW.Acme.com/pricing?x=1` -> `acme.com`.
 * Returns "" when nothing host-like can be recovered.
 */
export function normalizeDomain(input: string | undefined | null): string {
  if (!input) return "";

  let value = input.trim().toLowerCase();
  if (!value) return "";

  // Drop scheme, credentials, path, query and fragment.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^[^/@\s]*@/, "");
  value = value.split(/[/?#]/)[0] ?? "";
  value = value.replace(/:\d+$/, "");
  value = value.replace(/^www\d*\./, "");
  value = value.replace(/\.+$/, "");

  // A bare host must have a dot and no whitespace; otherwise the model gave
  // us a company name rather than a domain.
  if (!value.includes(".") || /\s/.test(value)) return "";
  return value;
}

/** Normalized company name for fallback dedupe when a domain is missing. */
export function normalizeName(input: string | undefined | null): string {
  if (!input) return "";
  return input
    .trim()
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|plc|sa|ag|srl|pty|oy|ab)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Best-effort https homepage URL for a domain. "" when un-derivable. */
export function homepageUrl(domain: string | undefined | null): string {
  const host = normalizeDomain(domain);
  return host ? `https://${host}` : "";
}

/**
 * True when two domains/URLs belong to the same site — equal hosts, or one a
 * subdomain of the other (`news.acme.com` ~ `acme.com`). Deliberately a
 * suffix test rather than a registrable-domain reduction: with no public
 * suffix list, reducing `acme.co.uk` to `co.uk` would match every unrelated
 * British site, which is exactly the false positive this guards against.
 */
export function isSameSite(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const left = normalizeDomain(a);
  const right = normalizeDomain(b);
  if (!left || !right) return false;
  return (
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
  );
}

/**
 * True when `url` sits on one of `domains`. Used to enforce that a model's
 * cited sourceUrl came from the search results it was actually given, rather
 * than from its memory.
 */
export function matchesAnyDomain(
  url: string | undefined | null,
  domains: Iterable<string>,
): boolean {
  const host = normalizeDomain(url);
  if (!host) return false;
  for (const domain of domains) {
    if (isSameSite(host, domain)) return true;
  }
  return false;
}

/** True when the string parses as an http(s) URL. */
export function isHttpUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
