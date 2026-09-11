import { describe, expect, it } from "vitest";
import { PgProxyTransaction, PgRemoteSession } from "drizzle-orm/pg-proxy";
import { PgDialect } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "../schema/index.js";
import { lockTeamDeletionAccess } from "./team-deletion-access.js";

describe("captured team deletion authority", () => {
  it.each([
    { orgRole: "member", teamRole: undefined, expected: "hidden" },
    { orgRole: "member", teamRole: "member", expected: false },
    { orgRole: "member", teamRole: "admin", expected: true },
    { orgRole: "admin", teamRole: undefined, expected: true },
    { orgRole: undefined, teamRole: "admin", expected: "hidden" },
  ])("uses locked roles: $orgRole / $teamRole", async ({ orgRole, teamRole, expected }) => {
    // Simulate an admin membership appearing immediately after the first
    // team-membership read returned no row. A second read would see it,
    // but that new authority has not been locked against another deletion.
    let membershipReads = 0;
    const dialect = new PgDialect({ casing: "snake_case" });
    const session = new PgRemoteSession<typeof schema, ExtractTablesWithRelations<typeof schema>>(async (query) => {
      if (query.includes('from "teams"')) return { rows: [["team-1"]] };
      if (query.includes('from "org_members"')) return { rows: orgRole ? [[orgRole]] : [] };
      if (query.includes('from "team_members"')) {
        membershipReads++;
        return { rows: membershipReads > 1 ? [["admin"]] : teamRole ? [[teamRole]] : [] };
      }
      return { rows: [] };
    }, dialect, undefined);
    const tx = new PgProxyTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>(dialect, session, undefined);
    const result = lockTeamDeletionAccess(tx, { orgId: "org-1", userId: "user-1" }, "team-1");
    if (expected === "hidden") await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
    else await expect(result).resolves.toBe(expected);
    expect(membershipReads).toBe(orgRole ? 1 : 0);
  });
});
