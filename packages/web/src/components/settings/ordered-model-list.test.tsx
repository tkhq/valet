// @vitest-environment jsdom
/**
 * OrderedModelList add typeahead — keyboard and ARIA for the combobox
 * pattern. Arrow keys move aria-activedescendant; Enter adds the
 * highlighted model; Escape closes.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelInfo } from "@valet/api/wire";
import { OrderedModelList } from "./ordered-model-list";

const CATALOG: ModelInfo[] = [
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    providerId: "anthropic",
    providerKind: "anthropic",
    providerName: "Anthropic",
    active: true,
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    providerId: "anthropic",
    providerKind: "anthropic",
    providerName: "Anthropic",
    active: true,
  },
  {
    id: "openai/gpt-5",
    name: "GPT-5",
    providerId: "openai",
    providerKind: "openai",
    providerName: "OpenAI",
    active: true,
  },
];

function renderList(onChange = vi.fn(), preferences: string[] = []) {
  return render(
    <OrderedModelList
      preferences={preferences}
      catalog={CATALOG}
      firstBadge="First"
      onChange={onChange}
    />,
  );
}

describe("OrderedModelList add typeahead", () => {
  it("ArrowDown and ArrowUp move aria-activedescendant through options", async () => {
    const user = userEvent.setup();
    renderList();

    const input = screen.getByRole("combobox", { name: "Search models to add" });
    await user.click(input);

    const first = screen.getByRole("option", { name: /Claude Haiku 4.5/ });
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}");
    const second = screen.getByRole("option", { name: /Claude Sonnet 4.5/ });
    expect(input.getAttribute("aria-activedescendant")).toBe(second.id);
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(first.getAttribute("aria-selected")).toBe("false");

    await user.keyboard("{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
  });

  it("Enter adds the highlighted model", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderList(onChange);

    await user.click(screen.getByRole("combobox", { name: "Search models to add" }));
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith(["anthropic/claude-sonnet-4-5"]);
  });

  it("Escape closes the list without adding", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderList(onChange);

    await user.click(screen.getByRole("combobox", { name: "Search models to add" }));
    expect(screen.getByRole("listbox")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
