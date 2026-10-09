// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Message } from "@valet/api/wire";
import { api } from "~/api/client";
import { ThreadContextPanel } from "./thread-context-panel";

vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
vi.mock("~/api/channels", () => ({ useThreadChannelActivity: () => ({ data: undefined }) }));

it("opens shared links in a new tab and downloads uploaded files", () => {
  vi.spyOn(api, "listArtifacts").mockResolvedValue({ artifacts: [] });
  const message: Message = {
    id: "m1", sessionId: "s1", threadId: "t1", role: "user", parts: [], createdAt: 1,
    content: "Read https://docs.google.com/document/d/abc/edit and [the deck](https://docs.google.com/presentation/d/xyz).",
    attachments: [{ kind: "file", path: "/workspace/uploads/Q3 report.pdf", bytes: 10, sha256: "h", name: "Q3 report.pdf" }],
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThreadContextPanel owner={{ ownerType: "user", ownerId: "u" }} sessionId="s1" threadId="t1" messages={[message]} busy={false}
        onCreate={() => {}} onAttach={() => {}} onReveal={() => {}} />
    </QueryClientProvider>,
  );
  const sources = within(screen.getByRole("region", { name: "Sources" }));

  const file = sources.getByRole("link", { name: "Q3 report.pdf" });
  expect(file.getAttribute("href")).toBe("/api/sessions/s1/threads/t1/files?path=%2Fworkspace%2Fuploads%2FQ3+report.pdf");
  expect(file.getAttribute("download")).toBe("Q3 report.pdf");
  expect(file.getAttribute("target")).toBeNull();

  for (const [name, href] of [
    ["docs.google.com/document/d/abc/edit", "https://docs.google.com/document/d/abc/edit"],
    ["the deck", "https://docs.google.com/presentation/d/xyz"],
  ]) {
    const link = sources.getByRole("link", { name });
    expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel"), link.hasAttribute("download")])
      .toEqual([href, "_blank", "noopener noreferrer", false]);
  }
});

function renderPanel(messages: Message[], pullRequests?: Parameters<typeof ThreadContextPanel>[0]["pullRequests"]) {
  vi.spyOn(api, "listArtifacts").mockResolvedValue({ artifacts: [] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ThreadContextPanel owner={{ ownerType: "user", ownerId: "u" }} sessionId="s1" threadId="t1" messages={messages} busy={false}
        pullRequests={pullRequests} onCreate={() => {}} onAttach={() => {}} onReveal={() => {}} />
    </QueryClientProvider>,
  );
}

it("lists the thread's pull requests in Outputs and groups the ones a child opened", async () => {
  renderPanel([], [
    { url: "https://github.com/acme/valet/pull/9", repo: "acme/valet", number: 9, state: "merged" },
    { url: "https://github.com/acme/valet/pull/852", repo: "acme/valet", number: 852, state: "open",
      delegatedFrom: { sessionId: "child-1", threadId: "ct", title: "Investigate OpenAI images" } },
    // The API leaves the title out when the viewer cannot open the child.
    { url: "https://github.com/acme/valet/pull/853", repo: "acme/valet", number: 853, state: "open",
      delegatedFrom: { sessionId: "child-2", threadId: "ct2" } },
  ]);
  const outputs = within(screen.getByRole("region", { name: "Outputs" }));
  const own = outputs.getByRole("link", { name: /valet #9/ });
  expect(own.getAttribute("href")).toBe("https://github.com/acme/valet/pull/9");
  expect(own.textContent).toContain("Merged");

  const delegated = within(outputs.getByRole("group", { name: "From delegated work" }));
  const child = delegated.getByRole("link", { name: /valet #852/ });
  expect(child.textContent).toContain("via Investigate OpenAI images");
  expect(child.getAttribute("target")).toBe("_blank");
  expect(delegated.getByRole("link", { name: /valet #853/ }).textContent).toContain("via a delegated thread");
  // The thread's own pull request is not in the delegated group.
  expect(delegated.queryByRole("link", { name: /valet #9\b/ })).toBeNull();
  // A thread with outputs does not offer to create its first one.
  expect(await outputs.findByRole("link", { name: /valet #9/ })).toBeTruthy();
  expect(outputs.queryByRole("button", { name: "Create a file or site" })).toBeNull();
});

it("keeps a child's report out of Sources while keeping links people shared", () => {
  const shared: Message = { id: "m1", sessionId: "s1", threadId: "t1", role: "user", parts: [], createdAt: 1,
    content: "Use [the image guide](https://platform.openai.com/docs/guides/images)." };
  const report: Message = { id: "m2", sessionId: "s1", threadId: "t1", role: "user", parts: [], createdAt: 2,
    content: "Opened [PR #852](https://github.com/acme/valet/pull/852).",
    signal: { signalType: "child.settled" } };
  renderPanel([shared, report]);
  const sources = within(screen.getByRole("region", { name: "Sources" }));
  expect(sources.getByRole("link", { name: "the image guide" })).toBeTruthy();
  expect(sources.queryByRole("link", { name: "PR #852" })).toBeNull();
});
