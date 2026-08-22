// @vitest-environment jsdom
/**
 * Appearance · Chat density (TKAI-199): the three `RadioCard`s that write
 * the `tool-card-default` preference. The tests read the real
 * `~/lib/preferences` module — the round trip through localStorage IS the
 * contract under test, so mocking it would assert nothing.
 *
 * `@tanstack/react-router` is mocked the same way
 * `-settings.connected-accounts.test.tsx` mocks it: `createFileRoute` runs
 * at module scope, and these tests render `AppearancePage` directly with no
 * router around it.
 *
 * Theme and palette are covered elsewhere. Nothing here asserts on them.
 *
 * The assertions read `aria-checked` directly. This repo has no
 * `@testing-library/jest-dom`, so the DOM matchers it adds are unavailable.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

import { AppearancePage } from "./settings.appearance";

/** The accessible name of each card, in the order the page renders them. */
const SMART = /Smart/;
const COLLAPSED = /Always collapsed/;
const EXPANDED = /Always expanded/;

function card(name: RegExp): HTMLElement {
  return screen.getByRole("radio", { name });
}

describe("Appearance · Chat density", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("selects Smart when the key is absent", () => {
    render(<AppearancePage />);

    expect(card(SMART).getAttribute("aria-checked")).toBe("true");
    expect(card(COLLAPSED).getAttribute("aria-checked")).toBe("false");
    expect(card(EXPANDED).getAttribute("aria-checked")).toBe("false");
  });

  it("selects the card the stored value names", () => {
    localStorage.setItem("tool-card-default", "always-collapsed");

    render(<AppearancePage />);

    expect(card(COLLAPSED).getAttribute("aria-checked")).toBe("true");
    expect(card(SMART).getAttribute("aria-checked")).toBe("false");
    expect(card(EXPANDED).getAttribute("aria-checked")).toBe("false");
  });

  it("persists the click and moves the selection", () => {
    render(<AppearancePage />);

    fireEvent.click(card(EXPANDED));

    expect(localStorage.getItem("tool-card-default")).toBe("always-expanded");
    expect(card(EXPANDED).getAttribute("aria-checked")).toBe("true");
    expect(card(SMART).getAttribute("aria-checked")).toBe("false");
  });
});
