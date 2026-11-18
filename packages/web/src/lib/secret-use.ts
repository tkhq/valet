/** The line that tells a person where a use-only secret can go, for example
 * "Only for api.example.com, in the authorization header as Bearer". */
export function useRuleText(use: { hosts: string[]; header: string; format: string }): string {
  const how = use.format === "{secret}" ? "" : ` as ${use.format.replace("{secret}", "").trim()}`;
  return `Only for ${use.hosts.join(", ")}, in the ${use.header} header${how}`;
}
