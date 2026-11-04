import { describe, expect, it } from "vitest";
import type { CatalogService } from "~/components/events/subscription-match";
import { line } from "../test-fixtures";
import { eventInWords } from "../sentences";
import { bodyFromDraft, draftFromLine, newDraft, saveBlocker, type Draft, type EditorMode } from "./draft";

const CREATE: EditorMode = { kind: "create" };
const SERVICES: CatalogService[] = [{
  service: "slack",
  entries: [{ key: "slack.user_online", description: "When a chosen person comes back online", filters: [{ field: "user" }] }],
}];

function onlineDraft(over: Partial<Draft> = {}): Draft {
  return {
    ...newDraft({ preselected: { workflowId: "wf-1" }, timezone: "UTC" }),
    events: new Set(["slack.user_online"]),
    conditions: [{ id: "r1", field: "user", op: "eq", value: "U1", label: "Ada" }],
    name: "Nudge Ada",
    ...over,
  };
}

describe("comes back online in the line editor", () => {
  it("names the event in words", () => {
    expect(eventInWords("slack.user_online")).toMatch(/online/i);
  });

  it("sends the once-every-N-hours limit on the workflow target", () => {
    const body = bodyFromDraft(onlineDraft({ oncePerHours: "4" }), CREATE);
    expect(body).toMatchObject({
      kind: "create-line",
      body: { eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "eq", value: "U1" }], target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 4 } },
    });
  });

  it("needs the person to watch, and a whole number of hours", () => {
    expect(saveBlocker(onlineDraft({ conditions: [] }), CREATE, { connected: true })).toBe("Pick the person to watch: add the condition user is <person>.");
    expect(saveBlocker(onlineDraft({ oncePerHours: "1.5" }), CREATE, { connected: true })).toMatch(/^Enter a whole number of hours/);
    expect(saveBlocker(onlineDraft({ oncePerHours: "4" }), CREATE, { connected: true })).toBeNull();
  });

  it("patches only a changed limit, and null removes it", () => {
    const sub = line("l1", {
      eventKeys: ["slack.user_online"], filters: [{ field: "user", op: "eq", value: "U1" }],
      target: { kind: "workflow", workflowId: "wf-1", oncePerHours: 4 },
    });
    const draft = draftFromLine(sub);
    expect(draft.oncePerHours).toBe("4");
    expect(bodyFromDraft(draft, { kind: "edit", line: sub })).toEqual({ kind: "patch-line", id: "l1", body: {} });
    expect(bodyFromDraft({ ...draft, oncePerHours: "" }, { kind: "edit", line: sub })).toEqual({ kind: "patch-line", id: "l1", body: { oncePerHours: null } });
  });

});
