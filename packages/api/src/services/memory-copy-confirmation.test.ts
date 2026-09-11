import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { memoryFiles, teams, teamMembers, orgMembers } from "../schema/index.js";
import { copyFileToTeam, copyFileFromTeam, readOwnFile, writeFile, type MemoryScope } from "./memory.js";

let db: AppDb;
let cleanup: () => Promise<void>;
const personal: MemoryScope = { owner: { type: "user", id: "u1" }, actorUserId: "u1" };
const team: MemoryScope = { owner: { type: "team", id: "team1" }, actorUserId: "u1" };
const input = { from: "notes/source.md", to: "notes/destination.md", teamId: "team1" };
beforeEach(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb; cleanup = boot.cleanup;
  await db.insert(orgMembers).values({ orgId: "org1", userId: "u1", role: "member" });
  await db.insert(teams).values({ id: "team1", orgId: "org1", name: "Team", createdAt: 1 });
  await db.insert(teamMembers).values({ teamId: "team1", userId: "u1", role: "admin" });
});
afterEach(async () => cleanup());

for (const direction of ["push", "pull"] as const) {
  describe(`memory ${direction} replacement`, () => {
    const copy = direction === "push" ? copyFileToTeam : copyFileFromTeam;
    const sourceScope = direction === "push" ? personal : team;
    const destinationScope = direction === "push" ? team : personal;
    const destinationWhere = and(eq(memoryFiles.ownerType, destinationScope.owner.type),
      eq(memoryFiles.ownerId, destinationScope.owner.id), eq(memoryFiles.path, input.to));
    async function seed() {
      await writeFile(db, sourceScope, { path: input.from, content: "# Source\nExact body", tags: ["source"], description: "Source description" });
      await writeFile(db, destinationScope, { path: input.to, content: "# Existing\nKeep until confirmed" });
      const file = await readOwnFile(db, destinationScope, input.to);
      if (!file) throw new Error("Missing seeded destination");
      return file;
    }
    async function conflictVersion(): Promise<string> {
      try { await copy(db, personal, input); } catch (err) {
        expect(err).toMatchObject({ code: "MEMORY_DESTINATION_EXISTS", destinationVersion: expect.any(String) });
        if (err && typeof err === "object" && "destinationVersion" in err && typeof err.destinationVersion === "string") return err.destinationVersion;
      }
      throw new Error("Expected collision revision");
    }
    it("leaves both files unchanged until confirmed, then replaces with destination version and creation time preserved", async () => {
      const before = await seed();
      const source = await readOwnFile(db, sourceScope, input.from);
      const expectedVersion = await conflictVersion();
      expect(await readOwnFile(db, destinationScope, input.to)).toEqual(before);
      const file = await copy(db, personal, { ...input, replacement: { expectedVersion } });
      expect(file).toMatchObject({ content: source?.content, tags: source?.tags, description: source?.description,
        version: before.version + 1, createdAt: before.createdAt, actorUserId: "u1", sourceId: null, sourceSessionId: "" });
      expect(await readOwnFile(db, sourceScope, input.from)).toEqual(source);
    });
    it("rejects an edited destination and returns a fresh revision", async () => {
      await seed();
      const expectedVersion = await conflictVersion();
      await writeFile(db, destinationScope, { path: input.to, content: "# New edit" });
      const edited = await readOwnFile(db, destinationScope, input.to);
      await expect(copy(db, personal, { ...input, replacement: { expectedVersion } })).rejects.toMatchObject({
        code: "MEMORY_DESTINATION_CHANGED", destinationVersion: expect.any(String),
      });
      expect(await conflictVersion()).not.toBe(expectedVersion);
      expect(await readOwnFile(db, destinationScope, input.to)).toEqual(edited);
    });
    it("rejects deleted and recreated destinations even when their integer version resets", async () => {
      const before = await seed();
      const expectedVersion = await conflictVersion();
      await db.delete(memoryFiles).where(destinationWhere);
      await expect(copy(db, personal, { ...input, replacement: { expectedVersion } })).rejects.toMatchObject({
        code: "MEMORY_DESTINATION_CHANGED", destinationVersion: null,
      });
      await writeFile(db, destinationScope, { path: input.to, content: "# Recreated" });
      expect((await readOwnFile(db, destinationScope, input.to))?.version).toBe(before.version);
      await expect(copy(db, personal, { ...input, replacement: { expectedVersion } })).rejects.toMatchObject({ code: "MEMORY_DESTINATION_CHANGED" });
      expect((await readOwnFile(db, destinationScope, input.to))?.content).toBe("# Recreated");
    });
    it("allows only one replacement with the same approved revision", async () => {
      await seed();
      const expectedVersion = await conflictVersion();
      const outcomes = await Promise.allSettled([copy(db, personal, { ...input, replacement: { expectedVersion } }),
        copy(db, personal, { ...input, replacement: { expectedVersion } })]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "MEMORY_DESTINATION_CHANGED" } });
    });
    it("rechecks membership before replacement and before exposing a revision", async () => {
      const before = await seed();
      const expectedVersion = await conflictVersion();
      await db.delete(teamMembers).where(eq(teamMembers.teamId, "team1"));
      await expect(copy(db, personal, { ...input, replacement: { expectedVersion } })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(copy(db, personal, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await readOwnFile(db, destinationScope, input.to)).toEqual(before);
    });
    it("does not reuse a revision for another owner/path", async () => {
      await seed();
      const expectedVersion = await conflictVersion();
      await writeFile(db, destinationScope, { path: "notes/another.md", content: "# Existing\nKeep until confirmed" });
      await expect(copy(db, personal, { ...input, to: "notes/another.md", replacement: { expectedVersion } }))
        .rejects.toMatchObject({ code: "MEMORY_DESTINATION_CHANGED" });
      expect((await readOwnFile(db, destinationScope, "notes/another.md"))?.content).toBe("# Existing\nKeep until confirmed");
    });
    it("does not trust an unchanged integer version when metadata changes", async () => {
      const before = await seed();
      const expectedVersion = await conflictVersion();
      await db.update(memoryFiles).set({ description: "Changed metadata" }).where(destinationWhere);
      await expect(copy(db, personal, { ...input, replacement: { expectedVersion } }))
        .rejects.toMatchObject({ code: "MEMORY_DESTINATION_CHANGED" });
      expect(await readOwnFile(db, destinationScope, input.to)).toMatchObject({ version: before.version, description: "Changed metadata" });
    });
    if (direction === "push") {
      it("does not let previous confirmation bypass a demoted push grant", async () => {
        const before = await seed();
        const expectedVersion = await conflictVersion();
        await db.update(teamMembers).set({ role: "member" }).where(eq(teamMembers.teamId, "team1"));
        await expect(copy(db, personal, { ...input, replacement: { expectedVersion } })).rejects.toThrow(/Ask a team admin/);
        expect(await readOwnFile(db, destinationScope, input.to)).toEqual(before);
      });
    }
    it("rejects protected library destinations even with replacement", async () => {
      await seed();
      await expect(copy(db, personal, { ...input, to: "lib/repo/source.md", replacement: { expectedVersion: "anything" } })).rejects.toThrow();
    });
  });
}
