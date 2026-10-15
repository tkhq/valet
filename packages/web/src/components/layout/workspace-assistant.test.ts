import { afterEach, describe, expect, it } from "vitest";
import { MutationObserver, QueryClient, onlineManager } from "@tanstack/react-query";
import { ENSURE_CONVERSATION_MUTATION } from "./workspace-assistant";

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("Ask Valet conversation request", () => {
  // With the default network mode, an offline open paused and never settled,
  // so the panel showed neither an error nor Retry.
  it("fails at once while the browser is offline, so the panel can offer Retry", async () => {
    onlineManager.setOnline(false);
    const observer = new MutationObserver(new QueryClient(), {
      ...ENSURE_CONVERSATION_MUTATION,
      mutationFn: () => Promise.reject(new Error("Failed to fetch")),
    });
    const settled = observer.mutate().then(() => "resolved", (error: Error) => error.message);
    const timeout = new Promise((resolve) => setTimeout(() => resolve("paused"), 200));
    expect(await Promise.race([settled, timeout])).toBe("Failed to fetch");
  });
});
