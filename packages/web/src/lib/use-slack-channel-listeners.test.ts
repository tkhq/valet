// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { ListenerWorkerDouble } from "./slack-listeners-worker.test-utils";
import * as matching from "./slack-listeners";
import { SLACK_LISTENER_DEADLINE_MS, useSlackChannelListeners } from "./use-slack-channel-listeners";

function rule(overrides: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id: "r", name: "Replies", ownerType: "team", ownerId: "a", eventKeys: ["slack.app_mention"],
    filters: [{ field: "channel_name", op: "regex", value: "^lead-" }],
    target: { kind: "assistant", assistant: "team", teamId: "a" }, enabled: true,
    createdBy: "u", createdAt: 1, updatedAt: 1, ...overrides,
  };
}
const catalog = [{ id: "C1", name: "lead-sales" }, { id: "C2", name: "general" }];
function currentWorker() {
  const worker = ListenerWorkerDouble.instances.at(-1);
  if (!worker) throw new Error("Expected a coverage worker");
  return worker;
}

beforeEach(() => {
  vi.useFakeTimers();
  ListenerWorkerDouble.instances = [];
  ListenerWorkerDouble.autoRespond = false;
  vi.stubGlobal("Worker", ListenerWorkerDouble);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSlackChannelListeners", () => {
  it.each(["eq", "prefix"] as const)("keeps %s matching synchronous", (op) => {
    const { result } = renderHook(() => useSlackChannelListeners([
      rule({ filters: [{ field: "channel_name", op, value: op === "eq" ? "lead-sales" : "lead-" }] }),
    ], "a", () => "Alpha", catalog));
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") throw new Error("Expected synchronous coverage");
    expect(result.current.listeners.get("C1")).toEqual({ kind: "this-team" });
    expect(result.current.listeners.has("C2")).toBe(false);
    expect(ListenerWorkerDouble.instances).toHaveLength(0);
  });

  it.each([
    rule({ enabled: false }),
    rule({ eventKeys: ["github.push"] }),
    rule({ filters: [{ field: "user", op: "regex", value: "^U" }] }),
  ])("does not start a worker for irrelevant regex in $id", (subscription) => {
    const { result } = renderHook(() => useSlackChannelListeners([subscription], "a", () => "Alpha", catalog));
    expect(result.current.status).toBe("ready");
    expect(ListenerWorkerDouble.instances).toHaveLength(0);
  });

  it.each(["regex", "not_regex"] as const)("never executes %s on the UI thread", (op) => {
    const match = vi.spyOn(matching, "slackChannelListeners").mockImplementation(() => { throw new Error("UI thread must not match regex"); });
    const { result } = renderHook(() => useSlackChannelListeners([
      rule({ filters: [{ field: "channel_name", op, value: "^(a|aa)+$" }] }),
    ], "a", () => "Alpha", [{ id: "C1", name: "a".repeat(45) + "!" }]));
    expect(result.current.status).toBe("checking");
    expect(match).not.toHaveBeenCalled();
    expect(currentWorker().request?.catalog[0]?.name).toBe("a".repeat(45) + "!");
  });

  it("passes cloneable names, resolves matches, and terminates the worker", () => {
    const { result } = renderHook(() => useSlackChannelListeners([rule({ ownerId: "b" })], "a", () => "Design", catalog));
    const worker = currentWorker();
    expect(structuredClone(worker.request)?.teamNames).toEqual({ b: "Design" });
    act(() => worker.respond());
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") throw new Error("Expected resolved coverage");
    expect(result.current.listeners.get("C1")).toEqual({ kind: "other", owner: "Design's Valet" });
    expect(result.current.listeners.has("C2")).toBe(false);
    expect(worker.terminated).toBe(true);
    act(() => vi.advanceTimersByTime(SLACK_LISTENER_DEADLINE_MS));
    expect(result.current.status).toBe("ready");
  });

  it("terminates overdue work, stays in error on late results, and retries", () => {
    const { result } = renderHook(() => useSlackChannelListeners([rule()], "a", () => "Alpha", catalog));
    const first = currentWorker();
    act(() => vi.advanceTimersByTime(SLACK_LISTENER_DEADLINE_MS));
    expect(result.current.status).toBe("error");
    expect(first.terminated).toBe(true);
    act(() => first.send({ kind: "ready", listeners: [] }));
    expect(result.current.status).toBe("error");
    act(() => result.current.retry());
    const second = currentWorker();
    expect(second).not.toBe(first);
    expect(result.current.status).toBe("checking");
    act(() => first.send({ kind: "error" }));
    expect(result.current.status).toBe("checking");
    act(() => second.respond());
    expect(result.current.status).toBe("ready");
  });

  it.each(["error", "messageerror", "response-error"])("blocks on worker %s", (failure) => {
    const { result } = renderHook(() => useSlackChannelListeners([rule()], "a", () => "Alpha", catalog));
    const worker = currentWorker();
    act(() => {
      if (failure === "error") worker.onerror?.(new ErrorEvent("error", { message: "worker failed" }));
      else if (failure === "messageerror") worker.onmessageerror?.();
      else worker.send({ kind: "error" });
    });
    expect(result.current.status).toBe("error");
    expect(worker.terminated).toBe(true);
  });

  it("blocks if the worker cannot start", () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("CSP refused worker"); } });
    const { result } = renderHook(() => useSlackChannelListeners([rule()], "a", () => "Alpha", catalog));
    expect(result.current.status).toBe("error");
  });

  it("terminates on unmount and ignores pending completion", () => {
    const { unmount } = renderHook(() => useSlackChannelListeners([rule()], "a", () => "Alpha", catalog));
    const worker = currentWorker();
    unmount();
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    act(() => worker.respond());
    expect(ListenerWorkerDouble.instances).toHaveLength(1);
  });

  it("invalidates resolved coverage immediately when the catalog changes, and ignores stale workers", () => {
    const { result, rerender } = renderHook(({ channels }) => useSlackChannelListeners([rule()], "a", () => "Alpha", channels), {
      initialProps: { channels: catalog },
    });
    const first = currentWorker();
    act(() => first.respond());
    expect(result.current.status).toBe("ready");
    rerender({ channels: [{ id: "C1", name: "general" }] });
    const second = currentWorker();
    expect(result.current.status).toBe("checking");
    act(() => first.respond());
    expect(result.current.status).toBe("checking");
    act(() => second.respond());
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") throw new Error("Expected renamed coverage");
    expect(result.current.listeners.size).toBe(0);
  });

  it("ignores pending results when rules or the selected team change", () => {
    const { result, rerender } = renderHook(({ teamId, subscriptions }) => useSlackChannelListeners(subscriptions, teamId, () => "Alpha", catalog), {
      initialProps: { teamId: "a", subscriptions: [rule()] },
    });
    const first = currentWorker();
    rerender({ teamId: "b", subscriptions: [rule({ filters: [{ field: "channel_name", op: "regex", value: "^general$" }] })] });
    expect(first.terminated).toBe(true);
    act(() => first.respond());
    expect(result.current.status).toBe("checking");
    act(() => currentWorker().respond());
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") throw new Error("Expected current-team coverage");
    expect(result.current.listeners.has("C1")).toBe(false);
    expect(result.current.listeners.get("C2")).toEqual({ kind: "other", owner: "Alpha's Valet" });
  });

  it("does not restart workers for equivalent inputs or callback identities", () => {
    const { rerender } = renderHook(() => useSlackChannelListeners([rule()], "a", () => "Alpha", [...catalog]));
    rerender();
    expect(ListenerWorkerDouble.instances).toHaveLength(1);
  });
});
