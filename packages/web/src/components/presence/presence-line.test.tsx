// @vitest-environment jsdom
/**
 * The sentence row (docs/specs/2026-10-16-presence-hub-design.md Part B
 * step 5, Part C steps 2 and 3): the row's grid and hover wash, the small
 * switch that patches the line, the read-only rule, and Delete with its
 * confirm. The roster cases (off, faulted, paused) are in place-row.test.tsx.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventSubscriptionWire, PatchEventSubscriptionRequest } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: ReactNode; className?: string }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    return <a href={path} className={className}>{children}</a>;
  },
}));

const patchEventSubscription = vi.fn<(id: string, body: PatchEventSubscriptionRequest) => Promise<EventSubscriptionWire>>();
const deleteEventSubscription = vi.fn<(id: string) => Promise<{ ok: true }>>();
vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      patchEventSubscription: (id: string, body: PatchEventSubscriptionRequest) => patchEventSubscription(id, body),
      deleteEventSubscription: (id: string) => deleteEventSubscription(id),
    },
  };
});
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [] } }) }));
vi.mock("~/api/settings", async () => (await import("./test-fixtures")).memberSettings);
vi.mock("~/components/events/edit-subscription-dialog", () => ({
  EditSubscriptionDialog: ({ sub }: { sub: EventSubscriptionWire }) => <p>Editing {sub.name}</p>,
}));

import { PresenceLine } from "./presence-line";
import { line } from "./test-fixtures";

function mention(over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return line("R1", {
    name: "Incident mentions", eventKeys: ["slack.app_mention"], target: { kind: "assistant", thread: { mode: "new" } }, ...over,
  });
}

function renderLine(sub: EventSubscriptionWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PresenceLine sub={sub} sentence="When someone mentions Valet, reply in a new thread." />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchEventSubscription.mockReset();
  deleteEventSubscription.mockReset();
  patchEventSubscription.mockImplementation(async (id, body) => ({ ...mention({}), id, enabled: body.enabled ?? true }));
  deleteEventSubscription.mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe("PresenceLine", () => {
  it("sets the sentence and its controls as a two-column row with the ink wash on hover", () => {
    renderLine(mention({}));
    const sentence = screen.getByRole("link", { name: "When someone mentions Valet, reply in a new thread." });
    expect(sentence.getAttribute("href")).toBe("/presence/rules/R1");
    const row = sentence.closest("[data-presence-line]");
    for (const name of ["grid", "grid-cols-[minmax(0,1fr)_auto]", "hover:bg-ink-wash", "rounded-md", "-mx-2", "px-2"]) {
      expect(row?.classList.contains(name)).toBe(true);
    }
    expect(row?.classList.contains("border")).toBe(false);
    expect(screen.getByRole("button", { name: "More for Incident mentions" }).className).toContain("h-6");
  });

  it("turns the line off from the small switch", async () => {
    renderLine(mention({}));
    await userEvent.click(screen.getByRole("switch", { name: "Turn off Incident mentions" }));
    await waitFor(() => expect(patchEventSubscription).toHaveBeenCalledWith("R1", { enabled: false }));
  });

  it("keeps another member's personal line read-only", async () => {
    renderLine(mention({ ownerId: "u-002" }));
    expect(screen.getByRole("switch", { name: "Turn off Incident mentions" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "More for Incident mentions" }));
    for (const item of screen.getAllByRole("menuitem")) expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("deletes the line after the confirm", async () => {
    renderLine(mention({}));
    await userEvent.click(screen.getByRole("button", { name: "More for Incident mentions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText("Valet stops listening for this here. Its past activity stays.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteEventSubscription).toHaveBeenCalledWith("R1"));
  });
});
