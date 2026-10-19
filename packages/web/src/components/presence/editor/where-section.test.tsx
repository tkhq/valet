// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogService } from "~/components/events/subscription-match";
import { partsText } from "../sentences";
import { newDraft, setService, toggleEvent, type Draft } from "./draft";

vi.mock("../thread-picker", () => ({
  ThreadPicker: ({ workspace, onPick }: { workspace: string; onPick: (p: { mode: "existing"; sessionId: string; threadId: string }, title: string) => void }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s-u", threadId: "t-ci" }, "Platform CI")}>
      Pick Platform CI from {workspace}
    </button>
  ),
}));

import { WhereSection, whereSummaryParts } from "./where-section";

const SERVICES: CatalogService[] = [
  { service: "github", entries: [{ key: "github.check_run.completed", description: "Check", filters: [{ field: "repo" }] }] },
];

let latest: Draft | undefined;

function Harness({ initial, overlapTeam }: { initial: Draft; overlapTeam?: string }) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return <WhereSection draft={draft} onChange={setDraft} workspace="user" overlapTeam={overlapTeam} />;
}

function checks(): Draft {
  return toggleEvent(setService(newDraft({ timezone: "UTC" }), "github"), "github.check_run.completed", SERVICES);
}

describe("WhereSection", () => {
  it("lists the policies as cards with one explanation each, the default picked", () => {
    render(<Harness initial={checks()} />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual([
      "One thread per pull request", "A new thread each time", "Its own thread", "Pick a thread",
    ]);
    expect((screen.getByRole("radio", { name: "One thread per pull request" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Each pull request gets its own thread; every event for it lands there.")).toBeTruthy();
    expect(screen.getByText("Every event starts fresh.")).toBeTruthy();
    expect(screen.getByText("One running thread for this line.")).toBeTruthy();
    expect(screen.getByText("Pick an existing thread. If it is archived, this line stops until you pick another.")).toBeTruthy();
  });

  it("holds the thread picker inline and names the pick", () => {
    render(<Harness initial={checks()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Pick a thread" }));
    expect(latest?.where).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pick Platform CI from user" }));
    expect(latest?.where).toEqual({ mode: "existing", sessionId: "s-u", threadId: "t-ci" });
    expect(screen.getByRole("radio", { name: "The Platform CI thread" })).toBeTruthy();
    expect(latest !== undefined && partsText(whereSummaryParts(latest))).toBe("in the Platform CI thread");
  });

  it("offers Pause this line or Keep both only for a personal line a team also covers", () => {
    const { unmount } = render(<Harness initial={checks()} />);
    expect(screen.queryByRole("radiogroup", { name: /also listens/ })).toBeNull();
    unmount();
    render(<Harness initial={checks()} overlapTeam="Platform" />);
    expect(screen.getByRole("radiogroup", { name: "When Platform also listens" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Pause this line" }));
    expect(latest?.deliveryPolicy).toBe("ignoreIfMyTeamSubscribed");
    expect(latest?.pauseOnOverlap).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Keep both" }));
    expect(latest?.deliveryPolicy).toBe("always");
  });

  it("reads a routine's own thread", () => {
    render(<Harness initial={newDraft({ preselected: { schedule: true }, timezone: "UTC" })} />);
    expect(screen.getByRole("radio", { name: "This routine's thread" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /One thread per/ })).toBeNull();
    expect(screen.getByText("Every run starts fresh.")).toBeTruthy();
  });

  it("sums up a routine's own thread in the side pane's words (L8)", () => {
    const routine = newDraft({ preselected: { schedule: true }, timezone: "UTC" });
    expect(partsText(whereSummaryParts({ ...routine, where: { mode: "own" }, whereChosen: true }))).toBe("in its own thread");
  });
});
