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
import userEvent from "@testing-library/user-event";
import type { SkillResponse } from "@valet/api/wire";

const createSkill = vi.fn();
vi.mock("~/api/skills", () => ({
  useCreateSkill: () => ({ mutate: createSkill, isPending: false, error: null }),
  useUpdateSkill: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

// Mutable so a test can simulate the org query resolving AFTER first render
// (the real query is async; a static mock hides admin-flag race bugs).
let orgData: { callerRole: string } | undefined = { callerRole: "member" };
vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: orgData, isLoading: orgData === undefined, error: null }),
}));

// The split markdown editor pulls in CodeMirror; a plain textarea stand-in
// keeps this suite about the form, not the editor internals. It is writable,
// because the form only submits once the playbook holds something.
vi.mock("~/components/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (next: string) => void;
    ariaLabel?: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
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

describe("SkillEditor — the org scope", () => {
  it("honors ?scope=org when the admin flag resolves after first render", async () => {
    const user = userEvent.setup();
    createSkill.mockClear();
    // First render: the org query is still in flight, so the admin flag is
    // unknown. The owner is read at submit, not at mount, so a slow query
    // cannot file an org skill as a personal one.
    orgData = undefined;
    const { rerender } = render(<SkillEditor defaultScope="org" onSaved={() => {}} onCancel={() => {}} />);

    orgData = { callerRole: "admin" };
    rerender(<SkillEditor defaultScope="org" onSaved={() => {}} onCancel={() => {}} />);

    // No Owner field: the page that opened the form said which library this
    // skill belongs to.
    expect(screen.queryByLabelText("Owner")).toBeNull();

    await user.type(screen.getByLabelText("Name"), "org-thing");
    await user.type(screen.getByLabelText("Description"), "An org skill.");
    await user.type(screen.getByRole("textbox", { name: "Playbook" }), "Do it.");
    await user.click(screen.getByRole("button", { name: "Create skill" }));

    expect(createSkill).toHaveBeenCalledTimes(1);
    const [body] = createSkill.mock.calls[0] as [{ ownerType?: string }];
    expect(body.ownerType).toBe("org");
    orgData = { callerRole: "member" };
  });
});
