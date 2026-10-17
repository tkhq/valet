import { describe, expect, it } from "vitest";
import { wizardDraft, wizardSentence, type WizardState } from "./wizard-preview";

const workflows = [{ id: "wf-1", name: "Triage failures" }];
const threads = { "t-ci": { title: "Platform CI" } };

function state(over: Partial<WizardState> = {}): WizardState {
  return {
    outcome: "reply",
    service: "slack",
    keys: [],
    filterRows: [],
    replyChannels: [],
    anyChannel: false,
    target: { kind: "assistant", assistant: "user" },
    appearance: {},
    name: "",
    cron: "",
    timezone: "UTC",
    prompt: "",
    thread: { mode: "new" },
    follow: true,
    threadLink: "",
    ...over,
  };
}

function sentence(over: Partial<WizardState>): string {
  return wizardSentence(wizardDraft(state(over)), undefined, workflows, threads);
}

describe("wizardDraft", () => {
  it("a reply posts the mention key and one eq filter for one channel, like the create", () => {
    const draft = wizardDraft(state({ replyChannels: [{ id: "C900", label: "#incidents" }] }));
    if (draft.kind !== "presence") throw new Error("expected a line of presence");
    expect(draft.sub.eventKeys).toEqual(["slack.app_mention"]);
    expect(draft.sub.filters).toEqual([{ field: "channel", op: "eq", value: "C900", label: "#incidents" }]);
    expect(draft.sub.target).toEqual({ kind: "assistant", assistant: "user", follow: true, thread: { mode: "new" } });
  });

  it("a reply in several channels is one in filter with labels", () => {
    const draft = wizardDraft(state({ replyChannels: [{ id: "C1", label: "#a" }, { id: "C2", label: "#b" }] }));
    if (draft.kind !== "presence") throw new Error("expected a line of presence");
    expect(draft.sub.filters).toEqual([{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#a", "#b"] }]);
  });

  it("a reply in any channel has no channel filter", () => {
    const draft = wizardDraft(state({ anyChannel: true, replyChannels: [{ id: "C1", label: "#a" }] }));
    if (draft.kind !== "presence") throw new Error("expected a line of presence");
    expect(draft.sub.filters).toEqual([]);
  });

  it("a workflow outcome runs a workflow even before one is chosen", () => {
    const draft = wizardDraft(state({ outcome: "workflow", service: "github", keys: ["github.pull_request.opened"] }));
    if (draft.kind !== "presence") throw new Error("expected a line of presence");
    expect(draft.sub.target).toEqual({ kind: "workflow", workflowId: "" });
  });

  it("a Slack thread follow posts slack.message on the link's channel and thread, like the create", () => {
    const link = "https://acme.slack.com/archives/C123ABC/p1750000000123456";
    const draft = wizardDraft(state({ outcome: "thread", threadLink: link, thread: { mode: "own" } }));
    if (draft.kind !== "presence") throw new Error("expected a line of presence");
    expect(draft.sub.eventKeys).toEqual(["slack.message"]);
    expect(draft.sub.filters).toEqual([
      { field: "channel", op: "eq", value: "C123ABC" },
      { field: "thread_ts", op: "eq", value: "1750000000.123456" },
    ]);
    expect(draft.sub.target).toEqual({ kind: "assistant", assistant: "user", follow: false, thread: { mode: "own" } });
  });

  it("a routine takes the typed name, else this routine", () => {
    const named = wizardDraft(state({ outcome: "schedule", name: " Digest ", cron: "0 9 * * 1-5", thread: { mode: "own" } }));
    expect(named).toEqual({
      kind: "routine",
      routine: { name: "Digest", detail: { cron: "0 9 * * 1-5", timezone: "UTC", targetKind: "assistant", thread: { mode: "own" } } },
    });
    const unnamed = wizardDraft(state({ outcome: "schedule" }));
    expect(unnamed.kind === "routine" && unnamed.routine.name).toBe("this routine");
  });
});

describe("wizardSentence", () => {
  it("reads a reply from a place (Review Focus 4)", () => {
    expect(sentence({ replyChannels: [{ id: "C900", label: "#incidents" }] })).toBe(
      "When someone mentions Valet in #incidents, reply in a new thread.",
    );
  });

  it("reads Work on it in Slack before an event is picked", () => {
    expect(
      sentence({
        outcome: "notify",
        thread: { mode: "own" },
        filterRows: [{ id: "r1", field: "channel", op: "eq", value: "C900", label: "#incidents" }],
      }),
    ).toBe("When someone mentions Valet in #incidents, work in its own thread.");
  });

  it("names the service when GitHub has no event yet", () => {
    expect(sentence({ outcome: "notify", service: "github", thread: { mode: "own" } })).toBe(
      "When something happens on GitHub, work in its own thread.",
    );
    expect(
      sentence({
        outcome: "workflow",
        service: "github",
        target: { kind: "workflow", workflowId: "wf-1" },
        filterRows: [{ id: "r1", field: "repo", op: "eq", value: "acme/api", label: "acme/api" }],
      }),
    ).toBe("When something happens on acme/api, run Triage failures.");
  });

  it("reads picked events with the shared renderer", () => {
    expect(
      sentence({
        outcome: "notify",
        service: "github",
        keys: ["github.check_run.completed"],
        thread: { mode: "subject" },
        filterRows: [{ id: "r1", field: "repo", op: "eq", value: "acme/api", label: "acme/api" }],
        appearance: { displayName: "CI bot" },
      }),
    ).toBe("When a check completes on acme/api, work in one thread per pull request, as CI bot.");
  });

  it("follows a Slack thread with the stored line's sentence", () => {
    expect(sentence({ outcome: "thread", thread: { mode: "own" } })).toBe(
      "When someone replies in the Slack thread, work in its own thread.",
    );
    const link = "https://acme.slack.com/archives/C123ABC/p1750000000123456";
    expect(sentence({ outcome: "thread", threadLink: link, thread: { mode: "own" } })).toBe(
      "When someone replies in the Slack thread in C123ABC, work in its own thread.",
    );
  });

  it("reads a routine, and an empty schedule as On a schedule", () => {
    expect(sentence({ outcome: "schedule", thread: { mode: "own" } })).toBe("On a schedule, this routine: work in its own thread.");
    expect(sentence({ outcome: "schedule", cron: "0 9 * * 1-5", name: "Digest", thread: { mode: "own" } })).toBe(
      "Every weekday at 9:00, Digest: work in its own thread.",
    );
    expect(
      sentence({ outcome: "schedule", cron: "0 9 * * *", target: { kind: "workflow", workflowId: "wf-1" }, thread: null }),
    ).toBe("Every day at 9:00, this routine: run Triage failures.");
  });

  it("names a pinned thread by its title", () => {
    expect(
      sentence({ outcome: "schedule", cron: "0 9 * * *", thread: { mode: "existing", sessionId: "s1", threadId: "t-ci" } }),
    ).toBe("Every day at 9:00, this routine: work in the Platform CI thread.");
  });
});
