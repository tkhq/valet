// @vitest-environment jsdom
/**
 * The controlled config form (spec §Dynamic configuration): focus, invariants,
 * and threat categories are pure controlled fields that fire onChange. No data
 * fetching, no mutation.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  ConfigForm,
  emptyScopeDraft,
  normalizeScopeHostsForSubmit,
  type ConfigDraft,
} from "./config-form";

function Host({
  initial,
  requireLiveScope,
}: {
  initial?: Partial<ConfigDraft>;
  requireLiveScope?: boolean;
}) {
  const [value, setValue] = useState<ConfigDraft>({
    focus: initial?.focus ?? "",
    invariants: initial?.invariants ?? [],
    categories: initial?.categories ?? [],
    scope: initial?.scope ?? emptyScopeDraft(),
  });
  return (
    <div>
      <ConfigForm value={value} onChange={setValue} requireLiveScope={requireLiveScope} />
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

  it("renders the scope section and adds a host", () => {
    render(<Host />);
    // Section header is always present, even without live personas.
    expect(screen.getByTestId("config-scope")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    fireEvent.change(screen.getByLabelText("Authorized host 1"), {
      target: { value: "api.example.com" },
    });
    expect(dump().scope.hosts).toEqual(["api.example.com"]);
  });

  it("shows the REQUIRED hint and empty-scope error when live persona is in the plan", () => {
    render(<Host requireLiveScope={true} />);
    expect(screen.getByTestId("config-scope-required")).toBeTruthy();
    expect(screen.getByTestId("config-scope-empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    fireEvent.change(screen.getByLabelText("Authorized host 1"), {
      target: { value: "api.example.com" },
    });
    // Once a host is added, the empty-scope error clears.
    expect(screen.queryByTestId("config-scope-empty")).toBeNull();
  });

  it("removes a scope host without collapsing the others", () => {
    render(
      <Host
        initial={{
          scope: { ...emptyScopeDraft(), hosts: ["a.example.com", "b.example.com"] },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove host 1" }));
    expect(dump().scope.hosts).toEqual(["b.example.com"]);
  });
});

describe("normalizeScopeHostsForSubmit", () => {
  it("trims, drops empties, and dedups while preserving the original order", () => {
    expect(
      normalizeScopeHostsForSubmit({
        ...emptyScopeDraft(),
        hosts: [" api.example.com ", "", "staging.example.com", "api.example.com"],
      }),
    ).toEqual(["api.example.com", "staging.example.com"]);
  });

  it("returns an empty list when every host is blank", () => {
    expect(
      normalizeScopeHostsForSubmit({ ...emptyScopeDraft(), hosts: ["", " ", "\t"] }),
    ).toEqual([]);
  });
});
