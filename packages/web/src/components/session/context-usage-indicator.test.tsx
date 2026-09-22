// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "~/components/primitives";
import { ContextUsageIndicator } from "./context-usage-indicator";

describe("ContextUsageIndicator", () => {
  it("shows the estimated occupancy percentage", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator
          context={{
            model: "openai/gpt-test",
            estimatedTokens: 25_000,
            contextWindow: 100_000,
            compactionOccurred: false,
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("context-usage").textContent).toContain("25%");
  });

  it("clamps estimates above the published limit to 100 percent", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator
          context={{
            model: "openai/gpt-test",
            estimatedTokens: 125_000,
            contextWindow: 100_000,
            compactionOccurred: false,
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("context-usage").textContent).toContain("100%");
  });

  it("does not invent a percentage for an unknown limit", () => {
    render(
      <TooltipProvider>
        <ContextUsageIndicator
          context={{
            model: "custom/model",
            estimatedTokens: 25_000,
            contextWindow: null,
            compactionOccurred: false,
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("context-usage").textContent).toBe(
      "Estimated context: unknown limit",
    );
  });
});
