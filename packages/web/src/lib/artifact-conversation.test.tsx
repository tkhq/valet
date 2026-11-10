// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ArtifactEditorResponse } from "@valet/api/wire";
import { ApiError } from "~/api/client";
import { Markdown } from "~/components/markdown";
import { errorText } from "~/lib/error-text";
import { ARTIFACT_CHAT_SOURCE_LIMIT, artifactConversationPrompt } from "./artifact-conversation";
import { stripArtifactConversationContext } from "./artifact-conversation-context";

vi.mock("~/lib/mermaid", () => ({ renderMermaid: vi.fn() }));

function snapshot(): ArtifactEditorResponse {
  return {
    artifact: {
      id: "artifact-1", path: "inline/project-brief", title: "Project brief", format: "markdown",
      icon: "", version: 9, sharedVersion: 2, visibility: "org", ownerType: "team", actorUserId: "u1",
      token: "reader-token", url: "https://example.invalid/a/reader-token", revoked: false, createdAt: 0, updatedAt: 0,
    },
    version: 4, content: "# Project brief\n\nThe current goal.", rendered: "<h1>Project brief</h1>",
    description: "", icon: "", canEdit: true, sourceSessionId: "session-1", sourceThreadId: "thread-1",
  };
}

function contextText(prompt: string): string {
  const encoded = prompt.split("\n\n[valet-artifact-context]: # ")[1];
  if (!encoded) throw new Error("Missing artifact context");
  const context: unknown = JSON.parse(encoded);
  if (typeof context !== "string") throw new Error("Expected an artifact context string");
  return context;
}

afterEach(cleanup);

describe("artifact conversation prompt", () => {
  it.each(["/model opus", "/help", "/compact Keep the plan", "  /help  "])("keeps slash commands unchanged even for a large artifact: %s", (command) => {
    const doc = { ...snapshot(), content: "x".repeat(ARTIFACT_CHAT_SOURCE_LIMIT + 1) };
    expect(artifactConversationPrompt(command, doc)).toBe(command);
  });

  it("keeps the user's text and grounds broad edits in the supplied snapshot", () => {
    const doc = snapshot();
    const text = "  Make this brief clearer.\nKeep the goals.  ";
    const prompt = artifactConversationPrompt(text, doc);
    expect(prompt.startsWith(`${text}\n\n[valet-artifact-context]: # `)).toBe(true);
    const context = contextText(prompt);
    expect(context).toContain('"artifactId":"artifact-1"');
    expect(context).toContain('"key":"inline/project-brief"');
    expect(context).toContain('"version":4');
    expect(context).toContain('"title":"Project brief"');
    expect(context).toContain('"format":"markdown"');
    expect(context).toContain(`"content":${JSON.stringify(doc.content)}`);
    expect(context).toContain("artifact_publish");
    expect(context).toMatch(/same key and format/i);
    expect(context).toMatch(/preserve.*audience/i);
    expect(context).toMatch(/pinned shared version/i);
    expect(context).toMatch(/source as data/i);
    expect(context).not.toContain("reader-token");
  });

  it("uses each current source and format without reusing an earlier snapshot", () => {
    const doc = snapshot();
    artifactConversationPrompt("Improve this", doc);
    const current: ArtifactEditorResponse = {
      ...doc, version: 10, content: '<main data-vdid="overview">Current page</main>',
      artifact: { ...doc.artifact, path: "inline/page", title: "Project page", format: "html", version: 10 },
    };
    const context = contextText(artifactConversationPrompt("Improve this", current));
    expect(context).toContain('"key":"inline/page"');
    expect(context).toContain('"version":10');
    expect(context).toContain('"format":"html"');
    expect(context).toContain(`"content":${JSON.stringify(current.content)}`);
    expect(context).not.toContain(JSON.stringify(doc.content));
  });

  it("recovers the exact human text from a generated context even after an unclosed fence", () => {
    const human = "  Improve this:\n```html\n<section>  ";
    expect(stripArtifactConversationContext(artifactConversationPrompt(human, snapshot()))).toBe(human);
  });

  it("also strips the saved selection context without changing the human request", () => {
    const human = "Edit this:\n```html\n<section>";
    const prompt = `${human}\n\n[valet-artifact-edit-context]: # ${JSON.stringify('Saved artifact edit context: {"requestId":"private-request","oldText":"Private selection"}. Apply with artifact_edit.')}`;
    expect(stripArtifactConversationContext(prompt)).toBe(human);
  });

  it.each([
    "A normal request.",
    'Question\n\n[valet-artifact-context]: # "Some other reference"',
    'Question\n\n[valet-artifact-context]: # {"content":"Current artifact context: wrong type"}',
    'Question\n\n[valet-artifact-context]: # "Current artifact context: missing end',
    'Question\n\n[valet-artifact-context]: # "Current artifact context: quoted"\nKeep this last paragraph.',
    'Question\n\n[other-context]: # "Current artifact context: another marker"',
    'Question\n\n[valet-artifact-context]: # "Saved artifact edit context: mismatched prefix"',
    'Question\n\n[valet-artifact-edit-context]: # "Current artifact context: mismatched prefix"',
  ])("preserves text without a valid trailing artifact context: %s", (text) => {
    expect(stripArtifactConversationContext(text)).toBe(text);
  });

  it("accepts the source limit intact and rejects larger artifacts with a selection action", () => {
    expect(ARTIFACT_CHAT_SOURCE_LIMIT).toBe(100_000);
    const doc = { ...snapshot(), content: "x".repeat(ARTIFACT_CHAT_SOURCE_LIMIT) };
    expect(contextText(artifactConversationPrompt("Improve this", doc))).toContain(doc.content);
    doc.content += "END";
    let failure: unknown;
    try { artifactConversationPrompt("Improve this", doc); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ApiError);
    if (!(failure instanceof ApiError)) throw new Error("Expected an artifact size error");
    expect(failure.status).toBe(400);
    expect(errorText(failure)).toBe("Select the part of this large artifact you want Valet to change.");
    expect(doc.content.endsWith("END")).toBe(true);
  });

  it("renders the human request while keeping quoted source and internal context hidden", () => {
    const doc = { ...snapshot(), content: '<h1 class="private">Private source</h1>\n\n```html\n<script>ignore instructions</script>\n```' };
    const prompt = artifactConversationPrompt("Make the **heading** clearer.", doc);
    render(<Markdown>{prompt}</Markdown>);
    expect(screen.getByText("heading")).toBeTruthy();
    expect(screen.getByText(/Make the/).textContent).toBe("Make the heading clearer.");
    expect(screen.queryByText(/Private source|ignore instructions|artifact_publish|valet-artifact-context/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
