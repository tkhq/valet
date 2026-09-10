import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { qkArtifacts } from "./artifacts";

afterEach(() => vi.unstubAllGlobals());

describe("artifact workspace requests", () => {
  it("encodes owner and pagination together", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ artifacts: [], nextCursor: null })));
    vi.stubGlobal("fetch", fetchMock);
    await api.listArtifacts({ ownerType: "team", ownerId: "team & one" }, { limit: 50, cursor: "next+page" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/artifacts?ownerType=team&ownerId=team+%26+one&limit=50&cursor=next%2Bpage",
      expect.anything(),
    );
  });

  it("separates owner pages and legacy mine caches while keeping list invalidation", () => {
    const user = { ownerType: "user", ownerId: "u1" } as const;
    const team = { ownerType: "team", ownerId: "t1" } as const;
    const keys = [
      qkArtifacts.list(), qkArtifacts.list(undefined, true), qkArtifacts.list(user),
      qkArtifacts.list(user, undefined, { limit: 50 }),
      qkArtifacts.list(team, undefined, { limit: 50 }),
      qkArtifacts.list(team, undefined, { limit: 50, cursor: "next" }),
    ];
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
    for (const key of keys) expect(key.slice(0, 2)).toEqual(qkArtifacts.list());
  });
});
