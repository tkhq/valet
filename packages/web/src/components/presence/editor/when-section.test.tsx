// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogService } from "~/components/events/subscription-match";
import type { WhenService } from "~/components/events/wizard-preview";
import { formatDateTime } from "~/lib/format-when";
import { line } from "../test-fixtures";
import { bodyFromDraft, draftFromLine, isEmptyBody, newDraft, scheduleCron, type Draft, type EditorMode } from "./draft";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("~/api/events", () => ({
  useFilterOptions: () => ({ data: { options: [], reason: "Connect first." }, isLoading: false }),
}));

import { WhenSection, conditionHint, conditionWords, threadFollowHint } from "./when-section";

const SERVICES: CatalogService[] = [
  {
    service: "slack",
    entries: [
      { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel" }, { field: "user" }] },
      { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
      { key: "slack.reaction_added", description: "Reaction", filters: [{ field: "reaction" }] },
    ],
  },
  {
    service: "github",
    entries: [
      { key: "github.pull_request.opened", description: "PR", filters: [{ field: "repo" }] },
      { key: "github.check_run.completed", description: "Check", filters: [{ field: "repo" }, { field: "author" }] },
    ],
  },
];

const INCIDENTS = { subject: "slack:T1/C1", service: "slack" as const, label: "#incidents" };

let latest: Draft | undefined;

function Harness({ initial, mode = { kind: "create" }, connected = new Set<WhenService>(["slack", "github"]), services = SERVICES }: {
  initial: Draft;
  mode?: EditorMode;
  connected?: ReadonlySet<WhenService> | null;
  services?: CatalogService[];
}) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return (
    <WhenSection
      draft={draft}
      mode={mode}
      onChange={setDraft}
      services={services}
      catalogLoading={false}
      catalogError={false}
      connected={connected}
    />
  );
}

describe("WhenSection", () => {
  it("offers each service with its mark and disables one that is not connected", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    const services = screen.getByRole("group", { name: "Service" });
    expect(within(services).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Slack", "GitHub", "LinearConnect first", "On a schedule",
    ]);
    expect((within(services).getByRole("button", { name: /Linear/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(services).getByRole("button", { name: "Slack" }).getAttribute("aria-pressed")).toBe("true");
    expect(services.querySelectorAll('[data-size="md"]')).toHaveLength(4);
  });

  it("lists the common events in words, the rest under More events", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    const events = screen.getByRole("group", { name: "Events" });
    expect(within(events).getByLabelText("Someone mentions Valet")).toBeTruthy();
    expect(within(events).getByText("More events (1)")).toBeTruthy();
    expect(events.textContent).not.toContain("slack.app_mention");
    fireEvent.click(within(events).getByLabelText("Someone mentions Valet"));
    expect([...(latest?.events ?? [])]).toEqual(["slack.app_mention"]);
  });

  it("shows conditions as pills in words and removes one", () => {
    render(<Harness initial={newDraft({ preselected: { place: INCIDENTS }, timezone: "UTC" })} />);
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    const only = screen.getByRole("group", { name: "Only when" });
    expect(within(only).getByText("channel is #incidents")).toBeTruthy();
    // A personal mention line hears only its creator; the pill cannot be removed.
    expect(within(only).getByText("your own mentions")).toBeTruthy();
    expect(within(only).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    fireEvent.click(within(only).getByRole("button", { name: "Remove channel is #incidents" }));
    expect(latest?.conditions).toEqual([]);
  });

  it("keeps a stored creator scope as a pill without a remove", () => {
    const sub = line("l1", {
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C1", label: "#incidents" }, { field: "user", op: "eq", value: "U1" }],
      target: { kind: "assistant", assistant: "user", follow: true },
    });
    render(<Harness initial={draftFromLine(sub)} mode={{ kind: "edit", line: sub }} />);
    const only = screen.getByRole("group", { name: "Only when" });
    expect(within(only).getByText("your own mentions")).toBeTruthy();
    expect(within(only).queryByText(/user is/)).toBeNull();
    expect(within(only).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
  });

  it("adds a condition from the fields the picked events carry", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    fireEvent.click(screen.getByLabelText("A check completes"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    const field = screen.getByLabelText("Condition field") as HTMLSelectElement;
    expect([...field.options].map((o) => o.textContent)).toEqual(["Repository", "Author"]);
    fireEvent.change(field, { target: { value: "author" } });
    fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "jack" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("author is jack")).toBeTruthy();
  });

  it("fixes the service to a preselected place's", () => {
    const preselected = { place: INCIDENTS };
    render(<Harness initial={newDraft({ preselected, timezone: "UTC" })} mode={{ kind: "create", preselected }} />);
    const services = screen.getByRole("group", { name: "Service" });
    const only = within(services).getAllByRole("button");
    expect(only.map((b) => b.textContent)).toEqual(["Slack"]);
    expect(only[0]?.getAttribute("aria-pressed")).toBe("true");
    expect((only[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("switching the service drops an added condition (Review Focus 4)", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: "channel" } });
    fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "C1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("channel is C1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(latest?.conditions).toEqual([]);
    expect(screen.queryByText("channel is C1")).toBeNull();
  });

  it("turns Any channel off once a channel condition is added", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    fireEvent.click(screen.getByLabelText(/^Any channel/));
    expect(latest?.anyChannel).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: "channel" } });
    fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "C1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(latest?.anyChannel).toBe(false);
  });

  it("moves the condition picker to an offered field when the events change", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} />);
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: "user" } });
    fireEvent.click(screen.getByLabelText("Someone mentions Valet"));
    fireEvent.click(screen.getByLabelText("Someone posts a message"));
    expect((screen.getByLabelText("Condition field") as HTMLSelectElement).value).toBe("channel");
  });

  it("holds the day and time control for a schedule, which makes the cron", () => {
    render(<Harness initial={newDraft({ preselected: { schedule: true }, timezone: "UTC" })} />);
    expect(screen.queryByRole("group", { name: "Events" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Sat"));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "07:30" } });
    expect(latest !== undefined && scheduleCron(latest.schedule)).toBe("30 7 * * 1,2,3,4,5,6");
  });

  it("names a condition in words", () => {
    expect(conditionWords({ id: "1", field: "repo", op: "eq", value: "acme/api" })).toBe("repository is acme/api");
    expect(conditionWords({ id: "2", field: "channel", op: "in", value: "C1, C2", inLabels: { field: "channel", values: ["C1", "C2"], labels: ["#a", "#b"] } })).toBe(
      "channel is #a or #b",
    );
  });

  // Review of PR #986: the chip and the sentence must name a channel the
  // same way, so an unlabeled or id-labeled channel takes the places name.
  it("names an unlabeled channel from the places list, as the sentence does", () => {
    const names = { channels: { C1: "incidents" } };
    expect(conditionWords({ id: "1", field: "channel", op: "eq", value: "C1" }, names)).toBe("channel is #incidents");
    expect(conditionWords({ id: "2", field: "channel", op: "eq", value: "C1", label: "C1" }, names)).toBe("channel is #incidents");
    expect(conditionWords({ id: "3", field: "channel", op: "in", value: "C1, C2", inLabels: { field: "channel", values: ["C1", "C2"], labels: ["C1", "C2"] } }, names))
      .toBe("channel is #incidents or C2");
    expect(conditionWords({ id: "4", field: "channel", op: "prefix", value: "C1" }, names)).toBe("channel starts with C1");
  });
});

describe("exclusion conditions", () => {
  const ALERTS: CatalogService[] = [
    {
      service: "slack",
      entries: [
        { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel" }, { field: "user" }] },
        { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
        { key: "slack.bot_message", description: "App message", filters: [{ field: "channel_name" }, { field: "bot_id" }] },
      ],
    },
  ];

  function addCondition(field: string, op: string, value: string) {
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    fireEvent.change(screen.getByLabelText("Condition field"), { target: { value: field } });
    fireEvent.change(screen.getByLabelText("Condition comparison"), { target: { value: op } });
    fireEvent.change(screen.getByLabelText("Condition value"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  }

  it("offers is not and doesn't start with among the comparisons", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} services={ALERTS} />);
    fireEvent.click(screen.getByLabelText("An app posts a message"));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a condition" }));
    const comparison = screen.getByLabelText("Condition comparison") as HTMLSelectElement;
    expect([...comparison.options].map((o) => o.textContent)).toEqual([
      "is", "is one of", "is not", "starts with", "doesn't start with", "contains",
    ]);
  });

  it("renders a bot is not pill and saves it as not_in", () => {
    render(<Harness initial={newDraft({ timezone: "UTC" })} services={ALERTS} />);
    fireEvent.click(screen.getByLabelText("An app posts a message"));
    addCondition("bot_id", "not_in", "B0123ABCD, B0456EFGH");
    addCondition("channel_name", "not_prefix", "alerts-deal");
    const only = screen.getByRole("group", { name: "Only when" });
    expect(within(only).getByText("bot is not B0123ABCD or B0456EFGH")).toBeTruthy();
    expect(within(only).getByText("channel name doesn't start with alerts-deal")).toBeTruthy();
    const saved = latest !== undefined ? bodyFromDraft(latest, { kind: "create" }) : null;
    expect(saved?.kind === "create-line" ? saved.body.filters : null).toEqual([
      { field: "bot_id", op: "not_in", value: ["B0123ABCD", "B0456EFGH"] },
      { field: "channel_name", op: "not_prefix", value: "alerts-deal" },
    ]);
  });

  it("keeps a stored exclusion as it is when the line is edited", () => {
    const sub = line("l1", {
      eventKeys: ["slack.bot_message"],
      filters: [{ field: "channel_name", op: "prefix", value: "alerts-" }, { field: "bot_id", op: "not_in", value: ["B1"] }],
      target: { kind: "assistant", assistant: "team" },
    });
    render(<Harness initial={draftFromLine(sub)} mode={{ kind: "edit", line: sub }} services={ALERTS} />);
    expect(within(screen.getByRole("group", { name: "Only when" })).getByText("bot is not B1")).toBeTruthy();
    expect(latest !== undefined && isEmptyBody(bodyFromDraft(latest, { kind: "edit", line: sub }))).toBe(true);
  });

  it("names an excluded channel from the places list", () => {
    expect(conditionWords({ id: "1", field: "channel", op: "not_in", value: "C1, C2" }, { channels: { C1: "incidents" } }))
      .toBe("channel is not #incidents or C2");
  });
});

describe("conditionHint", () => {
  it("names fields the service's own events carry", () => {
    expect(conditionHint("slack")).toBe("Any field these events carry, such as a channel or a sender.");
    expect(conditionHint("github")).toBe("Any field these events carry, such as a branch or an author.");
    expect(conditionHint("linear")).toBe("Any field these events carry, such as a team or a label.");
  });
});

describe("threadFollowHint (E10)", () => {
  it("reads the start time and the channel's name, never raw ids", () => {
    const thread = { channel: "C123ABC", channelLabel: "#rollout", threadTs: "1750000000.123456" };
    expect(threadFollowHint(thread, { timeZone: "UTC" })).toBe(
      `Follows the thread started ${formatDateTime(1750000000123.456, { timeZone: "UTC" })} in #rollout. Paste another link to follow a different thread.`,
    );
    expect(threadFollowHint({ ...thread, channelLabel: "C123ABC" }, { timeZone: "UTC" })).not.toContain("C123ABC");
  });
});
