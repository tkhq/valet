// @vitest-environment jsdom
/**
 * The controlled config form (spec §Dynamic configuration): focus, invariants,
 * and threat categories are pure controlled fields that fire onChange. No data
 * fetching, no mutation.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ConfigForm, type ConfigDraft } from "./config-form";

function Host({ initial }: { initial?: Partial<ConfigDraft> }) {
  const [value, setValue] = useState<ConfigDraft>({
    focus: initial?.focus ?? "",
    invariants: initial?.invariants ?? [],
    categories: initial?.categories ?? [],
  });
  return (
    <div>
      <ConfigForm value={value} onChange={setValue} />
      <output data-testid="dump">{JSON.stringify(value)}</output>
    </div>
  );
}

function dump(): ConfigDraft {
  return JSON.parse(screen.getByTestId("dump").textContent ?? "{}");
}

describe("ConfigForm", () => {
  it("seeds the fields from the value", () => {
    render(<Host initial={{ focus: "the webhook verifier", categories: ["authz"] }} />);
    expect((screen.getByLabelText("Focus (optional)") as HTMLTextAreaElement).value).toBe(
      "the webhook verifier",
    );
    const authz = screen.getByLabelText("Authorization") as HTMLInputElement;
    expect(authz.checked).toBe(true);
  });

  it("fires onChange when focus changes", () => {
    render(<Host />);
    fireEvent.change(screen.getByLabelText("Focus (optional)"), {
      target: { value: "the token path" },
    });
    expect(dump().focus).toBe("the token path");
  });

  it("adds and edits an invariant", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Add invariant" }));
    fireEvent.change(screen.getByLabelText("Invariant 1"), {
      target: { value: "every admin route sits behind requireAdmin" },
    });
    expect(dump().invariants).toEqual(["every admin route sits behind requireAdmin"]);
  });

  it("toggles a threat category, preserving the KNOWN order", () => {
    render(<Host initial={{ categories: ["webhooks"] }} />);
    fireEvent.click(screen.getByLabelText("Authorization"));
    // authz precedes webhooks in KNOWN_CATEGORIES, so it leads.
    expect(dump().categories).toEqual(["authz", "webhooks"]);
    // Untoggle webhooks.
    fireEvent.click(screen.getByLabelText("Webhooks"));
    expect(dump().categories).toEqual(["authz"]);
  });
});
