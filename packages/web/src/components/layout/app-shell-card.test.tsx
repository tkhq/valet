// @vitest-environment jsdom
/** A Tabs card keeps its own sidebar width, apart from other cards and normal tabs. */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("~/lib/card-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/card-context")>();
  return { ...actual, cardId: () => "one", cardStorageKey: (key: string) => actual.cardStorageKey(key, "one") };
});

import { AppShell } from "./app-shell";

afterEach(() => { cleanup(); localStorage.clear(); });

it("reads and writes the sidebar width under the card's own key", () => {
  localStorage.setItem("valet:sidebar-width", "400");
  render(<AppShell topNav={null} sidebar={<nav>threads</nav>}><div>content</div></AppShell>);
  const handle = screen.getByRole("separator", { name: "Resize thread sidebar" });
  expect(handle.getAttribute("aria-valuenow")).toBe("288");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(localStorage.getItem("valet:card:one:valet:sidebar-width")).toBe("312");
  expect(localStorage.getItem("valet:sidebar-width")).toBe("400");
});
