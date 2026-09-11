import { describe, expect, it, vi } from "vitest";
import { findPodEviction, sandboxEvictionApiAdapter, type SandboxEvictionApi } from "../src/eviction.js";

const now = Date.now();
const event = { podName: "pod", uid: "uid", reason: "Evicted", message: "docker-state exceeds 8Gi", timestamp: now };
function api(pod: Awaited<ReturnType<SandboxEvictionApi["getPod"]>>, events = [event]): SandboxEvictionApi {
  return { getPod: async () => pod, listEvents: async () => events };
}
describe("eviction evidence", () => {
  it("recognizes an evicted pod before its UID changes", async () => {
    await expect(findPodEviction(api({ uid: "uid", reason: "Evicted", message: event.message }), "ns", "pod", "uid", now)).resolves.toBe(event.message);
  });
  it("uses recent matching events after deletion", async () => {
    await expect(findPodEviction(api(null), "ns", "pod", "uid", now)).resolves.toBe(event.message);
  });
  it("does not blame a previous pod's eviction on its replacement", async () => {
    await expect(findPodEviction(api({ uid: "replacement" }), "ns", "pod", null, now)).resolves.toBeNull();
  });
  it.each([
    { ...event, uid: "another" },
    { ...event, podName: "another" },
    { ...event, reason: "Killing" },
    { ...event, timestamp: now - 11 * 60_000 },
  ])("ignores unrelated or stale evidence %j", async (other) => {
    await expect(findPodEviction(api(null, [other]), "ns", "pod", "uid", now)).resolves.toBeNull();
  });
  it("does not read old events for a healthy matching pod", async () => {
    const source = api({ uid: "uid" });
    source.listEvents = vi.fn(source.listEvents);
    await expect(findPodEviction(source, "ns", "pod", "uid", now)).resolves.toBeNull();
    expect(source.listEvents).not.toHaveBeenCalled();
  });
});

it("projects eviction events and uses namespace and pod filters", async () => {
  const readNamespacedPod = vi.fn(async () => ({ metadata: { uid: "uid" }, status: { reason: "Evicted", message: event.message } }));
  const listNamespacedEvent = vi.fn(async () => ({ items: [{
    metadata: {},
    involvedObject: { kind: "Pod", name: "pod", uid: "uid" },
    reason: "Evicted", message: event.message,
    series: { count: 2, lastObservedTime: new Date(now) },
  }] }));
  const source = sandboxEvictionApiAdapter({ readNamespacedPod, listNamespacedEvent });
  await expect(source.getPod("ns", "pod")).resolves.toEqual({ uid: "uid", reason: "Evicted", message: event.message });
  await expect(source.listEvents("ns", "pod")).resolves.toEqual([event]);
  expect(listNamespacedEvent).toHaveBeenCalledWith({ namespace: "ns", fieldSelector: "involvedObject.kind=Pod,involvedObject.name=pod,reason=Evicted" });
});

it("treats only pod 404 as absent for event lookup", async () => {
  const source = sandboxEvictionApiAdapter({
    readNamespacedPod: async () => { throw { code: 404 }; },
    listNamespacedEvent: async () => ({ items: [] }),
  });
  await expect(source.getPod("ns", "pod")).resolves.toBeNull();
  const denied = sandboxEvictionApiAdapter({
    readNamespacedPod: async () => { throw { code: 403 }; },
    listNamespacedEvent: async () => ({ items: [] }),
  });
  await expect(denied.getPod("ns", "pod")).rejects.toEqual({ code: 403 });
});
