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
  presenceSentence,
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

describe("presenceSentence <do>", () => {
  it("assistant, conversational keys, new: reply in a new thread", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "new" } } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, reply in a new thread.",
    );
  });

  it("treats pull request comment keys as conversational", () => {
    const s = sub({
      eventKeys: ["github.issue_comment.created"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone comments on acme/api, reply in a new thread.",
    );
  });

  it("assistant, other keys, new: work in a new thread each time", () => {
    const s = sub({
      eventKeys: ["slack.reaction_added"],
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone adds a reaction in #incidents, work in a new thread each time.",
    );
  });

  it("assistant, subject: work in one thread per pull request", () => {
    const s = sub({
      eventKeys: ["github.pull_request_review.submitted", "github.check_run.completed"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "subject" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a pull request review or a check completes on acme/api, work in one thread per pull request.",
    );
  });

  it("assistant, subject: work in one thread per issue", () => {
    const s = sub({
      eventKeys: ["linear.issue.create"],
      filters: [{ field: "team", op: "eq", value: "ENG" }],
      target: { kind: "assistant", thread: { mode: "subject" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When an issue is created in ENG, work in one thread per issue.",
    );
  });

  it("assistant, subject: work in one thread per channel", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "subject" } } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, work in one thread per channel.",
    );
  });

  it("assistant, own: work in its own thread", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "own" } } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, work in its own thread.",
    );
  });

  it("assistant, existing: work in the <title> thread", () => {
    const s = sub({
      eventKeys: ["github.check_run.completed"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "t-ci" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a check completes on acme/api, work in the Platform CI thread.",
    );
  });

  it("assistant, existing, unknown title: work in the pinned thread", () => {
    const s = sub({
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "gone" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, work in the pinned thread.",
    );
  });

  it("workflow: run <workflow name>", () => {
    const s = sub({ filters: [incidents], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, run Triage failures.",
    );
  });

  it("workflow with an unknown name: run a workflow", () => {
    const s = sub({ filters: [incidents], target: { kind: "workflow", workflowId: "wf-gone" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, run a workflow.",
    );
  });

  it("absent policy, conversational keys: reply in a new thread", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, reply in a new thread.",
    );
    const comment = sub({ eventKeys: ["github.issue_comment.created"], filters: [acmeApi], target: { kind: "assistant" } });
    expect(presenceSentence(comment, catalog, workflows, threads)).toBe(
      "When someone comments on acme/api, reply in a new thread.",
    );
  });

  it("absent policy, other keys: work in its own thread", () => {
    const s = sub({ eventKeys: ["github.check_run.completed"], filters: [acmeApi], target: { kind: "assistant" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a check completes on acme/api, work in its own thread.",
    );
  });
});

describe("presenceSentence parts", () => {
  it("uses in for Slack and Linear, on for GitHub", () => {
    const own = { kind: "assistant" as const, thread: { mode: "own" as const } };
    expect(presenceSentence(sub({ filters: [incidents], target: own }), catalog, workflows, threads)).toMatch(/ in #incidents, /);
    expect(
      presenceSentence(
        sub({ eventKeys: ["linear.issue.create"], filters: [{ field: "team", op: "eq", value: "ENG" }], target: own }),
        catalog,
        workflows,
        threads,
      ),
    ).toBe("When an issue is created in ENG, work in its own thread.");
    expect(
      presenceSentence(sub({ eventKeys: ["github.check_run.completed"], filters: [acmeApi], target: own }), catalog, workflows, threads),
    ).toBe("When a check completes on acme/api, work in its own thread.");
  });

  it("names the service-wide place when no filter names one", () => {
    const own = { kind: "assistant" as const, thread: { mode: "own" as const } };
    expect(presenceSentence(sub({ target: own }), catalog, workflows, threads)).toBe(
      "When someone mentions Valet in any channel, work in its own thread.",
    );
    expect(
      presenceSentence(sub({ eventKeys: ["github.check_run.completed"], target: own }), catalog, workflows, threads),
    ).toBe("When a check completes on any repository, work in its own thread.");
  });

  it("leaves the place out when no key names a service", () => {
    const s = sub({ eventKeys: ["custom.thing_done"], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe("When thing done happens, run Triage failures.");
  });

  it("joins several places with or", () => {
    const s = sub({
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#eng", "#ops"] }],
      target: { kind: "assistant", thread: { mode: "own" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #eng or #ops, work in its own thread.",
    );
  });

  it("joins three events with commas and or, and says each verb once", () => {
    const s = sub({
      eventKeys: ["github.pull_request.opened", "github.check_run.completed", "github.check_suite.completed", "github.workflow_run.completed"],
      filters: [acmeApi],
      target: { kind: "workflow", workflowId: "wf-1" },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a pull request opens, a check, or a workflow run completes on acme/api, run Triage failures.",
    );
  });

  it("uses the event picker label for a key without a short name", () => {
    const s = sub({ eventKeys: ["github.pull_request.labeled"], filters: [acmeApi], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a label is added to a pull request on acme/api, run Triage failures.",
    );
  });

  it("adds a single sender filter as from <value>", () => {
    const s = sub({
      filters: [incidents, { field: "user", op: "eq", value: "U1", label: "Alice" }],
      target: { kind: "assistant", thread: { mode: "own" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet from Alice in #incidents, work in its own thread.",
    );
  });

  it("adds the appearance when one is set", () => {
    const s = sub({
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "new" }, appearance: { displayName: "Incident bot" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet in #incidents, reply in a new thread, as Incident bot.",
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
  it("own: work in its own thread", () => {
    expect(routineSentence(routine({ thread: { mode: "own" } }), workflows, threads)).toBe(
      "Every day at 9:00, Morning summary: work in its own thread.",
    );
  });

  it("absent policy reads as own", () => {
    expect(routineSentence(routine({}), workflows, threads)).toBe(
      "Every day at 9:00, Morning summary: work in its own thread.",
    );
  });

  it("new: work in a new thread each time", () => {
    expect(routineSentence(routine({ thread: { mode: "new" } }), workflows, threads)).toBe(
      "Every day at 9:00, Morning summary: work in a new thread each time.",
    );
  });

  it("existing: work in the <title> thread", () => {
    expect(
      routineSentence(routine({ thread: { mode: "existing", sessionId: "s", threadId: "t-ci" } }), workflows, threads),
    ).toBe("Every day at 9:00, Morning summary: work in the Platform CI thread.");
    expect(
      routineSentence(routine({ thread: { mode: "existing", sessionId: "s", threadId: "gone" } }), workflows, threads),
    ).toBe("Every day at 9:00, Morning summary: work in the pinned thread.");
  });

  it("workflow: run <workflow>", () => {
    expect(routineSentence(routine({ targetKind: "workflow" }, "wf-1"), workflows, threads)).toBe(
      "Every day at 9:00, Morning summary: run Triage failures.",
    );
  });

  it("names a timezone other than UTC after the schedule words", () => {
    expect(routineSentence(routine({ timezone: "America/Denver" }), workflows, threads)).toBe(
      "Every day at 9:00 (America/Denver), Morning summary: work in its own thread.",
    );
    expect(routineSentence(routine({ timezone: "UTC" }), workflows, threads)).toBe(
      "Every day at 9:00, Morning summary: work in its own thread.",
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

  it("no one listening", () => {
    expect(activitySentence(check, null)).toBe("Completed check in acme/api → no one listening");
    expect(activitySentence(check, [])).toBe("Completed check in acme/api → no one listening");
  });

  it("falls back when the thread title is unknown", () => {
    expect(activitySentence(check, delivery({ thread: { sessionId: "s", threadId: "x" } }))).toBe(
      "Completed check in acme/api → delivered to a thread",
    );
  });

  it("prefers a place the caller names, and omits the place when none is known", () => {
    expect(activitySentence(check, null, { place: "acme/api#12" })).toBe("Completed check in acme/api#12 → no one listening");
    expect(activitySentence({ eventKey: "slack.team_join" }, null)).toBe("Team join → no one listening");
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
    expect(runsInLabel({ mode: "new" }, "channel", "presence")).toBe("A new thread each time");
    expect(runsInLabel({ mode: "subject" }, "pull request", "presence")).toBe("One thread per pull request");
    expect(runsInLabel({ mode: "own" }, null, "presence")).toBe("Its own thread");
    expect(runsInLabel({ mode: "own" }, null, "routine")).toBe("This routine's thread");
    expect(runsInLabel({ mode: "existing", sessionId: "s", threadId: "t" }, null, "routine", "Deploys"))
      .toBe("The thread Deploys");
  });

  it("falls back when the picked thread has no known title", () => {
    expect(runsInLabel({ mode: "existing", sessionId: "s", threadId: "t" }, null, "presence"))
      .toBe("The thread you picked");
  });
});
