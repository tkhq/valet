// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const reply = vi.fn();
vi.mock("../send-as-person", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send-as-person")>()),
  useSendAsPerson: () => ({ reply, pending: false, error: undefined }),
}));

import { eventWidget, meetingMemoryWidget, statusWidget, transactionsWidget } from "~/dev/ui-stress/fixtures/widgets";
import { ThreadReplyContext } from "../send-as-person";
import { drawableSpec, widgetRenderer } from "../tool-renderers/widget";
import { WidgetView } from "./widget-view";

describe("WidgetView", () => {
  it("draws a stat and a table with right-aligned amounts", () => {
    render(<WidgetView spec={transactionsWidget} title="Transactions" />);
    const figure = screen.getByRole("figure", { name: "Transactions" });
    expect(within(figure).getByText("$538.70")).toBeTruthy();
    const cell = within(figure).getByText("$428.60");
    expect(cell.className).toContain("text-right");
    expect(within(figure).getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Merchant", "Card", "Date", "Amount"]);
  });

  it("draws quotes with their speaker, source, and takeaway", () => {
    render(<WidgetView spec={meetingMemoryWidget} />);
    expect(screen.getByText(/starter plan should feel generous/)).toBeTruthy();
    expect(screen.getByText("Product review")).toBeTruthy();
    expect(screen.getByText(/Takeaway: book Prado, Thursday/)).toBeTruthy();
  });

  it("marks list items with their status", () => {
    render(<WidgetView spec={statusWidget} />);
    expect(screen.getByRole("img", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Done" }).getAttribute("aria-valuenow")).toBe("60");
  });

  it("sends a button's reply as the person in a live thread, and stays disabled outside one", () => {
    const { unmount } = render(<WidgetView spec={eventWidget} />);
    expect((screen.getByRole("button", { name: "Send invite" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(<ThreadReplyContext.Provider value={{ sessionId: "s1", threadId: "t1" }}><WidgetView spec={eventWidget} /></ThreadReplyContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(reply).toHaveBeenCalledWith("Send the invite.");
  });
});

describe("show_widget renderer", () => {
  it("draws a finished call's widget and nothing for a spec the catalog refuses", () => {
    expect(drawableSpec({ spec: transactionsWidget })).toBe(transactionsWidget);
    expect(drawableSpec({ spec: { root: "a", elements: { a: { type: "Chart", props: {}, children: [] } } } })).toBeUndefined();
    const Preview = widgetRenderer.Preview!;
    const { container, rerender } = render(<Preview args={{ title: "Transactions", spec: transactionsWidget }} result={undefined} status="running" toolName="show_widget" />);
    expect(container.firstChild).toBeNull();
    rerender(<Preview args={{ title: "Transactions", spec: transactionsWidget }} result={undefined} status="completed" toolName="show_widget" />);
    expect(screen.getByRole("figure", { name: "Transactions" })).toBeTruthy();
    expect(widgetRenderer.bare).toBe(true);
  });
});
