// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PromptFields } from "./prompt-fields";

describe("PromptFields", () => {
  // A Slack rule showed "Triage this pull request" and GitHub payload
  // fields as its examples.
  it("shows examples that fit any event, not one source's payload", () => {
    render(<PromptFields idPrefix="t" value={{ systemPrompt: "", userPromptTemplate: "" }} onChange={() => {}} />);
    const examples = [
      screen.getByLabelText(/Instructions for the assistant/).getAttribute("placeholder") ?? "",
      screen.getByLabelText(/Event message/).getAttribute("placeholder") ?? "",
    ];
    for (const example of examples) {
      expect(example).not.toMatch(/pull request|payload\./i);
      for (const variable of example.match(/\{\{[^}]+\}\}/g) ?? []) expect(variable).toMatch(/^\{\{event\.(key|summary)\}\}$/);
    }
    expect(examples[1]).toContain("{{event.summary}}");
  });
});
