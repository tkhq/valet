/** The line that tells a person where a use-only secret can go, for example
 * "Only for api.example.com, in the authorization header as Bearer". */
export function useRuleText(use: { hosts: string[]; header: string; format: string }): string {
  const how = use.format === "{secret}" ? "" : ` as ${use.format.replace("{secret}", "").trim()}`;
  return `Only for ${use.hosts.join(", ")}, in the ${use.header} header${how}`;
}

/** "Used 3 times, last Nov 18, 2026" or "Not used yet". */
export function usesText(uses: { count: number; lastUsedAt: number | null }, formatDate: (ms: number) => string): string {
  if (uses.count === 0 || uses.lastUsedAt === null) return "Not used yet";
  return `Used ${uses.count} ${uses.count === 1 ? "time" : "times"}, last ${formatDate(uses.lastUsedAt)}`;
}
