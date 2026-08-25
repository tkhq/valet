// @vitest-environment jsdom
/**
 * Export-modal "Exported files" section states. The section always renders
 * — the empty and cold states must carry instructions (the adversarial
 * review found the section hidden at exactly the moment the agent tells
 * the user to open it).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DesignPanelExports } from "./design-panel-exports";

const FILES = [
  { name: "deck.pptx", size: 2048 },
  { name: "deck.pdf", size: 1024 },
];

describe("DesignPanelExports", () => {
  it("live + empty shows the empty state, not nothing", () => {
    render(
      <DesignPanelExports files={[]} sandbox="live" downloadingName={null} onDownload={() => {}} />,
    );
    expect(screen.getByText("Exported files")).toBeTruthy();
    expect(screen.getByText("No exported files yet.")).toBeTruthy();
  });

  it("sandbox none explains when exports appear", () => {
    render(
      <DesignPanelExports files={[]} sandbox="none" downloadingName={null} onDownload={() => {}} />,
    );
    expect(screen.getByText("Exports appear here after the agent runs an export.")).toBeTruthy();
  });

  it("cold shows cached names disabled with the reconnect instruction", () => {
    render(
      <DesignPanelExports
        files={FILES}
        sandbox="cold"
        downloadingName={null}
        onDownload={() => {}}
      />,
    );
    expect(screen.getByText("deck.pptx")).toBeTruthy();
    const buttons = screen.getAllByRole<HTMLButtonElement>("button");
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect(b.disabled).toBe(true);
    expect(
      screen.getByText("The session is idle. Send it a message to reconnect, then download."),
    ).toBeTruthy();
  });

  it("live download button calls onDownload with the file", async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    render(
      <DesignPanelExports
        files={FILES}
        sandbox="live"
        downloadingName={null}
        onDownload={onDownload}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Download \(2\.0 KB\)/ }));
    expect(onDownload).toHaveBeenCalledWith(FILES[0]);
  });

  it("marks the in-flight download and disables its button", () => {
    render(
      <DesignPanelExports
        files={FILES}
        sandbox="live"
        downloadingName="deck.pptx"
        onDownload={() => {}}
      />,
    );
    const busy = screen.getByRole<HTMLButtonElement>("button", { name: "Downloading…" });
    expect(busy.disabled).toBe(true);
  });
});
