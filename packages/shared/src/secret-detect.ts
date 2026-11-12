/**
 * Finds API keys and other credentials pasted into message text, so the
 * composer can offer to save one as a secret and the api can keep one out
 * of the transcript.
 *
 * Two confidence levels:
 * - `known`: a provider's documented key format (prefix and length). The
 *   api's backstop acts on these only.
 * - `assigned`: `NAME_KEY=value` where the name says it is a credential. The
 *   composer asks the user about these; the backstop ignores them.
 *
 * No entropy-only rule: commit SHAs, UUIDs, and hashes are long random
 * strings too, and replacing them corrupts ordinary messages.
 */

export type SecretConfidence = "known" | "assigned";

export interface SecretCandidate {
  start: number;
  end: number;
  value: string;
  /** A short label, for example "OpenAI key". */
  label: string;
  /** The name to offer when saving, in env-var style. */
  suggestedName: string;
  confidence: SecretConfidence;
}

interface KnownFormat {
  label: string;
  name: string;
  pattern: RegExp;
}

/** Order matters where prefixes overlap: the Anthropic rule runs before the
 * OpenAI one, and a match claims its span. */
const KNOWN_FORMATS: KnownFormat[] = [
  { label: "Anthropic key", name: "ANTHROPIC_API_KEY", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "OpenAI key", name: "OPENAI_API_KEY", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { label: "GitHub token", name: "GITHUB_TOKEN", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { label: "GitHub token", name: "GITHUB_TOKEN", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { label: "GitLab token", name: "GITLAB_TOKEN", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { label: "Slack token", name: "SLACK_TOKEN", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { label: "AWS access key", name: "AWS_ACCESS_KEY_ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "Google API key", name: "GOOGLE_API_KEY", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "Stripe key", name: "STRIPE_SECRET_KEY", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { label: "Hugging Face token", name: "HF_TOKEN", pattern: /\bhf_[A-Za-z0-9]{30,}\b/g },
  {
    label: "Private key",
    name: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
  },
];

/** `OPENAI_API_KEY=...`, `export GH_TOKEN="..."`, `DB_PASSWORD: ...`. */
const ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|CREDENTIALS?))\s*[=:]\s*["']?([^\s"'`]{12,})["']?/g;

function overlaps(taken: SecretCandidate[], start: number, end: number): boolean {
  return taken.some((c) => start < c.end && end > c.start);
}

/** Every candidate in `text`, in order. A `secret://` reference is never one. */
export function detectSecrets(text: string): SecretCandidate[] {
  const found: SecretCandidate[] = [];
  for (const format of KNOWN_FORMATS) {
    for (const match of text.matchAll(format.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (overlaps(found, start, end)) continue;
      found.push({ start, end, value: match[0], label: format.label, suggestedName: format.name, confidence: "known" });
    }
  }
  for (const match of text.matchAll(ASSIGNMENT)) {
    const name = match[1]!;
    const value = match[2]!;
    if (value.startsWith("secret://") || value.startsWith("op://") || value.startsWith("$")) continue;
    const start = (match.index ?? 0) + match[0].indexOf(value, name.length);
    const end = start + value.length;
    if (overlaps(found, start, end)) continue;
    found.push({ start, end, value, label: "Credential", suggestedName: name, confidence: "assigned" });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** `text` with each candidate replaced by its replacement. */
export function replaceSecrets(text: string, replacements: { candidate: SecretCandidate; with: string }[]): string {
  let out = text;
  for (const { candidate, with: replacement } of [...replacements].sort((a, b) => b.candidate.start - a.candidate.start)) {
    out = out.slice(0, candidate.start) + replacement + out.slice(candidate.end);
  }
  return out;
}

/** A value shown to the user without revealing it: first and last 4. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
