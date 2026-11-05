// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ActiveViewer } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";
import { RowFaces, TypingLine, ViewerFaces, typingText } from "./viewer-faces";

afterEach(cleanup);

const person = (userId: string, name: string, typing = false): ActiveViewer => ({ userId, name, typing });

describe("viewer faces", () => {
  it("words the typing line by how many people type", () => {
    expect(typingText([person("a", "Dana Sales")])).toBe("");
    expect(typingText([person("a", "Dana Sales", true)])).toBe("Dana is typing…");
    expect(typingText([person("a", "Dana Sales", true), person("b", "Kim Lee", true)])).toBe("Dana and Kim are typing…");
    expect(typingText([person("a", "A", true), person("b", "B", true), person("c", "C", true)])).toBe("3 people are typing…");
  });

  it("keeps the typing line mounted for screen readers, empty when nobody types", () => {
    const { rerender } = render(<TypingLine viewers={[person("a", "Dana Sales")]} />);
    expect(screen.getByTestId("typing-line").textContent).toBe("");
    rerender(<TypingLine viewers={[person("a", "Dana Sales", true)]} />);
    expect(screen.getByTestId("typing-line").textContent).toContain("Dana is typing…");
  });

  it("shows three faces and the rest as a count, and lists everyone when opened", () => {
    const viewers = [person("a", "Ann"), person("b", "Bo"), person("c", "Cy", true), person("d", "Di")];
    render(<TooltipProvider><ViewerFaces viewers={viewers} /></TooltipProvider>);
    const trigger = screen.getByTestId("thread-viewers");
    expect(trigger.getAttribute("aria-label")).toBe("In this thread: Ann, here now; Bo, here now; Cy, typing; Di, here now");
    expect(trigger.textContent).toContain("+1");
    fireEvent.click(trigger);
    expect(screen.getByText("In this thread")).toBeTruthy();
    expect(screen.getAllByText("here now")).toHaveLength(3);
    expect(screen.getByText("typing")).toBeTruthy();
  });

  it("names each person in a tooltip on keyboard focus", () => {
    render(<TooltipProvider><ViewerFaces viewers={[person("a", "Dana Sales"), person("b", "Kim Lee", true)]} /></TooltipProvider>);
    fireEvent.focus(screen.getByTestId("thread-viewers"));
    expect(screen.getByRole("tooltip").textContent).toBe("Dana Sales, here nowKim Lee, typing");
  });

  it("renders nothing without other people", () => {
    const { container } = render(<><ViewerFaces viewers={[]} /><RowFaces viewers={[]} /></>);
    expect(container.innerHTML).toBe("");
  });

  it("labels row faces with names", () => {
    render(<RowFaces viewers={[person("a", "Dana Sales"), person("b", "Kim Lee"), person("c", "Cy")]} />);
    expect(screen.getByRole("img", { name: "In this thread: Dana Sales, Kim Lee, Cy" })).toBeTruthy();
  });
});
