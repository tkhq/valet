// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { buildSkillBlock } from "@valet/shared";
import type { StreamMessage } from "~/stores/stream";
import { TooltipProvider } from "~/components/primitives";
import { MessageItem } from "./message-item";

vi.mock("~/lib/mermaid", () => ({ renderMermaid: vi.fn() }));

const human = "Make this clearer:\n```html\n<section>";
const metadata = JSON.stringify('Current artifact context: {"artifactId":"private-artifact","content":"SECRET_ARTIFACT_SOURCE"}. Use artifact_publish with the same key and format.');
const contextual = `${human}\n\n[valet-artifact-context]: # ${metadata}`;

function message(role: "user" | "assistant", textParts: boolean, content = contextual): StreamMessage {
  return { id: "m1", sessionId: "s1", threadId: "t1", role, createdAt: 0,
    content, parts: textParts ? [{ kind: "text", text: content }] : [] };
}

afterEach(cleanup);

describe("artifact conversation message text", () => {
  it.each([false, true])("hides internal context after an unclosed user fence and copies only the request (parts: %s)", async (textParts) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<TooltipProvider><MessageItem message={message("user", textParts)} ratings={false} /></TooltipProvider>);
    expect(container.textContent).toContain("Make this clearer:");
    expect(container.textContent).toContain("<section>");
    expect(container.textContent).not.toMatch(/SECRET_ARTIFACT_SOURCE|valet-artifact-context|artifact_publish/);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(human));
  });

  it("keeps assistant text that quotes the same marker unchanged", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<TooltipProvider><MessageItem message={message("assistant", true)} ratings={false} /></TooltipProvider>);
    expect(container.textContent).toContain("SECRET_ARTIFACT_SOURCE");
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(contextual));
  });

  it("hides saved selection context after an unclosed fence and leaves it out of copied text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const selection = `${human}\n\n[valet-artifact-edit-context]: # ${JSON.stringify('Saved artifact edit context: {"requestId":"private-request","oldText":"SECRET_SELECTION_SOURCE"}. Apply with artifact_edit.')}`;
    const { container } = render(<TooltipProvider><MessageItem message={message("user", true, selection)} ratings={false} /></TooltipProvider>);
    expect(container.textContent).toContain("Make this clearer:");
    expect(container.textContent).not.toMatch(/SECRET_SELECTION_SOURCE|private-request|valet-artifact-edit-context|artifact_edit/);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(human));
  });

  it("keeps a saved skill invocation readable and copies its arguments without artifact context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const skillMessage = { ...message("user", false), content: buildSkillBlock("review", "Review the artifact.", contextual), skill: { name: "review", args: contextual } };
    const { container } = render(<TooltipProvider><MessageItem message={skillMessage} ratings={false} /></TooltipProvider>);
    expect(container.textContent).toContain("Make this clearer:");
    expect(container.textContent).not.toMatch(/SECRET_ARTIFACT_SOURCE|valet-artifact-context|artifact_publish/);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`/skill:review ${human}`));
  });
});
