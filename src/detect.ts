/**
 * Model-unavailable error class for opencode_local runs.
 *
 * Sources (see tests/fixtures/errors.json):
 *  - adapter source: "Configured OpenCode model is unavailable: <model>" (execute/models),
 *    "ProviderModelNotFoundError" (hello probe + run output)
 *  - OpenCode Zen free-tier failures: FreeTierError / "no longer free" / 403, 429, 5xx from Zen
 * Patterns are case-insensitive regexes, overridable in plugin config (`errorPatterns`).
 */
export const DEFAULT_ERROR_PATTERNS: readonly string[] = [
  "Configured OpenCode model is unavailable",
  "ProviderModelNotFoundError",
  "\\bmodel\\b.{0,80}\\b(not found|does not exist|is not available|no longer available|has been removed|was removed|deprecated|retired)\\b",
  "FreeTierError",
  "\\bfree\\b.{0,40}\\b(tier|usage|period|model)\\b.{0,60}\\b(ended|expired|exceeded|exhausted|removed|no longer)\\b",
  "no longer free",
  "\\bUnknownError\\b",
  "Unexpected server error",
  "(zen|opencode\\.ai).{0,120}\\b(403|429|5\\d\\d)\\b",
  "\\b(403|429|5\\d\\d)\\b.{0,120}(zen|opencode\\.ai)",
];

/** Host-enforced timeout (errorCode=timeout / "Timed out after Ns"): a hung opencode run on a removed model looks like this. */
export function isTimeout(errorCode: unknown, error: unknown): boolean {
  return String(errorCode ?? "").toLowerCase() === "timeout" || /\btimed out after\b/i.test(String(error ?? ""));
}

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try { out.push(new RegExp(p, "is")); } catch { /* invalid user regex: ignored, never throws in the event path */ }
  }
  return out;
}

/** Returns the first matching pattern source, or null. Input is error text plus error code. */
export function matchModelError(text: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) if (re.test(text)) return re.source;
  return null;
}

/** Truncate and strip anything that looks like a credential before the text goes into an issue body. */
export function sanitizeError(text: string, max: number): string {
  const cleaned = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b(sk|pk|ghp|gho|pcp|xox[a-z])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*)["']?[^\s"',}]{6,}/gi, "$1[redacted]");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…[truncated]` : cleaned;
}
