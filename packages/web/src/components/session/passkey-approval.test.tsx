// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DecisionGate, PresenceStepResponse } from "@valet/api/wire";

const getPasskeyStep = vi.fn<() => Promise<PresenceStepResponse>>();
const postPasskeyStep = vi.fn<(s: string, g: string, b: unknown) => Promise<PresenceStepResponse>>();
vi.mock("~/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/api/client")>()),
  api: {
    getPasskeyStep: () => getPasskeyStep(),
    postPasskeyStep: (s: string, g: string, b: unknown) => postPasskeyStep(s, g, b),
  },
}));
vi.mock("@turnkey/sdk-browser", () => ({ WebauthnStamper: class {} }));

import { PasskeyApproval } from "./passkey-approval";

const gate: DecisionGate = {
  id: "g1",
  sessionId: "s1",
  threadId: "t1",
  type: "credential_request",
  title: "Sign 2 commits",
  actions: [{ id: "approve", label: "Sign with passkey" }, { id: "reject", label: "Reject" }],
  status: "pending",
  createdAt: 1,
  updatedAt: 1,
  assurance: "presence",
  presence: {
    kind: "git_commits",
    repo: "tkhq/valet",
    branch: "feature",
    commits: [
      { sha: "a".repeat(40), subject: "first commit", author: "A <a@x>" },
      { sha: "b".repeat(40), subject: "second commit", author: "A <a@x>" },
    ],
  },
};

beforeEach(() => {
  getPasskeyStep.mockReset();
  postPasskeyStep.mockReset();
});

const view = gate.presence ?? { kind: "challenge" as const };

function renderCard(stamp = vi.fn(async (body: string) => ({ stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: `stamp:${body}` }))) {
  const onDone = vi.fn();
  const onReject = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PasskeyApproval sessionId="s1" gate={gate} view={view} inset="" busy={false} onDone={onDone} onReject={onReject} stamp={stamp} />
    </QueryClientProvider>,
  );
  return { stamp, onDone, onReject };
}

describe("PasskeyApproval", () => {
  it("lists the commits and signs each step with the passkey until done", async () => {
    getPasskeyStep.mockResolvedValue({ done: false, index: 0, total: 2, label: "Commit 1 of 2: first commit", body: "body-1" });
    postPasskeyStep
      .mockResolvedValueOnce({ done: false, index: 1, total: 2, label: "Commit 2 of 2: second commit", body: "body-2" })
      .mockResolvedValueOnce({ done: true });
    const { stamp, onDone } = renderCard();
    expect(screen.getByText("first commit")).toBeTruthy();
    expect(screen.getByText("aaaaaaa")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign with passkey" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(stamp.mock.calls.map((c) => c[0])).toEqual(["body-1", "body-2"]);
    expect(postPasskeyStep).toHaveBeenNthCalledWith(1, "s1", "g1", { body: "body-1", stampHeaderName: "X-Stamp-WebAuthn", stampHeaderValue: "stamp:body-1" });
  });

  it("shows the error and stays open when the passkey is cancelled", async () => {
    getPasskeyStep.mockResolvedValue({ done: false, index: 0, total: 1, label: "Sign", body: "body-1" });
    const { onDone } = renderCard(vi.fn(async () => { throw new Error("The operation was cancelled"); }));
    fireEvent.click(screen.getByRole("button", { name: "Sign with passkey" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("cancelled"));
    expect(onDone).not.toHaveBeenCalled();
    expect(postPasskeyStep).not.toHaveBeenCalled();
  });

  it("rejects with one click", () => {
    const { onReject } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
