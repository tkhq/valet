// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { HandlerSettingsForm, handlerOptions, sameSettings, settingsFields, withSetting, type HandlerConfig } from "./handler-settings";

/** The PR review handler's settings, as `GET /api/plugins` sends them. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    instructions: { type: "string", default: "", maxLength: 8000, description: "Extra review instructions." },
    excludePaths: { type: "array", items: { type: "string", minLength: 1 }, default: [], description: "Globs of paths not to review." },
    minSeverity: { anyOf: [{ const: "low" }, { const: "medium" }, { const: "high" }, { const: "critical" }], default: "low" },
    reviewDrafts: { type: "boolean", default: false },
    model: { type: "string", default: "anthropic/claude-sonnet-5-5" },
  },
};

let latest: HandlerConfig = {};

function Harness({ initial = {} }: { initial?: HandlerConfig }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <HandlerSettingsForm schema={SCHEMA} value={value} onChange={setValue} />;
}

describe("settingsFields", () => {
  it("reads each property of the schema as a field, in order", () => {
    expect(settingsFields(SCHEMA)?.map((f) => [f.key, f.kind, f.label])).toEqual([
      ["instructions", "text", "Instructions"],
      ["excludePaths", "list", "Exclude paths"],
      ["minSeverity", "choice", "Min severity"],
      ["reviewDrafts", "toggle", "Review drafts"],
      ["model", "text", "Model"],
    ]);
  });

  it("gives up on a shape it cannot show", () => {
    expect(settingsFields({ type: "object", properties: { nested: { type: "object" } } })).toBeNull();
    expect(settingsFields({ type: "string" })).toBeNull();
  });
});

describe("withSetting", () => {
  it("keeps a changed setting and drops one equal to the default", () => {
    const [instructions] = settingsFields(SCHEMA)!;
    expect(withSetting({}, instructions!, "Check auth.")).toEqual({ instructions: "Check auth." });
    expect(withSetting({ instructions: "Check auth." }, instructions!, "")).toEqual({});
  });
});

describe("sameSettings", () => {
  it("ignores key order, which the server's jsonb does not keep", () => {
    expect(sameSettings({ instructions: "a", minSeverity: "high" }, { minSeverity: "high", instructions: "a" })).toBe(true);
    expect(sameSettings({ excludePaths: ["a", "b"] }, { excludePaths: ["b", "a"] })).toBe(false);
  });
});

describe("HandlerSettingsForm", () => {
  it("shows the defaults and stores only what the reader changes", () => {
    render(<Harness />);
    expect((screen.getByLabelText("Min severity") as HTMLSelectElement).value).toBe("low");
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("anthropic/claude-sonnet-5-5");
    fireEvent.change(screen.getByLabelText("Min severity"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Exclude paths"), { target: { value: "dist/\n\n**/*.lock\n" } });
    expect(latest).toEqual({ minSeverity: "high", excludePaths: ["dist/", "**/*.lock"] });
    // The empty line the reader is typing stays in the box.
    expect((screen.getByLabelText("Exclude paths") as HTMLTextAreaElement).value).toBe("dist/\n\n**/*.lock\n");
  });

  it("says so when the schema has no form", () => {
    render(<HandlerSettingsForm schema={{ type: "object", properties: { nested: { type: "object" } } }} value={{}} onChange={() => {}} />);
    expect(screen.getByText(/Change them through the API/)).toBeTruthy();
  });
});

describe("handlerOptions", () => {
  it("lists every plugin's handlers under the plugin's name", () => {
    expect(handlerOptions([
      { name: "pr-review", displayName: "PR review", version: "1", actionCount: 0, services: [], eventHandlers: [{ id: "review-pull-request", description: "Review.", events: ["github.pull_request.opened"] }] },
      { name: "bare", version: "1", actionCount: 0, services: [] },
    ])).toEqual([{ plugin: "pr-review", id: "review-pull-request", label: "PR review: Review pull request", description: "Review.", events: ["github.pull_request.opened"] }]);
  });
});
