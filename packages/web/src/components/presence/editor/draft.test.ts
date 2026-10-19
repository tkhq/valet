import { describe, expect, it } from "vitest";
import type { CreateEventSubscriptionRequest } from "@valet/api/wire";
import type { CatalogService } from "~/components/events/subscription-match";
import { line, routine } from "../test-fixtures";
import { presenceSentence, routineSentence, text } from "../sentences";
import {
  addCondition,
  applyLinePatch,
  bodyFromDraft,
  draftFromLine,
  draftFromRoutine,
  exampleSteps,
  lineFromCreate,
  newDraft,
  removeCondition,
  routineFromCreate,
  saveBlocker,
  scheduleCron,
  scheduleFromCron,
  setService,
  suggestedName,
  toggleEvent,
  type Draft,
  type EditorMode,
} from "./draft";

const SERVICES: CatalogService[] = [
  {
    service: "slack",
    entries: [
      { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel" }, { field: "user" }] },
      { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
    ],
  },
  {
    service: "github",
    entries: [{ key: "github.check_run.completed", description: "A check completed", filters: [{ field: "repo" }] }],
  },
];

const CREATE: EditorMode = { kind: "create" };
const INCIDENTS = { subject: "slack:T1/C1", service: "slack" as const, label: "#incidents" };

function created(draft: Draft): CreateEventSubscriptionRequest {
  const body = bodyFromDraft(draft, CREATE);
  if (body.kind !== "create-line") throw new Error(`expected a line create, got ${body.kind}`);
  return body.body;
}

describe("bodyFromDraft", () => {
  it("creates a personal Slack reply line with the body the wizard sent", () => {
    let draft = newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" });
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    draft = { ...draft, name: "Incidents" };
    expect(created(draft)).toEqual({
      name: "Incidents",
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1", label: "#incidents" }],
      target: { kind: "assistant", assistant: "user", follow: true, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "new" } },
    });
  });

  it("creates a team work line with no delivery preferences and a grouping default", () => {
    let draft = newDraft({ teamId: "t_platform", timezone: "UTC" });
    draft = setService(draft, "github");
    draft = toggleEvent(draft, "github.check_run.completed", SERVICES);
    draft = { ...draft, name: "CI", instructions: "Find the failing job." };
    expect(created(draft).target).toEqual({
      kind: "assistant", assistant: "team", teamId: "t_platform", follow: false, thread: { mode: "subject" }, systemPrompt: "Find the failing job.",
    });
  });

  it("creates a routine with the cron the days and time make", () => {
    let draft = newDraft({ preselected: { schedule: true }, timezone: "UTC" });
    draft = { ...draft, name: "Morning digest", instructions: "Daily digest" };
    const body = bodyFromDraft(draft, CREATE);
    expect(body).toEqual({
      kind: "create-routine",
      body: { name: "Morning digest", cron: "0 9 * * 1-5", timezone: "UTC", target: { kind: "assistant", prompt: "Daily digest" }, thread: { mode: "own" } },
    });
  });

  it("sends an empty patch for an untouched line", () => {
    const sub = line("l1", {
      eventKeys: ["github.check_run.completed"],
      filters: [{ field: "repo", op: "eq", value: "acme/api" }],
      target: { kind: "assistant", assistant: "user", thread: { mode: "own" }, systemPrompt: "Fix it." },
    });
    expect(bodyFromDraft(draftFromLine(sub), { kind: "edit", line: sub })).toEqual({ kind: "patch-line", id: "l1", body: {} });
  });

  it("sends only the thread when Where moves to a pinned thread (Review Focus 3)", () => {
    const sub = line("l1", {
      name: "CI failures",
      eventKeys: ["github.check_run.completed"],
      filters: [{ field: "repo", op: "eq", value: "acme/api" }],
      target: { kind: "assistant", assistant: "user", thread: { mode: "own" } },
    });
    const pin = { mode: "existing" as const, sessionId: "s-u", threadId: "t-ci" };
    const draft: Draft = { ...draftFromLine(sub), where: pin, whereTitle: "Platform CI" };
    const body = bodyFromDraft(draft, { kind: "edit", line: sub });
    expect(body).toEqual({ kind: "patch-line", id: "l1", body: { thread: pin } });
    const stored = applyLinePatch(sub, body.kind === "patch-line" ? body.body : {});
    expect(stored.name).toBe(sub.name);
    expect(stored.eventKeys).toEqual(sub.eventKeys);
    expect(stored.filters).toEqual(sub.filters);
  });

  it("turns a proposal on in review mode", () => {
    const sub = line("proposal-1", { enabled: false, eventKeys: ["slack.message"], target: { kind: "assistant", thread: { mode: "new" } } });
    expect(bodyFromDraft(draftFromLine(sub), { kind: "review", line: sub })).toEqual({ kind: "patch-line", id: "proposal-1", body: { enabled: true } });
  });

  it("sends an empty patch for an untouched routine and a cron for a new day", () => {
    const r = routine("r1", { detail: { cron: "0 9 * * 1-5" } });
    const mode: EditorMode = { kind: "edit-routine", routine: r };
    const draft = draftFromRoutine(r);
    expect(bodyFromDraft(draft, mode)).toEqual({ kind: "patch-routine", id: "r1", body: {} });
    const saturday = { ...draft, schedule: { ...draft.schedule, days: new Set([1, 2, 3, 4, 5, 6]) } };
    expect(bodyFromDraft(saturday, mode)).toEqual({ kind: "patch-routine", id: "r1", body: { cron: "0 9 * * 1,2,3,4,5,6" } });
  });
});

describe("the sentence reads the body", () => {
  it("reads a create body as the stored line", () => {
    let draft = newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" });
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    expect(presenceSentence(lineFromCreate(created(draft)), undefined, [], {})).toBe(
      "When you mention Valet in #incidents, reply in a new thread.",
    );
  });

  it("reads a routine create body", () => {
    const draft = { ...newDraft({ preselected: { schedule: true }, timezone: "UTC" }), name: "Digest", instructions: "x" };
    const body = bodyFromDraft(draft, CREATE);
    if (body.kind !== "create-routine") throw new Error(`expected a routine create, got ${body.kind}`);
    expect(routineSentence(routineFromCreate(body.body), [], {})).toBe("Every weekday at 9:00, Digest: work in its own thread.");
  });
});

describe("place condition (Part H step 11, Review Focus 4)", () => {
  it("keeps the place through event changes", () => {
    let draft = newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" });
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    // No event is picked, so no field set exists to prune against: the place stays.
    expect(draft.conditions.map((r) => r.value)).toEqual(["C1"]);
    draft = toggleEvent(draft, "slack.message", SERVICES);
    expect(draft.conditions.map((r) => r.value)).toEqual(["C1"]);
  });

  it("keeps every condition when the only event is unchecked and another is checked (E9)", () => {
    let draft = toggleEvent(newDraft({ timezone: "UTC" }), "slack.message", SERVICES);
    draft = addCondition(draft, { id: "c1", field: "channel", op: "eq", value: "C1" });
    draft = toggleEvent(draft, "slack.message", SERVICES);
    expect(draft.conditions.map((r) => r.id)).toEqual(["c1"]);
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    expect(draft.conditions.map((r) => r.id)).toEqual(["c1"]);
  });

  it("drops the creator scope with the mention, so no hidden sender condition stays (E1)", () => {
    const sub = line("l1", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }, { field: "user", op: "eq", value: "U1" }],
      target: { kind: "assistant", assistant: "user", follow: true },
    });
    let draft = draftFromLine(sub);
    draft = toggleEvent(draft, "slack.message", SERVICES);
    expect(draft.creatorScopeId).not.toBeNull();
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    expect(draft.creatorScopeId).toBeNull();
    const body = bodyFromDraft(draft, { kind: "edit", line: sub });
    expect(body.kind === "patch-line" ? body.body.filters : undefined).toEqual([{ field: "channel", op: "eq", value: "C1" }]);
  });

  it("keeps a removed place removed", () => {
    let draft = newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" });
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    draft = removeCondition(draft, draft.conditions[0]!.id);
    draft = toggleEvent(draft, "slack.message", SERVICES);
    expect(draft.conditions).toEqual([]);
  });

  it("drops an added condition on a service change and adds nothing back", () => {
    let draft = newDraft({ timezone: "UTC" });
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    draft = addCondition(draft, { id: "c1", field: "channel", op: "eq", value: "C1", label: "#incidents" });
    draft = setService(draft, "github");
    expect(draft.conditions).toEqual([]);
    draft = setService(draft, "slack");
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    expect(draft.conditions).toEqual([]);
  });

  it("never removes the creator scope", () => {
    const sub = line("l1", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }, { field: "user", op: "eq", value: "U1" }],
      target: { kind: "assistant", assistant: "user" },
    });
    const draft = draftFromLine(sub);
    expect(draft.creatorScopeId).not.toBeNull();
    expect(removeCondition(draft, draft.creatorScopeId ?? "")).toBe(draft);
  });
});

describe("Any channel and follow", () => {
  it("turns Any channel off when a channel condition is added", () => {
    let draft = toggleEvent(newDraft({ timezone: "UTC" }), "slack.app_mention", SERVICES);
    draft = { ...draft, anyChannel: true };
    draft = addCondition(draft, { id: "c1", field: "channel", op: "eq", value: "C1" });
    expect(draft.anyChannel).toBe(false);
  });

  it("blocks Save when Any channel and a channel condition are both set", () => {
    let draft = toggleEvent(newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" }), "slack.app_mention", SERVICES);
    draft = { ...draft, anyChannel: true, name: "x" };
    expect(saveBlocker(draft, CREATE, { connected: true })).toBe("Turn off Any channel or remove the channel condition.");
  });

  it("follows only a mention, never a channel message", () => {
    const base = { ...newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" }), name: "x" };
    const mention = created(toggleEvent(base, "slack.app_mention", SERVICES));
    expect(mention.target.kind === "assistant" && mention.target.follow).toBe(true);
    const message = created(toggleEvent(base, "slack.message", SERVICES));
    expect(message.target.kind === "assistant" && message.target.follow).toBe(false);
  });
});

describe("schedules", () => {
  it("makes the cron from days and time, and reads it back", () => {
    const schedule = { days: new Set([1, 3, 5]), time: "07:30", timezone: "UTC", cronOverride: null };
    expect(scheduleCron(schedule)).toBe("30 7 * * 1,3,5");
    expect(scheduleFromCron("30 7 * * 1,3,5", "UTC")).toEqual(schedule);
  });

  it("keeps a cron the days and time cannot make as a typed cron", () => {
    expect(scheduleFromCron("*/15 * * * *", "UTC").cronOverride).toBe("*/15 * * * *");
  });
});

describe("suggestedName", () => {
  it("drops the article and capitalizes", () => {
    expect(suggestedName([text("a check completes on "), { kind: "place", text: "acme/api", service: "github", subject: "github:acme/api" }])).toBe(
      "Check completes on acme/api",
    );
  });

  it("stops at a word under 40 characters", () => {
    const name = suggestedName([text("a pull request review or a check completes on acme/infrastructure")]);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toBe("Pull request review or a check completes");
  });
});

describe("exampleSteps", () => {
  it("walks a Slack mention", () => {
    let draft = newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" });
    draft = { ...toggleEvent(draft, "slack.app_mention", SERVICES), instructions: "Help." };
    expect(exampleSteps(draft, { when: "someone mentions Valet in #incidents" })).toEqual([
      "Someone mentions Valet in #incidents.",
      "Valet reads the message and your instructions.",
      "It replies in a new thread, as Valet.",
    ]);
  });

  it("walks a schedule", () => {
    const draft = { ...newDraft({ preselected: { schedule: true }, timezone: "UTC" }), instructions: "Digest" };
    expect(exampleSteps(draft, { when: "" })).toEqual(["It is 9:00 on a weekday.", "Valet reads your instructions.", "It works in its own thread."]);
  });
});

describe("saveBlocker", () => {
  it("names what is missing, in order", () => {
    let draft = newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" });
    expect(saveBlocker(draft, CREATE, { connected: true })).toBe("Pick at least one event.");
    draft = toggleEvent(draft, "slack.app_mention", SERVICES);
    expect(saveBlocker(draft, CREATE, { connected: true })).toBe("Give it a name.");
    expect(saveBlocker({ ...draft, name: "x" }, CREATE, { connected: true })).toBeNull();
    expect(saveBlocker({ ...draft, name: "x" }, CREATE, { connected: false })).toBe("Connect the service first.");
    const routineDraft = { ...newDraft({ preselected: { schedule: true }, timezone: "UTC" }), name: "R" };
    expect(saveBlocker(routineDraft, CREATE, { connected: true })).toBe("Give the routine instructions.");
  });
});

describe("saveBlocker mirrors the api's mention and template refusals (E5, E6)", () => {
  const mentionLine = () => {
    let draft = toggleEvent(newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" }), "slack.app_mention", SERVICES);
    draft = { ...draft, name: "x" };
    return draft;
  };

  it("refuses a mention mixed with another Slack event", () => {
    const draft = toggleEvent(mentionLine(), "slack.message", SERVICES);
    expect(saveBlocker(draft, CREATE, { connected: true })).toBe(
      "A mention line can only listen for mentions. Uncheck the other events or the mention.",
    );
  });

  it("refuses a user condition on a personal mention line, not on a team one", () => {
    const draft = addCondition(mentionLine(), { id: "u", field: "user", op: "eq", value: "U9" });
    expect(saveBlocker(draft, CREATE, { connected: true })).toBe(
      "A personal mention line already listens for your own mentions. Remove the user condition.",
    );
    expect(saveBlocker({ ...draft, assistant: "team", teamId: "t1" }, CREATE, { connected: true })).toBeNull();
  });

  it("lets a stored creator scope stay", () => {
    const sub = line("l1", {
      name: "Mine",
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1" }, { field: "user", op: "eq", value: "U1" }],
      target: { kind: "assistant", assistant: "user", follow: true },
    });
    expect(saveBlocker(draftFromLine(sub), { kind: "edit", line: sub }, { connected: true })).toBeNull();
  });

  it("refuses an event variable in the instructions, and allows {{event.key}}", () => {
    const draft = { ...mentionLine(), instructions: "Summarize {{event.summary}}." };
    expect(saveBlocker(draft, CREATE, { connected: true })).toBe(
      "Instructions cannot use event variables. Move {{event.summary}} to the Event message.",
    );
    expect(saveBlocker({ ...draft, instructions: "Handle {{event.key}}." }, CREATE, { connected: true })).toBeNull();
    expect(saveBlocker({ ...draft, instructions: "Open {{ event.key" }, CREATE, { connected: true })).toBe(
      "The instructions have an unclosed or nested {{. Close each {{ with }}.",
    );
  });

  it("refuses an Event message payload variable that no picked event carries", () => {
    let draft = toggleEvent(newDraft({ timezone: "UTC" }), "slack.app_mention", SERVICES);
    draft = { ...draft, name: "x", anyChannel: true, promptTemplates: { userPromptTemplate: "From {{payload.user}}" } };
    expect(saveBlocker(draft, CREATE, { connected: true, services: SERVICES })).toBeNull();
    draft = toggleEvent(toggleEvent(draft, "slack.app_mention", SERVICES), "slack.message", SERVICES);
    expect(saveBlocker(draft, CREATE, { connected: true, services: SERVICES })).toBe(
      "No picked event carries {{payload.user}}. Remove it from the Event message, or pick an event that carries it.",
    );
    // Before the catalog loads, the check waits.
    expect(saveBlocker(draft, CREATE, { connected: true })).toBeNull();
  });
});
