import { describe, expect, it, vi } from "vitest";
import type { DeriveContext } from "@valet/engine";
import { linearGraphqlUrl, linearStatusResolver } from "./status-resolver.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fetchStub(body: unknown): typeof fetch {
  return vi.fn<typeof fetch>(async () => jsonResponse(body));
}

function makeCtx(fetchImpl: typeof fetch): DeriveContext {
  return {
    orgId: "org-1",
    appToken: async () => "token-1",
    fetch: fetchImpl,
  };
}

const WORKFLOW_STATES_RESPONSE = {
  data: {
    workflowStates: {
      nodes: [
        { id: "state-backlog", type: "backlog" },
        { id: "state-started", type: "started" },
      ],
    },
  },
};

describe("linearStatusResolver", () => {
  it("returns the status type for a known state id", async () => {
    const fetchImpl = fetchStub(WORKFLOW_STATES_RESPONSE);
    const ctx = makeCtx(fetchImpl);

    const status = await linearStatusResolver.resolve(ctx, { teamKey: "ENG", stateId: "state-backlog" });

    expect(status).toBe("backlog");
  });

  it("makes one GraphQL call for two lookups within the hour", async () => {
    const fetchImpl = fetchStub(WORKFLOW_STATES_RESPONSE);
    const ctx = makeCtx(fetchImpl);

    await linearStatusResolver.resolve(ctx, { teamKey: "ENG-CACHE", stateId: "state-backlog" });
    await linearStatusResolver.resolve(ctx, { teamKey: "ENG-CACHE", stateId: "state-started" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unknown state id", async () => {
    const fetchImpl = fetchStub(WORKFLOW_STATES_RESPONSE);
    const ctx = makeCtx(fetchImpl);

    const status = await linearStatusResolver.resolve(ctx, { teamKey: "ENG-UNKNOWN", stateId: "state-nope" });

    expect(status).toBeNull();
  });

  it("posts to LINEAR_API_URL when it is set (final review, item 16)", async () => {
    vi.stubEnv("LINEAR_API_URL", "https://linear.fixture");
    try {
      const fetchImpl = fetchStub(WORKFLOW_STATES_RESPONSE);
      await linearStatusResolver.resolve(makeCtx(fetchImpl), { teamKey: "ENG-ENV", stateId: "state-backlog" });
      expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe("https://linear.fixture/graphql");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("linearGraphqlUrl defaults to the public API", () => {
    expect(linearGraphqlUrl({})).toBe("https://api.linear.app/graphql");
  });
});
