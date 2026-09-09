import { describe, expect, it, vi } from "vitest";
import { bootTestApi } from "./_setup.js";
import type { CreateSessionResponse, ListCommandsResponse, ListThreadsResponse } from "../wire/types.js";

describe("api integration: lazy session history", () => {
  it("serves cold thread and command metadata without reading persisted entries", async () => {
    const api = await bootTestApi();
    try {
      const response = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: "/tmp" }),
      });
      expect(response.status).toBe(201);
      const { id } = await response.json() as CreateSessionResponse;
      const base = `${api.baseUrl}/api/sessions/${id}`;
      const before = await (await fetch(`${base}/threads`)).json() as ListThreadsResponse;
      const thread = before.threads[0]!;
      // Persist breadth comparable to the reported assistant without loading it through the API.
      await api.providers.engineStore.appendEntries(id, thread.id, Array.from({ length: 1610 }, (_, index) => ({
        id: `history-${index}`, sessionId: id, threadId: thread.id, parentId: null,
        type: "message", role: "user", content: "old prompt",
        parts: [{ type: "text", text: "x".repeat(12_000) }], createdAt: index + 1,
      })));
      const reads = vi.spyOn(api.providers.engineStore, "getEntries");
      try {
        api.providers.engineHost.evictCache(id);
        const threadsResponse = await fetch(`${base}/threads`);
        expect(threadsResponse.status).toBe(200);
        expect(await threadsResponse.json()).toEqual(before);
        expect(reads).not.toHaveBeenCalled();

        api.providers.engineHost.evictCache(id);
        const commandsResponse = await fetch(`${base}/commands`);
        expect(commandsResponse.status).toBe(200);
        const commands = await commandsResponse.json() as ListCommandsResponse;
        expect(commands.commands.some((command) => command.name === "model")).toBe(true);
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
    } finally {
      await api.cleanup();
    }
  });
});
