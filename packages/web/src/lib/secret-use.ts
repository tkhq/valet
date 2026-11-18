import { detectSecrets } from "@valet/shared";

/** The line that tells a person where a use-only secret can go, for example
 * "Only for api.example.com, in the authorization header as Bearer". */
export function useRuleText(use: { hosts: string[]; header: string; format: string }): string {
  const how = use.format === "{secret}" ? "" : ` as ${use.format.replace("{secret}", "").trim()}`;
  return `Only for ${use.hosts.join(", ")}, in the ${use.header} header${how}`;
}

/** Where a known provider key goes, keyed by the detector's label. A match
 * only pre-fills the Settings form; the person confirms by saving. */
const USE_DEFAULTS: Record<string, { host: string; header: "bearer" | "apiKey" }> = {
  "Anthropic key": { host: "api.anthropic.com", header: "apiKey" },
  "OpenAI key": { host: "api.openai.com", header: "bearer" },
  "GitHub token": { host: "api.github.com", header: "bearer" },
  "GitLab token": { host: "gitlab.com", header: "bearer" },
  "Slack token": { host: "slack.com", header: "bearer" },
  "Stripe key": { host: "api.stripe.com", header: "bearer" },
  "Hugging Face token": { host: "huggingface.co", header: "bearer" },
};

/** The host and header to pre-fill for a pasted value, or null when the value
 * is not one whole known key. */
export function useDefaultsFor(value: string): { host: string; header: "bearer" | "apiKey" } | null {
  const trimmed = value.trim();
  const [match] = detectSecrets(trimmed);
  if (!match || match.confidence !== "known" || match.value !== trimmed) return null;
  return USE_DEFAULTS[match.label] ?? null;
}

/** "Used 3 times, last Nov 18, 2026" or "Not used yet". */
export function usesText(uses: { count: number; lastUsedAt: number | null }, formatDate: (ms: number) => string): string {
  if (uses.count === 0 || uses.lastUsedAt === null) return "Not used yet";
  return `Used ${uses.count} ${uses.count === 1 ? "time" : "times"}, last ${formatDate(uses.lastUsedAt)}`;
}
