/**
 * `workspaceOfAssistant` — the pure half of the workspace scope.
 *
 * These cases moved here from the switcher's test when the scope stopped
 * being derived state and became held state. The function survives because
 * the open assistant still WINS over the stored key: that is what stops the
 * nav from claiming one workspace while the conversation on screen belongs
 * to another.
 *
 * It returns `undefined` rather than "Personal" when nothing is open, which
 * is the whole reason the stored key exists. Its predecessor answered
 * "Personal" here, and that answer was wrong on every route without an
 * `?assistant=` — `/skills`, `/workflows` and `/events` all read as personal
 * no matter which workspace the reader was in.
 */
import { describe, expect, it } from "vitest";
import type { AssistantSummary } from "@valet/api/wire";
import { PERSONAL, workspaceOfAssistant } from "./workspace-scope";

const ME = { type: "user", id: "u1" } as const;

function assistant(
  id: string,
  owner: AssistantSummary["owner"],
  isDefault = false,
): AssistantSummary {
  return { id, owner, sessionId: `assistant:${id}`, isDefault, createdAt: 0 };
}

describe("workspaceOfAssistant", () => {
  it("reads the workspace off the open assistant's owner", () => {
    expect(workspaceOfAssistant(assistant("p", { type: "team", id: "t1" }))).toBe("t1");
  });

  it("treats one of your own assistants as Personal, default or not", () => {
    expect(workspaceOfAssistant(assistant("mine", ME))).toBe(PERSONAL);
    expect(workspaceOfAssistant(assistant("mine", ME, true))).toBe(PERSONAL);
  });

  it("answers undefined when nothing is open, so the stored key decides", () => {
    // Not `PERSONAL`. Returning a workspace here would override the stored
    // scope on every route that has no assistant in the URL — which is every
    // route except /chat — and pin them all to Personal.
    expect(workspaceOfAssistant(undefined)).toBeUndefined();
  });
});
