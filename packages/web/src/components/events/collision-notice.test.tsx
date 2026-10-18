// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { EventSubscriptionCollisionsWire, EventSubscriptionWire } from "@valet/api/wire";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, v), to)}>{children}</a>
  ),
}));

import { line } from "~/components/presence/test-fixtures";
import { CollisionNotice } from "./collision-notice";

/** A team mention line in #incidents that carries a raw user filter. */
function teamMention(id: string): EventSubscriptionWire {
  return line(id, {
    ownerType: "team", ownerId: "sre", eventKeys: ["slack.app_mention"],
    filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }, { field: "user", op: "eq", value: "U0ABC" }],
    target: { kind: "assistant", assistant: "team", teamId: "sre" },
  });
}

const blocking: EventSubscriptionCollisionsWire = {
  blocking: [{ subscription: teamMention("Incident mentions"), relation: "equal", sharedKeys: ["slack.app_mention"] }],
  overlapping: [],
};

describe("CollisionNotice", () => {
  it("says the lines also fire, links each by name, and reads each as its sentence", () => {
    const { container } = render(<CollisionNotice report={blocking} committed={false} />);
    expect(screen.getByText("Also fires")).toBeTruthy();
    expect(screen.queryByText("Would replace")).toBeNull();
    expect(screen.getByText(/All of them would fire together/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Incident mentions" }).getAttribute("href")).toBe("/presence/rules/Incident mentions");
    expect(screen.getByText("When someone mentions Valet in #incidents, reply in a new thread.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/slack\.app_mention|user is|U0ABC|notifies an assistant/);
  });

  it("says Would replace only for the line this one replaces", () => {
    render(<CollisionNotice report={blocking} committed={false} intent="save" replaces="Incident mentions" />);
    expect(screen.getByText("Would replace")).toBeTruthy();
    expect(screen.queryByText("Also fires")).toBeNull();
    expect(screen.queryByText(/fire together/)).toBeNull();
    expect(screen.getByText("To turn the replaced line off, save it anyway.")).toBeTruthy();
  });

  it("names workflows and people from what its caller passes", () => {
    const digest = line("Digest", {
      eventKeys: ["github.check_run.completed"], target: { kind: "workflow", workflowId: "wf-1" },
    });
    const jack = line("Jack mentions", {
      ownerType: "org", ownerId: "org-1", createdBy: "u-jack", eventKeys: ["slack.app_mention"],
      // The server's creator scope: an unlabeled user filter on an org mention line.
      filters: [{ field: "channel", op: "eq", value: "C900", label: "#incidents" }, { field: "user", op: "eq", value: "UJACK" }],
      target: { kind: "workflow", workflowId: "wf-2" },
    });
    render(
      <CollisionNotice
        report={{ blocking: [], overlapping: [
          { subscription: digest, relation: "partial", sharedKeys: ["github.check_run.completed"] },
          { subscription: jack, relation: "partial", sharedKeys: ["slack.app_mention"] },
        ] }}
        committed
        workflows={[{ id: "wf-1", name: "Nightly digest" }]}
        names={{ members: { "u-jack": "Jack" }, me: "u-001" }}
      />,
    );
    expect(screen.getByText(/, run Nightly digest\.$/)).toBeTruthy();
    expect(screen.getByText(/^When Jack mentions Valet/)).toBeTruthy();
  });
});
