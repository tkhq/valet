import { describe, expect, it } from "vitest";
import { ActiveViewers, HIDDEN_GRACE_MS, SILENT_MS, TYPING_WINDOW_MS } from "./active-viewers.js";

function harness() {
  let now = 1_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const viewers = new ActiveViewers({
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
  });
  const heard: Array<{ threadId: string; names: string[]; typing: string[] }> = [];
  viewers.subscribe("s1", (threadId, list) => heard.push({
    threadId, names: list.map((v) => v.name), typing: list.filter((v) => v.typing).map((v) => v.name),
  }));
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (timer.cancelled) continue;
      if (timer.at <= now) timer.fn();
      else timers.push(timer);
    }
  };
  return { viewers, heard, advance };
}

const dana = { userId: "u-dana", name: "Dana" };
const riley = { userId: "u-riley", name: "Riley" };

describe("ActiveViewers", () => {
  it("lists people as they open a thread and drops them when they switch or close", () => {
    const { viewers, heard } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    viewers.view({ id: "c2", sessionId: "s1", orgId: "o1", person: riley }, ["t1"], true);
    expect(viewers.viewersOf("s1", "t1").map((v) => v.name)).toEqual(["Dana", "Riley"]);
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t2"], true);
    expect(viewers.viewersOf("s1", "t1").map((v) => v.name)).toEqual(["Riley"]);
    viewers.leave("c2");
    expect(viewers.viewersOf("s1", "t1")).toEqual([]);
    expect(heard.filter((h) => h.threadId === "t1").map((h) => h.names)).toEqual([["Dana"], ["Dana", "Riley"], ["Riley"], []]);
  });

  it("counts one person once across tabs, typing if any tab types", () => {
    const { viewers, heard } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    viewers.view({ id: "c2", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    expect(viewers.viewersOf("s1", "t1")).toHaveLength(1);
    expect(heard).toHaveLength(1);
    viewers.type("c2", "t1", true);
    expect(viewers.viewersOf("s1", "t1")[0]?.typing).toBe(true);
    viewers.leave("c2");
    expect(viewers.viewersOf("s1", "t1")).toEqual([{ userId: "u-dana", name: "Dana", typing: false }]);
  });

  it("ends typing after the window, or at once when the person sends", () => {
    const { viewers, heard, advance } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    viewers.type("c1", "t1", true);
    advance(TYPING_WINDOW_MS - 1);
    expect(heard.at(-1)?.typing).toEqual(["Dana"]);
    advance(1);
    expect(heard.at(-1)?.typing).toEqual([]);
    viewers.type("c1", "t1", true);
    viewers.type("c1", "t1", false);
    expect(heard.at(-1)?.typing).toEqual([]);
  });

  it("keeps a background tab for the grace period, then drops it", () => {
    const { viewers, heard, advance } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], false);
    expect(viewers.viewersOf("s1", "t1")).toHaveLength(1);
    advance(HIDDEN_GRACE_MS);
    expect(viewers.viewersOf("s1", "t1")).toEqual([]);
    expect(heard.at(-1)?.names).toEqual([]);
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    expect(heard.at(-1)?.names).toEqual(["Dana"]);
  });

  it("ignores typing in a thread the tab does not show", () => {
    const { viewers, heard } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    viewers.type("c1", "t2", true);
    expect(heard).toHaveLength(1);
  });

  it("lists one organization's active threads by session", () => {
    const { viewers } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1", "t2"], true);
    viewers.view({ id: "c2", sessionId: "s2", orgId: "o1", person: riley }, ["t9"], true);
    viewers.view({ id: "c3", sessionId: "s3", orgId: "o2", person: riley }, ["t5"], true);
    expect([...viewers.activeThreads("o1")].map(([s, t]) => [s, [...t]])).toEqual([["s1", ["t1", "t2"]], ["s2", ["t9"]]]);
    expect([...viewers.activeThreads("o2").keys()]).toEqual(["s3"]);
  });

  it("returns only the threads a report adds", () => {
    const { viewers } = harness();
    expect(viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true)).toEqual(["t1"]);
    expect(viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true)).toEqual([]);
    expect(viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1", "t2"], true)).toEqual(["t2"]);
  });

  it("drops a connection that goes silent, and a heartbeat keeps it", () => {
    const { viewers, heard, advance } = harness();
    viewers.view({ id: "c1", sessionId: "s1", orgId: "o1", person: dana }, ["t1"], true);
    viewers.view({ id: "c2", sessionId: "s1", orgId: "o1", person: riley }, ["t1"], true);
    advance(SILENT_MS / 2);
    viewers.view({ id: "c2", sessionId: "s1", orgId: "o1", person: riley }, ["t1"], true);
    advance(SILENT_MS / 2);
    expect(viewers.viewersOf("s1", "t1").map((v) => v.name)).toEqual(["Riley"]);
    expect(heard.at(-1)?.names).toEqual(["Riley"]);
    expect(viewers.activeThreads("o1").get("s1")).toEqual(new Set(["t1"]));
  });
});
