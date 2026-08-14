// @vitest-environment jsdom
/**
 * The stored-skill editor form. This suite covers the invocation-aware parts
 * added for skills-as-commands: the `previewPromptBody` substitution, and the
 * editor rendering the invocation select and the prompt preview line.
 *
 * The api hooks are mocked the same way the index suite mocks `~/api/skills`:
 * this cares that the form renders from its props, not that TanStack Query or
 * the network work.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SkillResponse } from "@valet/api/wire";

vi.mock("~/api/skills", () => ({
  useCreateSkill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useUpdateSkill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

// Mutable so a test can simulate the org query resolving AFTER first render
// (the real query is async; a static mock hides initializer-race bugs).
let orgData: { callerRole: string } | undefined = { callerRole: "member" };
vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: orgData, isLoading: orgData === undefined, error: null }),
}));

// The split markdown editor pulls in CodeMirror; a plain textarea stand-in
// keeps this suite about the form, not the editor internals.
vi.mock("~/components/markdown-editor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea readOnly value={value} />,
}));

import { previewPromptBody, SkillEditor } from "./skill-editor";

const promptSkill: SkillResponse = {
  origin: "local",
  id: "skill_1",
  name: "standup",
  description: "Summarize the standup.",
  ownerType: "user",
  ownerId: "u1",
  shadowed: false,
  takesArgs: false,
  updatedAt: 0,
  invocation: "prompt",
  content: "Summarize $1 for $@",
  editable: true,
};

describe("previewPromptBody", () => {
  it("swaps numbered and all-args markers for readable placeholders", () => {
    expect(previewPromptBody("Summarize $1 for $@")).toBe("Summarize ⟨arg1⟩ for ⟨all args⟩");
    expect(previewPromptBody("$ARGUMENTS then $2")).toBe("⟨all args⟩ then ⟨arg2⟩");
  });

  it("leaves a body with no markers unchanged", () => {
    expect(previewPromptBody("Just do the thing")).toBe("Just do the thing");
  });
});

describe("SkillEditor", () => {
  it("shows the substitution preview for a prompt skill", () => {
    render(<SkillEditor skill={promptSkill} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Summarize ⟨arg1⟩ for ⟨all args⟩/)).toBeTruthy();
  });

  it("offers an invocation select", () => {
    render(<SkillEditor skill={promptSkill} onSaved={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByLabelText("Invocation");
    expect(select).toBeTruthy();
  });
});

describe("SkillEditor — org scope preselect", () => {
  it("honors ?scope=org when the admin flag resolves after first render", () => {
    // First render: org query still in flight → admin unknown → initializer
    // falls back to "You". The reset effect must pick Org once the flag lands.
    orgData = undefined;
    const { rerender } = render(<SkillEditor defaultScope="org" onSaved={() => {}} onCancel={() => {}} />);

    orgData = { callerRole: "admin" };
    rerender(<SkillEditor defaultScope="org" onSaved={() => {}} onCancel={() => {}} />);

    const select = screen.getByLabelText("Owner") as HTMLSelectElement;
    expect(select.value).toBe("org");
    orgData = { callerRole: "member" };
  });
});
