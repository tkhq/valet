// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PluginSummary } from "@valet/api/wire";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { WhenDoStep, connectedServices, type Outcome } from "./when-do-step";
import type { WhenService } from "./wizard-preview";

function plugin(name: string, connected: boolean, connect: "oauth" | "org" = "oauth"): PluginSummary {
  return { name, version: "1", actionCount: 0, services: [{ service: name, type: "oauth2", configKeys: [], connected, connect, actions: [] }] };
}

function step(connected: ReadonlySet<WhenService> | null, over: { outcome?: Outcome; service?: WhenService; fixedService?: WhenService } = {}) {
  const onWhenChange = vi.fn();
  render(
    <WhenDoStep
      outcome={over.outcome ?? "reply"}
      service={over.service ?? "slack"}
      fixedService={over.fixedService}
      fixedWorkflow={false}
      connected={connected}
      onWhenChange={onWhenChange}
      onDoChange={() => {}}
      onAdvanced={() => {}}
    />,
  );
  return onWhenChange;
}

describe("connectedServices", () => {
  it("counts a service the reader or the organization connected, and is null while unknown", () => {
    expect(connectedServices(undefined)).toBeNull();
    const set = connectedServices([plugin("slack", false), plugin("github", false, "org"), plugin("linear", true), plugin("notion", true)]);
    expect([...(set ?? [])].sort()).toEqual(["github", "linear"]);
  });
});

describe("WhenDoStep", () => {
  it("shows each When choice with its large service mark", () => {
    step(new Set(["slack", "github", "linear"]));
    const when = screen.getByRole("group", { name: "When" });
    expect([...when.querySelectorAll<HTMLElement>("[data-service]")].map((m) => [m.dataset.service, m.dataset.size])).toEqual([
      ["slack", "lg"], ["github", "lg"], ["linear", "lg"], ["schedule", "lg"],
    ]);
    expect(within(when).getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual([
      "Something happens in Slack", "Something happens on GitHub", "Something happens in Linear", "On a schedule",
    ]);
  });

  it("greys and disables a service that is not connected, with a link to connect it", () => {
    const onWhenChange = step(new Set(["github"]), { outcome: "notify", service: "github" });
    const when = within(screen.getByRole("group", { name: "When" }));
    expect((when.getByLabelText("Something happens in Slack") as HTMLInputElement).disabled).toBe(true);
    expect((when.getByLabelText("Something happens in Linear") as HTMLInputElement).disabled).toBe(true);
    expect((when.getByLabelText("On a schedule") as HTMLInputElement).disabled).toBe(false);
    expect(when.getByRole("link", { name: "Connect Slack first" }).getAttribute("href")).toBe("/integrations");
    expect(when.getByRole("link", { name: "Connect Linear first" }).getAttribute("href")).toBe("/integrations");
    expect(when.queryByRole("link", { name: /Connect GitHub/ })).toBeNull();
    expect(screen.getByRole("group", { name: "When" }).querySelector("[data-service=slack]")?.className).toContain("opacity-60");
    fireEvent.click(when.getByLabelText("On a schedule"));
    expect(onWhenChange).toHaveBeenCalledWith("schedule");
  });

  it("disables nothing while the connected services are unknown, or for a place's own service", () => {
    step(null);
    expect(screen.queryByRole("link", { name: /^Connect/ })).toBeNull();
  });

  it("keeps a place's service open even when it reads as not connected", () => {
    step(new Set(), { fixedService: "slack" });
    expect((screen.getByLabelText("Something happens in Slack") as HTMLInputElement).disabled).toBe(false);
  });
});
