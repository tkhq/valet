// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Appearance } from "@valet/shared";
import { AppearsSection, appearsSummary } from "./appears-section";

let latest: Appearance = {};

function Harness({ initial = {} }: { initial?: Appearance }) {
  const [value, setValue] = useState<Appearance>(initial);
  latest = value;
  return <AppearsSection value={value} onChange={setValue} />;
}

describe("AppearsSection", () => {
  it("edits the display name and shows a live chip", () => {
    render(<Harness />);
    expect(screen.getByTestId("appears-chip").textContent).toContain("Valet");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ops bot" } });
    expect(latest).toEqual({ displayName: "Ops bot" });
    expect(screen.getByTestId("appears-chip").textContent).toContain("Ops bot");
  });

  it("reads a default summary until a name is set", () => {
    expect(appearsSummary({})).toEqual({ text: "Valet, the workspace's name and avatar", muted: true });
    expect(appearsSummary({ displayName: "Ops bot" })).toEqual({ text: "Ops bot", muted: false });
    expect(appearsSummary({ avatarUrl: "https://x/a.png" })).toEqual({ text: "Valet, with your avatar", muted: false });
  });
});
