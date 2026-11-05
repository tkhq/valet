import { describe, expect, it } from "vitest";
import { sendWidens, type ThreadOwner, type ThreadReaders } from "./thread-links.js";

const deps = {} as Parameters<typeof sendWidens>[0];
const at = { sessionId: "s", threadId: "t" };
const team: ThreadOwner = { ownerType: "team", ownerId: "team-a", orgId: "org" };
const from = (readers: ThreadReaders, owner = team) => ({ owner, at, readers });

describe("sendWidens", () => {
  it("lets a team thread reach a thread of the same team that keeps its channel gates", async () => {
    const source = from({ kind: "team", teamId: "team-a", channels: ["C1"] });
    expect(await sendWidens(deps, source, { kind: "team", teamId: "team-a", channels: ["C1", "C2"] })).toBe(false);
    expect(await sendWidens(deps, source, { kind: "team", teamId: "team-a", channels: [] })).toBe(true);
    expect(await sendWidens(deps, source, { kind: "team", teamId: "team-b", channels: ["C1"] })).toBe(true);
  });

  it("treats a person's thread as read by that person only", async () => {
    const mine = from({ kind: "person", userId: "u1" }, { ownerType: "user", ownerId: "u1", orgId: "org" });
    expect(await sendWidens(deps, mine, { kind: "person", userId: "u1" })).toBe(false);
    expect(await sendWidens(deps, mine, { kind: "person", userId: "u2" })).toBe(true);
    expect(await sendWidens(deps, mine, { kind: "team", teamId: "team-a", channels: [] })).toBe(true);
  });
});
