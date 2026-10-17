import { describe, expect, it } from "vitest";
import type {
  EventDeliveryWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  GetWorkflowTriggerCatalogResponse,
} from "@valet/api/wire";
import {
  activitySentence,
  cronInWords,
  listenerSentence,
  routineSentence,
  runsInLabel,
  type RoutineLike,
} from "./sentences";

const catalog: GetWorkflowTriggerCatalogResponse["catalog"] = [
  {
    service: "slack",
    entries: [
      { key: "slack.app_mention", description: "When someone @-mentions the bot in a channel or thread", filters: [] },
      { key: "slack.reaction_added", description: "When someone adds an emoji reaction to a message", filters: [] },
    ],
  },
  {
    service: "github",
    entries: [{ key: "github.pull_request.labeled", description: "When a label is added to a pull request", filters: [] }],
  },
];

const workflows = [{ id: "wf-1", name: "Triage failures" }];
const threads = { "t-ci": { title: "Platform CI" }, "t-inc": { title: "t-inc" } };

function sub(over: Partial<EventSubscriptionWire> & { target: EventSubscriptionTargetWire }): EventSubscriptionWire {
  return {
    id: "sub-1",
    name: "R",
    ownerType: "user",
    ownerId: "u-001",
    eventKeys: ["slack.app_mention"],
    filters: [],
    enabled: true,
    createdBy: "u-001",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const incidents = { field: "channel", op: "eq" as const, value: "C900", label: "#incidents" };
const acmeApi = { field: "repo", op: "eq" as const, value: "acme/api" };

describe("listenerSentence <does>", () => {
  it("assistant, conversational keys, new: replies in a new thread", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "new" } } });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · replies in a new thread",
    );
  });

  it("treats pull request comment keys as conversational", () => {
    const s = sub({
      eventKeys: ["github.issue_comment.created"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens on acme/api for comments · replies in a new thread",
    );
  });

  it("assistant, other keys, new: works in a new thread each time", () => {
    const s = sub({
      eventKeys: ["slack.reaction_added"],
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for added reactions · works in a new thread each time",
    );
  });

  it("assistant, subject: works in one thread per pull request", () => {
    const s = sub({
      eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "subject" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens on acme/api for pull request reviews and completed checks · works in one thread per pull request",
    );
  });

  it("assistant, subject: works in one thread per channel", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "subject" } } });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · works in one thread per channel",
    );
  });

  it("assistant, own: works in this listener's thread", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "own" } } });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · works in this listener's thread",
    );
  });

  it("assistant, existing: works in the thread <title>", () => {
    const s = sub({
      eventKeys: ["github.check_run.completed"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "t-ci" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens on acme/api for completed checks · works in the thread Platform CI",
    );
  });

  it("assistant, existing, unknown title: falls back", () => {
    const s = sub({
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "gone" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · works in the thread you picked",
    );
  });

  it("workflow: runs <workflow name>", () => {
    const s = sub({ filters: [incidents], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · runs Triage failures",
    );
  });

  it("reads an absent policy the way the rule runs it", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant" } });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · replies in a new thread",
    );
  });
});

describe("listenerSentence parts", () => {
  it("uses in for Slack and Linear, on for GitHub", () => {
    const own = { kind: "assistant" as const, thread: { mode: "own" as const } };
    expect(listenerSentence(sub({ filters: [incidents], target: own }), catalog, workflows, threads)).toMatch(/^Listens in #incidents/);
    expect(
      listenerSentence(
        sub({ eventKeys: ["linear.issue.create"], filters: [{ field: "team", op: "eq", value: "ENG" }], target: own }),
        catalog,
        workflows,
        threads,
      ),
    ).toMatch(/^Listens in ENG for new issues/);
    expect(
      listenerSentence(sub({ eventKeys: ["github.check_run.completed"], filters: [acmeApi], target: own }), catalog, workflows, threads),
    ).toMatch(/^Listens on acme\/api/);
  });

  it("names the service-wide place when no filter names one", () => {
    const own = { kind: "assistant" as const, thread: { mode: "own" as const } };
    expect(listenerSentence(sub({ target: own }), catalog, workflows, threads)).toMatch(/^Listens in any channel for mentions/);
    expect(
      listenerSentence(sub({ eventKeys: ["github.check_run.completed"], target: own }), catalog, workflows, threads),
    ).toMatch(/^Listens on any repository for completed checks/);
  });

  it("joins several places with and", () => {
    const s = sub({
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#eng", "#ops"] }],
      target: { kind: "assistant", thread: { mode: "own" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toMatch(/^Listens in #eng and #ops for mentions/);
  });

  it("uses the event picker label for a key without a short name", () => {
    const s = sub({ eventKeys: ["github.pull_request.labeled"], filters: [acmeApi], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens on acme/api for a label is added to a pull request · runs Triage failures",
    );
  });

  it("adds a single sender filter as from <value>", () => {
    const s = sub({
      filters: [incidents, { field: "user", op: "eq", value: "U1", label: "Alice" }],
      target: { kind: "assistant", thread: { mode: "own" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions from Alice · works in this listener's thread",
    );
  });

  it("adds the appearance when one is set", () => {
    const s = sub({
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "new" }, appearance: { displayName: "Incident bot" } },
    });
    expect(listenerSentence(s, catalog, workflows, threads)).toBe(
      "Listens in #incidents for mentions · replies in a new thread · as Incident bot",
    );
  });
});

function routine(over: Partial<RoutineLike["detail"]>, workflowId?: string): RoutineLike {
  return {
    name: "Morning summary",
    workflowId,
    detail: { cron: "0 9 * * *", targetKind: "assistant", ...over },
  };
}

describe("routineSentence", () => {
  it("own: works in this routine's thread", () => {
    expect(routineSentence(routine({ thread: { mode: "own" } }), workflows, threads)).toBe(
      "Every day at 9:00 · Morning summary · works in this routine's thread",
    );
  });

  it("absent policy reads as own", () => {
    expect(routineSentence(routine({}), workflows, threads)).toBe(
      "Every day at 9:00 · Morning summary · works in this routine's thread",
    );
  });

  it("new: works in a new thread each time", () => {
    expect(routineSentence(routine({ thread: { mode: "new" } }), workflows, threads)).toBe(
      "Every day at 9:00 · Morning summary · works in a new thread each time",
    );
  });

  it("existing: works in the thread <title>", () => {
    expect(
      routineSentence(routine({ thread: { mode: "existing", sessionId: "s", threadId: "t-ci" } }), workflows, threads),
    ).toBe("Every day at 9:00 · Morning summary · works in the thread Platform CI");
  });

  it("workflow: runs <workflow>", () => {
    expect(routineSentence(routine({ targetKind: "workflow" }, "wf-1"), workflows, threads)).toBe(
      "Every day at 9:00 · Morning summary · runs Triage failures",
    );
  });
  it("names a timezone other than UTC after the schedule words", () => {
    expect(routineSentence(routine({ timezone: "America/Denver" }), workflows, threads)).toBe(
      "Every day at 9:00 (America/Denver) · Morning summary · works in this routine's thread",
    );
    expect(routineSentence(routine({ timezone: "UTC" }), workflows, threads)).toBe(
      "Every day at 9:00 · Morning summary · works in this routine's thread",
    );
  });
});

describe("cronInWords", () => {
  it("describes common schedules", () => {
    expect(cronInWords("0 9 * * *")).toBe("Every day at 9:00");
    expect(cronInWords("30 14 * * 1-5")).toBe("Every weekday at 14:30");
    expect(cronInWords("0 8 * * 1")).toBe("Every Monday at 8:00");
    expect(cronInWords("15 * * * *")).toBe("Every hour at 15 minutes past");
    expect(cronInWords("*/10 * * * *")).toBe("Every 10 minutes");
    expect(cronInWords("0 6 1 * *")).toBe("On day 1 of every month at 6:00");
  });

  it("shows any other expression as it is", () => {
    expect(cronInWords("0 9 1,15 2 *")).toBe("On the schedule 0 9 1,15 2 *");
  });
});

function delivery(over: Partial<EventDeliveryWire>): EventDeliveryWire {
  return {
    id: "d-1",
    subscriptionId: "sub-1",
    status: "delivered",
    attempts: 1,
    lastError: null,
    deliveredAt: 1,
    ...over,
  };
}

const mention = { eventKey: "slack.app_mention", refs: { channel: "C900", channel_name: "incidents" } };
const message = { eventKey: "slack.message", refs: { channel: "C900", channel_name: "incidents" } };
const check = { eventKey: "github.check_run.completed", refs: { repo: "acme/api" } };

describe("activitySentence outcomes", () => {
  it("replied in <thread>", () => {
    expect(
      activitySentence(mention, delivery({ thread: { sessionId: "s", threadId: "t-inc" } }), { threads }),
    ).toBe("Mention in #incidents → replied in t-inc");
  });

  it("delivered to <thread>", () => {
    expect(
      activitySentence(check, delivery({ thread: { sessionId: "s", threadId: "t-ci" } }), { threads }),
    ).toBe("Completed check in acme/api → delivered to Platform CI");
  });

  it("claimed by <thread>", () => {
    expect(
      activitySentence(
        message,
        delivery({ status: "skipped", lastError: "Skipped, claimed by thread t-inc", claimedBy: { sessionId: "s", threadId: "t-inc" } }),
        { threads },
      ),
    ).toBe("Message in #incidents → claimed by t-inc");
  });

  it("started <workflow> run", () => {
    expect(activitySentence(check, delivery({ runId: "run-1" }), { workflowName: "Triage failures" })).toBe(
      "Completed check in acme/api → started Triage failures run",
    );
  });

  it("skipped: <reason>", () => {
    expect(activitySentence(check, delivery({ status: "skipped", lastError: "Skipped by delivery preferences" }))).toBe(
      "Completed check in acme/api → skipped: delivery preferences",
    );
  });

  it("no listener", () => {
    expect(activitySentence(check, null)).toBe("Completed check in acme/api → no listener");
    expect(activitySentence(check, [])).toBe("Completed check in acme/api → no listener");
  });

  it("falls back when the thread title is unknown", () => {
    expect(activitySentence(check, delivery({ thread: { sessionId: "s", threadId: "x" } }))).toBe(
      "Completed check in acme/api → delivered to a thread",
    );
  });

  it("prefers a place the caller names, and omits the place when none is known", () => {
    expect(activitySentence(check, null, { place: "acme/api#12" })).toBe("Completed check in acme/api#12 → no listener");
    expect(activitySentence({ eventKey: "slack.team_join" }, null)).toBe("Team join → no listener");
  });

  it("joins the outcomes of several deliveries", () => {
    expect(
      activitySentence(
        mention,
        [delivery({ thread: { sessionId: "s", threadId: "t-inc" } }), delivery({ id: "d-2", runId: "r" })],
        { threads, workflowName: "Triage failures" },
      ),
    ).toBe("Mention in #incidents → replied in t-inc, started Triage failures run");
  });
});

describe("runsInLabel", () => {
  it("labels each mode", () => {
    expect(runsInLabel({ mode: "new" }, "channel", "listener")).toBe("A new thread each time");
    expect(runsInLabel({ mode: "subject" }, "pull request", "listener")).toBe("One thread per pull request");
    expect(runsInLabel({ mode: "own" }, null, "listener")).toBe("This listener's thread");
    expect(runsInLabel({ mode: "own" }, null, "routine")).toBe("This routine's thread");
    expect(runsInLabel({ mode: "existing", sessionId: "s", threadId: "t" }, null, "routine", "Deploys"))
      .toBe("The thread Deploys");
  });

  it("falls back when the picked thread has no known title", () => {
    expect(runsInLabel({ mode: "existing", sessionId: "s", threadId: "t" }, null, "listener"))
      .toBe("The thread you picked");
  });
});
