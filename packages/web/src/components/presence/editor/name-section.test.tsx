// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { NameSection } from "./name-section";

let latest = { name: "", edited: false };

function Harness({ suggestion }: { suggestion: string }) {
  const [state, setState] = useState({ name: "", edited: false });
  latest = state;
  return (
    <NameSection
      name={state.edited ? state.name : suggestion}
      edited={state.edited}
      onChange={(name) => setState({ name, edited: true })}
      onUseSuggestion={() => setState({ name: "", edited: false })}
      suggestion={suggestion}
    />
  );
}

describe("NameSection", () => {
  it("fills the suggestion and marks it until the reader edits", () => {
    render(<Harness suggestion="Check completes on acme/api" />);
    const field = screen.getByLabelText("Name") as HTMLInputElement;
    expect(field.value).toBe("Check completes on acme/api");
    expect(screen.getByText("Suggested from the sentence.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "CI failures" } });
    expect(latest).toEqual({ name: "CI failures", edited: true });
    expect(screen.queryByText("Suggested from the sentence.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use the suggestion" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Check completes on acme/api");
  });
});
