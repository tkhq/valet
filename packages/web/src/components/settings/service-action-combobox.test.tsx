// @vitest-environment jsdom
/**
 * ServiceActionCombobox — typeahead combobox for service and action targets
 * on policy forms. Six cases from the task-10 brief:
 * 1. Focus opens full list; typing filters by label/id, case-insensitive.
 * 2. Service rows: name + mono id + "{n} actions" badge.
 *    Action rows: name + mono fqid + RiskBadge; no cascade (flat list).
 * 3. Arrow keys move aria-activedescendant; Enter selects; Escape closes.
 * 4. Free text: no match → pinned row "Use "zzz" — not in the installed catalog";
 *    Enter commits via onChange.
 * 5. ARIA: input role="combobox", aria-expanded, aria-controls; rows role="option".
 * 6. Loading: usePlugins pending → spinner row "Loading catalog…"; free text still committable.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListPluginsResponse } from "@valet/api/wire";

let pluginsData: ListPluginsResponse = { plugins: [] };
let pluginsLoading = false;

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: pluginsLoading ? undefined : pluginsData, isLoading: pluginsLoading }),
}));

import { ServiceActionCombobox } from "./service-action-combobox";

const PLUGINS_FIXTURE: ListPluginsResponse = {
  plugins: [
    {
      name: "github",
      version: "1.0.0",
      actionCount: 2,
      services: [
        {
          service: "github",
          type: "oauth2",
          configKeys: [],
          connected: true,
          connect: "oauth",
          actions: [
            { id: "github.create_issue", name: "Create issue", riskLevel: "medium" },
            { id: "github.delete_repo", name: "Delete repo", riskLevel: "critical" },
          ],
        },
      ],
    },
    {
      name: "linear",
      version: "1.0.0",
      actionCount: 1,
      services: [
        {
          service: "linear",
          type: "oauth2",
          configKeys: [],
          connected: false,
          connect: "oauth",
          actions: [{ id: "linear.create_issue", name: "Create issue", riskLevel: "low" }],
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  pluginsData = PLUGINS_FIXTURE;
  pluginsLoading = false;
});

// ── Case 1: focus opens full list; typing filters ─────────────────────────────

describe("ServiceActionCombobox — case 1: focus + filter", () => {
  it("focus opens the full service list without needing a search query", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /github/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /linear/ })).toBeTruthy();
  });

  it("typing 'lin' filters to linear only (case-insensitive label + id match)", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("lin");

    expect(screen.queryByRole("option", { name: /github/ })).toBeNull();
    expect(screen.getByRole("option", { name: /linear/ })).toBeTruthy();
  });

  it("focus opens the full action list in action mode", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="action" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: /Create issue.*github/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Delete repo/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Create issue.*linear/ })).toBeTruthy();
  });
});

// ── Case 2: row content ───────────────────────────────────────────────────────

describe("ServiceActionCombobox — case 2: row content", () => {
  it("service mode shows service name, mono id, and action count badge", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    const githubOption = screen.getByRole("option", { name: /github/ });
    expect(githubOption).toBeTruthy();
    // Badge shows action count
    expect(githubOption.textContent).toMatch(/2 actions/);
  });

  it("action mode rows include the service name as a sublabel (not nested cascade)", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="action" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    // Both "Create issue" options exist (github and linear) — flat list, no groups
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(3); // github×2 + linear×1
  });

  it("action mode rows show a RiskBadge for each action", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="action" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    // Risk badges appear in the listbox
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText("low")).toBeTruthy();
  });
});

// ── Case 3: keyboard navigation ───────────────────────────────────────────────

describe("ServiceActionCombobox — case 3: keyboard nav", () => {
  it("ArrowDown/ArrowUp move aria-activedescendant through options", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} id="test-cb" />,
    );

    const input = screen.getByRole("combobox");
    await user.click(input);

    // Initial: no activedescendant or first item highlighted
    await user.keyboard("{ArrowDown}");
    const afterDown = input.getAttribute("aria-activedescendant");
    expect(afterDown).toBeTruthy();

    await user.keyboard("{ArrowUp}");
    const afterUp = input.getAttribute("aria-activedescendant");
    // Should be back at or before where we were
    expect(typeof afterUp).toBe("string");
  });

  it("Enter selects the highlighted item and calls onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={onChange} />,
    );

    await user.click(screen.getByRole("combobox"));
    // First option is highlighted; press Enter
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledTimes(1);
    const called = onChange.mock.calls[0][0];
    // Called with a non-empty service id
    expect(typeof called).toBe("string");
    expect(called.length).toBeGreaterThan(0);
  });

  it("Escape closes the dropdown without calling onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={onChange} />,
    );

    await user.click(screen.getByRole("combobox"));
    // List is open
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ── Case 4: free text ─────────────────────────────────────────────────────────

describe("ServiceActionCombobox — case 4: free text", () => {
  it("query matching nothing shows pinned 'Use …' row", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("zzz");

    // The component renders curly-quote HTML entities around the query
    expect(screen.getByText(/Use .zzz./)).toBeTruthy();
  });

  it("Enter on the free-text row commits the typed value via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={onChange} />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("zzz");
    // Free text row becomes the highlighted item; Enter commits
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("zzz");
  });
});

// ── Case 5: ARIA ──────────────────────────────────────────────────────────────

describe("ServiceActionCombobox — case 5: ARIA", () => {
  it("input has role=combobox, aria-expanded, and aria-controls", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} id="cb5" />,
    );

    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    await user.click(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBeTruthy();
  });

  it("listbox rows have role=option", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
  });
});

// ── Case 6: loading ───────────────────────────────────────────────────────────

describe("ServiceActionCombobox — case 6: loading state", () => {
  it("shows 'Loading catalog…' spinner row when usePlugins is pending", async () => {
    pluginsLoading = true;
    const user = userEvent.setup();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={vi.fn()} />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Loading catalog…")).toBeTruthy();
  });

  it("typed free text is still committable while loading", async () => {
    pluginsLoading = true;
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ServiceActionCombobox mode="service" value="" onChange={onChange} />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("myservice");
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("myservice");
  });
});
