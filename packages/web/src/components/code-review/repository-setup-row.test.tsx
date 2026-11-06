// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CreateEventSubscriptionRequest } from "@valet/api/wire";
import type { HandlerOption } from "~/components/plugins/handler-settings";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
const create = vi.fn((_body: CreateEventSubscriptionRequest, _options?: { onSuccess?: (response: { id: string }) => void; onError?: (error: Error) => void }) => {});
let pending = false;
vi.mock("~/api/events", () => ({ useCreateEventSubscription: () => ({ mutate: create, isPending: pending, error: null }) }));
import { RepositorySetupRow } from "./repository-setup-row";
const handler: HandlerOption = { plugin: "pr-review", id: "review-pull-request", label: "Review", description: "Review pushes.", events: ["github.pull_request.opened"] };
const onAdded = vi.fn();

beforeEach(() => { pending = false; create.mockClear(); onAdded.mockClear(); });

it("locks the switch immediately and after success until the configuration loads", () => {
  render(<RepositorySetupRow repository="acme/site" installed handler={handler} teamId="team-1" onAdded={onAdded} />);
  const toggle = screen.getByRole("switch", { name: "Review pull requests in acme/site" });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(create).toHaveBeenCalledOnce();
  expect(toggle.hasAttribute("disabled")).toBe(true);
  act(() => create.mock.calls[0]?.[1]?.onSuccess?.({ id: "line-1" }));
  expect(onAdded).toHaveBeenCalledWith("line-1");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(toggle.hasAttribute("disabled")).toBe(true);
});

it("unlocks a failed creation so the reader can retry", () => {
  render(<RepositorySetupRow repository="acme/site" installed handler={handler} onAdded={onAdded} />);
  fireEvent.click(screen.getByRole("switch"));
  act(() => create.mock.calls[0]?.[1]?.onError?.(new Error("Cannot save")));
  expect(screen.getByRole("alert").textContent).toContain("try again");
  expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("switch"));
  expect(create).toHaveBeenCalledTimes(2);
});

it("disables a pending creation", () => {
  pending = true;
  render(<RepositorySetupRow repository="acme/site" installed handler={handler} onAdded={onAdded} />);
  fireEvent.click(screen.getByRole("switch"));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("Adding code review");
});
