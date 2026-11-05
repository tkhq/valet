// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useApiConnection } from "~/api/connection";
import { ReconnectingBanner } from "./reconnecting-banner";

afterEach(() => useApiConnection.setState({ status: "online", unreachable: false }));

describe("ReconnectingBanner", () => {
  it("shows only while a failed health probe confirms the outage", () => {
    render(<ReconnectingBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    // A probe in flight may still pass: one gateway error must not flash the banner.
    act(() => useApiConnection.setState({ status: "checking" }));
    expect(screen.queryByRole("status")).toBeNull();
    act(() => useApiConnection.setState({ status: "reconnecting" }));
    expect(screen.getByRole("status").textContent).toContain("Valet is restarting. Reconnecting…");
    act(() => useApiConnection.setState({ status: "online" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stops calling a long outage a restart", () => {
    render(<ReconnectingBanner />);
    act(() => useApiConnection.setState({ status: "reconnecting", unreachable: true }));
    expect(screen.getByRole("status").textContent).toContain("Valet is unreachable. Still trying to reconnect…");
    expect(screen.getByRole("status").textContent).not.toContain("restarting");
  });
});
