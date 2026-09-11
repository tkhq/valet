/** Parse SSO group claims for explicit join eligibility. This module writes no memberships. */
export type TeamClaim = { present: false } | { present: true; paths: string[] };

export function readTeamClaim(
  userInfo: Record<string, unknown>,
  claimName: string,
  assertedClaimName: string,
): TeamClaim {
  const raw = userInfo[claimName];

  if (Array.isArray(raw)) {
    const entries: unknown[] = raw;
    const strings = entries.filter((entry): entry is string => typeof entry === "string");
    if (strings.length !== entries.length) {
      console.warn(
        `team suggestions: claim '${claimName}' holds entries that are not group paths, so join eligibility ` +
          `could not be established. Configure the identity provider mapper to send each group as a full path ` +
          `string, such as '/platform'.`,
      );
      return { present: false };
    }
    const paths = strings.filter((path) => path.trim().length > 0);
    if (entries.length > 0 && paths.length === 0) {
      console.warn(
        `team suggestions: claim '${claimName}' names no group, so join eligibility could not be established. ` +
          `Configure the identity provider mapper to send each group as a full path string, ` +
          `such as '/platform'.`,
      );
      return { present: false };
    }
    return { present: true, paths };
  }

  if (raw === undefined || raw === null) {
    // Only a provider-supplied marker can establish that the claim was sent.
    const marker = Object.hasOwn(userInfo, assertedClaimName)
      ? userInfo[assertedClaimName]
      : undefined;
    // The marker proves the mapper set ran, so the missing group claim means
    // this user is in no groups. Without it, absence stays unreadable.
    if (marker !== undefined && marker !== null) return { present: true, paths: [] };
    return { present: false };
  }

  console.warn(
    `team suggestions: claim '${claimName}' is not a list, so join eligibility could not be established. ` +
      `Configure the identity provider mapper to send a multivalued group claim.`,
  );
  return { present: false };
}
