import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  derivedClause,
  eventInWords,
  eventLabel,
  partsText,
  presenceSentence,
  presenceSentenceParts,
  routineSentence,
  routineSentenceParts,
  runsInLabel,
  type RoutineLike,
} from "./sentences";

const catalog: GetWorkflowTriggerCatalogResponse["catalog"] = [
  {
    service: "slack",
    entries: [
      { key: "slack.app_mention", description: "When someone @-mentions the bot in a channel or thread", filters: [] },
      { key: "slack.reaction_added", description: "When someone adds an emoji reaction to a message", filters: [] },
      { key: "slack.pin_added", description: "When someone pins a message.", filters: [] },
    ],
  },
  {
    service: "github",
    entries: [
      { key: "github.pull_request.labeled", description: "When a label is added to a pull request", filters: [] },
      { key: "github.discussion.answered", description: "GitHub discussion answered", filters: [] },
    ],
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
      "When you mention Valet in #incidents, reply in a new thread.",
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
      "When you mention Valet in #incidents, work in one thread per channel.",
    );
  });

  it("assistant, own: work in its own thread", () => {
    const s = sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "own" } } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When you mention Valet in #incidents, work in its own thread.",
    );
  });

  it("a Slack thread follow: replies in the Slack thread in <channel>", () => {
    const thread = { field: "thread_ts", op: "eq" as const, value: "1750000000.123456" };
    const raw = sub({
      eventKeys: ["slack.message"],
      filters: [{ field: "channel", op: "eq", value: "C0123" }, thread],
      target: { kind: "assistant", follow: false, thread: { mode: "own" } },
    });
    expect(presenceSentence(raw, catalog, workflows, threads)).toBe(
      "When someone replies in the Slack thread in C0123, work in its own thread.",
    );
    const labeled = sub({
      eventKeys: ["slack.message"],
      filters: [incidents, thread],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "t-ci" }, appearance: { displayName: "Ops" } },
    });
    expect(presenceSentence(labeled, catalog, workflows, threads)).toBe(
      "When someone replies in the Slack thread in #incidents, work in the Platform CI thread, as Ops.",
    );
    // Without a thread_ts filter, a message rule keeps the event grammar.
    const plain = sub({ eventKeys: ["slack.message"], filters: [incidents], target: { kind: "assistant", thread: { mode: "own" } } });
    expect(presenceSentence(plain, catalog, workflows, threads)).toBe(
      "When someone posts a message in #incidents, work in its own thread.",
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
      "When you mention Valet in #incidents, work in the pinned thread.",
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
      "When you mention Valet in #incidents, reply in a new thread.",
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
      "When you mention Valet in any channel, work in its own thread.",
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
      "When you mention Valet in #eng or #ops, work in its own thread.",
    );
  });

  it("joins three events with commas and or, and says each verb once", () => {
    const s = sub({
      eventKeys: ["github.pull_request.opened", "github.check_run.completed", "github.check_suite.completed", "github.workflow_run.completed"],
      filters: [acmeApi],
      target: { kind: "workflow", workflowId: "wf-1" },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a pull request is opened, a check, or a workflow run completes on acme/api, run Triage failures.",
    );
  });

  it("uses an event picker description that reads as a When clause for a key without a short name", () => {
    const s = sub({ eventKeys: ["slack.pin_added"], filters: [incidents], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone pins a message in #incidents, run Triage failures.",
    );
  });

  it("derives words from the key when no table and no When description names it", () => {
    const s = sub({ eventKeys: ["github.discussion.answered"], filters: [acmeApi], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When a discussion is answered on acme/api, run Triage failures.",
    );
  });

  it("adds a single sender filter as from <value>", () => {
    const s = sub({
      filters: [incidents, { field: "user", op: "eq", value: "U1", label: "Alice" }],
      target: { kind: "assistant", assistant: "team", teamId: "sre", thread: { mode: "own" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When someone mentions Valet from Alice in #incidents, work in its own thread.",
    );
  });

  it("skips the creator scope the server adds to a mention rule, and keeps a labeled sender", () => {
    const scoped = sub({
      filters: [incidents, { field: "user", op: "eq", value: "U0ABC" }],
      target: { kind: "assistant", thread: { mode: "new" } },
    });
    expect(presenceSentence(scoped, catalog, workflows, threads)).toBe(
      "When you mention Valet in #incidents, reply in a new thread.",
    );
    const labeled = sub({
      filters: [incidents, { field: "user", op: "eq", value: "U0ABC", label: "Alice" }],
      target: { kind: "assistant", assistant: "team", teamId: "sre", thread: { mode: "new" } },
    });
    expect(presenceSentence(labeled, catalog, workflows, threads)).toBe(
      "When someone mentions Valet from Alice in #incidents, reply in a new thread.",
    );
  });

  it("adds the appearance when one is set", () => {
    const s = sub({
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "new" }, appearance: { displayName: "Incident bot" } },
    });
    expect(presenceSentence(s, catalog, workflows, threads)).toBe(
      "When you mention Valet in #incidents, reply in a new thread, as Incident bot.",
    );
  });
});

describe("presenceSentence without the place clause (spec Part B step 5)", () => {
  const noPlace = { place: false } as const;

  it("omits <in|on> <place> and keeps the events, the sender, the do, and the appearance", () => {
    const slack = sub({
      filters: [incidents, { field: "user", op: "eq", value: "U1", label: "Alice" }],
      target: { kind: "assistant", assistant: "team", teamId: "sre", thread: { mode: "new" }, appearance: { displayName: "Ops Bot" } },
    });
    expect(presenceSentence(slack, catalog, workflows, threads, {}, noPlace)).toBe(
      "When someone mentions Valet from Alice, reply in a new thread, as Ops Bot.",
    );
    const github = sub({
      eventKeys: ["github.check_run.completed"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "t-ci" } },
    });
    expect(presenceSentence(github, catalog, workflows, threads, {}, noPlace)).toBe(
      "When a check completes, work in the Platform CI thread.",
    );
    expect(presenceSentence(github, catalog, workflows, threads)).toBe(
      "When a check completes on acme/api, work in the Platform CI thread.",
    );
  });

  it("omits , as <appearance> when the place's Appears as line names it", () => {
    const slack = sub({
      filters: [incidents],
      target: { kind: "assistant", thread: { mode: "new" }, appearance: { displayName: "Ops Bot" } },
    });
    expect(presenceSentence(slack, catalog, workflows, threads, {}, { place: false, appearance: false })).toBe(
      "When you mention Valet, reply in a new thread.",
    );
  });

  it("omits the service-wide place too", () => {
    const anywhere = sub({ filters: [], target: { kind: "assistant", thread: { mode: "new" } } });
    expect(presenceSentence(anywhere, catalog, workflows, threads, {}, noPlace)).toBe(
      "When you mention Valet, reply in a new thread.",
    );
  });

  it("keeps the thread-follow form without its channel", () => {
    const follow = sub({
      eventKeys: ["slack.message"],
      filters: [incidents, { field: "thread_ts", op: "eq", value: "1750000000.123456" }],
      target: { kind: "assistant", thread: { mode: "own" } },
    });
    expect(presenceSentence(follow, catalog, workflows, threads, {}, noPlace)).toBe(
      "When someone replies in the Slack thread, work in its own thread.",
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

  it("skipped: <reason> for team coverage, with no dash", () => {
    expect(activitySentence(check, delivery({ status: "skipped", lastError: "The team already listens for this. This personal line is paused." }))).toBe(
      "Completed check in acme/api → skipped: the team already listens for this. This personal line is paused",
    );
    // A row stored before the text changed drops its dash.
    expect(activitySentence(check, delivery({ status: "skipped", lastError: "Skipped — matching team subscription." }))).toBe(
      "Completed check in acme/api → skipped: matching team subscription",
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

describe("who a mention line listens to", () => {
  const scope = { field: "user", op: "eq" as const, value: "U0ABC" };
  const names = { members: { "u-002": "Jack" }, me: "u-001" };

  it("a personal line reads you", () => {
    const s = sub({ filters: [incidents, scope], target: { kind: "assistant", assistant: "user", thread: { mode: "new" } } });
    expect(presenceSentence(s, catalog, workflows, threads, names)).toBe("When you mention Valet in #incidents, reply in a new thread.");
  });

  it("an org or workflow line with the creator scope names its creator", () => {
    const org = sub({ createdBy: "u-002", filters: [incidents, scope], target: { kind: "assistant", assistant: "org", thread: { mode: "new" } } });
    expect(presenceSentence(org, catalog, workflows, threads, names)).toBe("When Jack mentions Valet in #incidents, reply in a new thread.");
    const flow = sub({ createdBy: "u-002", filters: [incidents, scope], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(flow, catalog, workflows, threads, names)).toBe("When Jack mentions Valet in #incidents, run Triage failures.");
  });

  it("an org line the viewer created reads you", () => {
    const org = sub({ createdBy: "u-001", filters: [incidents, scope], target: { kind: "assistant", assistant: "org" } });
    expect(presenceSentence(org, catalog, workflows, threads, names)).toBe("When you mention Valet in #incidents, reply in a new thread.");
  });

  it("falls back to the person who set this up when the creator has no known name", () => {
    const org = sub({ createdBy: "u-gone", filters: [incidents, scope], target: { kind: "assistant", assistant: "org" } });
    expect(presenceSentence(org, catalog, workflows, threads, names)).toBe(
      "When the person who set this up mentions Valet in #incidents, reply in a new thread.",
    );
  });

  it("a team line, or a line with no creator scope, reads someone", () => {
    const team = sub({ filters: [incidents], target: { kind: "assistant", assistant: "team", teamId: "sre" } });
    expect(presenceSentence(team, catalog, workflows, threads, names)).toBe("When someone mentions Valet in #incidents, reply in a new thread.");
    const flow = sub({ createdBy: "u-002", filters: [incidents], target: { kind: "workflow", workflowId: "wf-1" } });
    expect(presenceSentence(flow, catalog, workflows, threads, names)).toBe("When someone mentions Valet in #incidents, run Triage failures.");
  });

  it("names the creator as a person token", () => {
    const org = sub({ createdBy: "u-002", filters: [incidents, scope], target: { kind: "assistant", assistant: "org" } });
    expect(presenceSentenceParts(org, catalog, workflows, threads, names)).toContainEqual({ kind: "person", text: "Jack" });
  });
});

describe("sentence parts", () => {
  it("marks places, threads, workflows, and the appearance", () => {
    const pinned = sub({
      eventKeys: ["github.check_run.completed"],
      filters: [acmeApi],
      target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "t-ci" }, appearance: { displayName: "Ops Bot" } },
    });
    expect(presenceSentenceParts(pinned, catalog, workflows, threads)).toEqual([
      { kind: "text", text: "When a check completes on " },
      { kind: "place", text: "acme/api", service: "github", subject: "github:acme/api" },
      { kind: "text", text: ", work in the " },
      { kind: "thread", text: "Platform CI", sessionId: "s", threadId: "t-ci" },
      { kind: "text", text: " thread, as " },
      { kind: "person", text: "Ops Bot" },
      { kind: "text", text: "." },
    ]);
    const several = sub({
      filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#eng", "#ops"] }],
      target: { kind: "workflow", workflowId: "wf-1" },
    });
    expect(presenceSentenceParts(several, catalog, workflows, threads)).toEqual([
      { kind: "text", text: "When someone mentions Valet in " },
      { kind: "place", text: "#eng", service: "slack", subject: "slack:C1" },
      { kind: "text", text: " or " },
      { kind: "place", text: "#ops", service: "slack", subject: "slack:C2" },
      { kind: "text", text: ", run " },
      { kind: "workflow", text: "Triage failures", id: "wf-1" },
      { kind: "text", text: "." },
    ]);
    const linear = sub({ eventKeys: ["linear.issue.create"], filters: [{ field: "team", op: "eq", value: "ENG" }], target: { kind: "assistant" } });
    expect(presenceSentenceParts(linear, catalog, workflows, threads)).toContainEqual(
      { kind: "place", text: "ENG", service: "linear", subject: "linear:team/ENG" },
    );
  });

  it("a routine's workflow is a token", () => {
    expect(routineSentenceParts(routine({ targetKind: "workflow" }, "wf-1"), workflows, threads)).toEqual([
      { kind: "text", text: "Every day at 9:00, Morning summary: run " },
      { kind: "workflow", text: "Triage failures", id: "wf-1" },
      { kind: "text", text: "." },
    ]);
  });

  it("the string is the parts joined, for every fixture", () => {
    const fixtures = [
      sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "new" } } }),
      sub({ eventKeys: ["github.issue_comment.created"], filters: [acmeApi], target: { kind: "assistant" } }),
      sub({ eventKeys: ["slack.message"], filters: [incidents, { field: "thread_ts", op: "eq", value: "1" }], target: { kind: "assistant", thread: { mode: "own" } } }),
      sub({ filters: [incidents], target: { kind: "assistant", thread: { mode: "existing", sessionId: "s", threadId: "gone" } } }),
      sub({ filters: [incidents, { field: "user", op: "eq", value: "U1", label: "Alice" }], target: { kind: "assistant", assistant: "team", teamId: "sre" } }),
      sub({ eventKeys: ["custom.thing_done"], target: { kind: "workflow", workflowId: "wf-gone" } }),
    ];
    for (const fixture of fixtures) {
      for (const options of [{}, { place: false }, { appearance: false }]) {
        expect(presenceSentence(fixture, catalog, workflows, threads, {}, options)).toBe(
          partsText(presenceSentenceParts(fixture, catalog, workflows, threads, {}, options)),
        );
      }
    }
    for (const r of [routine({}), routine({ thread: { mode: "existing", sessionId: "s", threadId: "t-ci" } }), routine({ targetKind: "workflow" }, "wf-1")]) {
      expect(routineSentence(r, workflows, threads)).toBe(partsText(routineSentenceParts(r, workflows, threads)));
    }
  });
});

describe("events in words", () => {
  it("derives a verb phrase from a key that no table names", () => {
    expect(derivedClause("github.pull_request.closed")).toBe("a pull request is closed");
    expect(derivedClause("github.push")).toBe("a push lands");
    expect(derivedClause("linear.issue.update")).toBe("an issue is updated");
    expect(derivedClause("github.pull_request_review_comment.created")).toBe("a review comment is posted");
  });

  it("labels events for the picker", () => {
    expect(eventLabel("github.pull_request.opened")).toBe("A pull request is opened");
    expect(eventLabel("slack.app_mention")).toBe("Someone mentions Valet");
    expect(eventLabel("linear.issue.update")).toBe("An issue is updated");
  });

  it("describes a list of days", () => {
    expect(cronInWords("0 9 * * 1,3,5")).toBe("Every Monday, Wednesday, and Friday at 9:00");
    expect(cronInWords("30 8 * * 0,6")).toBe("Every Saturday and Sunday at 8:30");
  });
});

/** Every event key the GitHub and Linear catalogs publish, read from their sources. */
function catalogKeys(): string[] {
  const root = resolve(__dirname, "../../../..");
  const github = readFileSync(resolve(root, "plugin-github/src/triggers.ts"), "utf8");
  const linear = readFileSync(resolve(root, "plugin-linear/src/triggers.ts"), "utf8");
  const strings = (source: string) => [...source.matchAll(/"([a-z_A-Z]+)"/g)].map((m) => m[1] ?? "");
  const types = strings(/const GITHUB_EVENT_TYPES = \[([\s\S]*?)\];/.exec(github)?.[1] ?? "");
  const actionBlock = /const EVENT_ACTIONS[^=]*= \{([\s\S]*?)\n\};/.exec(github)?.[1] ?? "";
  const actions = new Map<string, string[]>();
  for (const m of actionBlock.matchAll(/(\w+): \[([^\]]*)\]/g)) actions.set(m[1] ?? "", strings(m[2] ?? ""));
  const keys: string[] = [];
  for (const type of types) {
    if (type === "ping") continue;
    const list = actions.get(type);
    if (list === undefined) keys.push(`github.${type}`);
    else for (const action of list) keys.push(`github.${type}.${action}`);
  }
  const linearTypes = strings(/const LINEAR_TYPES = \[([^\]]*)\]/.exec(linear)?.[1] ?? "");
  const linearActions = strings(/const ACTIONS = \[([^\]]*)\]/.exec(linear)?.[1] ?? "");
  for (const type of linearTypes) for (const action of linearActions) keys.push(`linear.${type.toLowerCase()}.${action}`);
  return keys;
}

describe("every catalog key reads as words", () => {
  const keys = catalogKeys();

  it("finds the catalogs", () => {
    expect(keys.filter((k) => k.startsWith("github.")).length).toBeGreaterThan(40);
    expect(keys.filter((k) => k.startsWith("linear.")).length).toBe(18);
    expect(keys).toContain("github.push");
    expect(keys).toContain("github.pull_request_review_comment.created");
  });

  it("names no raw key, no gitHub, and no pull_request", () => {
    for (const key of keys) {
      const repo = key.startsWith("github.") ? [acmeApi] : [];
      const line = sub({ eventKeys: [key], filters: repo, target: { kind: "workflow", workflowId: "wf-1" } });
      const words = [presenceSentence(line, catalog, workflows, threads), eventLabel(key), eventInWords(key)];
      for (const said of words) {
        expect(said, key).not.toMatch(/gitHub|pull_request|_/);
        expect(said, key).not.toContain(key);
        expect(said, key).not.toMatch(/happens/);
      }
    }
  });
});
