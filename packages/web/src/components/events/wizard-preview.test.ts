import type { EventSubscriptionWire } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import type { RoutineLike } from "~/components/presence/sentences";
import { partsText } from "~/components/presence/sentences";
import { wizardSentenceParts, wizardWhenParts, type WhenService } from "./wizard-preview";

const workflows = [{ id: "wf-1", name: "Triage failures" }];
const threads = { "t-ci": { title: "Platform CI" } };

/** A draft line the way the editor builds it from its Create body. */
function draftLine(over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id: "draft",
    name: "",
    ownerType: "user",
    ownerId: "draft",
    eventKeys: [],
    filters: [],
    target: { kind: "assistant", assistant: "user", follow: true, thread: { mode: "new" } },
    enabled: true,
    createdBy: "draft",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function sentence(sub: EventSubscriptionWire, service: WhenService = "slack"): string {
  return partsText(wizardSentenceParts({ kind: "presence", sub, service }, undefined, workflows, threads));
}

function routineSentence(routine: RoutineLike): string {
  return partsText(wizardSentenceParts({ kind: "routine", routine }, undefined, workflows, threads));
}

const INCIDENTS = { field: "channel", op: "eq" as const, value: "C900", label: "#incidents" };
const ACME_API = { field: "repo", op: "eq" as const, value: "acme/api", label: "acme/api" };

describe("wizardSentenceParts", () => {
  it("reads a reply in a place", () => {
    expect(sentence(draftLine({ eventKeys: ["slack.app_mention"], filters: [INCIDENTS] }))).toBe(
      "When you mention Valet in #incidents, reply in a new thread.",
    );
  });

  it("reads you for a personal and an org mention line, and someone for a team line", () => {
    const keys = ["slack.app_mention"];
    expect(sentence(draftLine({ eventKeys: keys, filters: [INCIDENTS], target: { kind: "assistant", assistant: "org", follow: true, thread: { mode: "new" } } }))).toBe(
      "When you mention Valet in #incidents, reply in a new thread.",
    );
    expect(sentence(draftLine({ eventKeys: keys, filters: [INCIDENTS], target: { kind: "assistant", assistant: "team", teamId: "sre", follow: true, thread: { mode: "new" } } }))).toBe(
      "When someone mentions Valet in #incidents, reply in a new thread.",
    );
    expect(sentence(draftLine({ eventKeys: keys, target: { kind: "workflow", workflowId: "wf-1" } }))).toBe(
      "When you mention Valet in any channel, run Triage failures.",
    );
  });

  it("marks the place and the workflow as tokens", () => {
    const parts = wizardSentenceParts(
      { kind: "presence", sub: draftLine({ filters: [ACME_API], target: { kind: "workflow", workflowId: "wf-1" } }), service: "github" },
      undefined, workflows, threads,
    );
    expect(parts).toEqual([
      { kind: "text", text: "When something happens on " },
      { kind: "place", text: "acme/api", service: "github", subject: "github:acme/api" },
      { kind: "text", text: ", run " },
      { kind: "workflow", text: "Triage failures", id: "wf-1" },
      { kind: "text", text: "." },
    ]);
  });

  it("names the service when GitHub has no event yet", () => {
    expect(sentence(draftLine({ target: { kind: "assistant", assistant: "user", follow: false, thread: { mode: "own" } } }), "github")).toBe(
      "When something happens on GitHub, work in its own thread.",
    );
  });

  it("reads picked events with the shared renderer", () => {
    expect(sentence(draftLine({
      eventKeys: ["github.check_run.completed"],
      filters: [ACME_API],
      target: { kind: "assistant", assistant: "user", follow: false, thread: { mode: "subject" }, appearance: { displayName: "CI bot" } },
    }), "github")).toBe("When a check completes on acme/api, work in one thread per pull request, as CI bot.");
  });

  it("reads a routine, and an empty schedule as On a schedule", () => {
    expect(routineSentence({ name: "this routine", detail: { cron: "", targetKind: "assistant", thread: { mode: "own" } } })).toBe(
      "On a schedule, this routine: work in its own thread.",
    );
    expect(routineSentence({ name: "Digest", detail: { cron: "0 9 * * 1-5", timezone: "UTC", targetKind: "assistant", thread: { mode: "own" } } })).toBe(
      "Every weekday at 9:00, Digest: work in its own thread.",
    );
    expect(routineSentence({ name: "this routine", workflowId: "wf-1", detail: { cron: "0 9 * * *", timezone: "UTC", targetKind: "workflow" } })).toBe(
      "Every day at 9:00, this routine: run Triage failures.",
    );
  });

  it("names a pinned thread by its title", () => {
    expect(routineSentence({
      name: "this routine",
      detail: { cron: "0 9 * * *", timezone: "UTC", targetKind: "assistant", thread: { mode: "existing", sessionId: "s1", threadId: "t-ci" } },
    })).toBe("Every day at 9:00, this routine: work in the Platform CI thread.");
  });
});

describe("wizardWhenParts", () => {
  it("reads the place when no event is picked yet", () => {
    expect(partsText(wizardWhenParts({ kind: "presence", sub: draftLine({ filters: [ACME_API] }), service: "github" }, undefined))).toBe(
      "Something happens on acme/api",
    );
  });
});
