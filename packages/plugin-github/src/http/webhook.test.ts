import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginHttpRequest } from "@valet/engine";
import { githubTriggerDefs } from "../triggers.js";
import type { GithubDeliveryEffects, GithubWebhookCapability, GithubWebhookDelivery } from "./capabilities.js";
import { receiveWebhook, verifyWebhookSignature } from "./webhook.js";

const SECRET = "hook-secret";

function request(body: string, headers: Record<string, string>): PluginHttpRequest {
  return {
    url: "https://valet.test/webhooks/github-app",
    headers: { "content-type": "application/json", ...headers },
    params: {},
    rawBody: new TextEncoder().encode(body),
    signal: new AbortController().signal,
  };
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

type Effects = GithubDeliveryEffects;

function effects(acceptsEvents = true) {
  return {
    acceptsEvents,
    contentPushed: vi.fn<Effects["contentPushed"]>(async () => {}),
    pullRequestChanged: vi.fn<Effects["pullRequestChanged"]>(async () => {}),
    installationRemoved: vi.fn<Effects["installationRemoved"]>(async () => {}),
    installationSuspended: vi.fn<Effects["installationSuspended"]>(async () => {}),
    repositorySelectionChanged: vi.fn<Effects["repositorySelectionChanged"]>(async () => {}),
    installationCreated: vi.fn<Effects["installationCreated"]>(async () => {}),
    emit: vi.fn<Effects["emit"]>(async () => {}),
    recordUndeliverable: vi.fn<Effects["recordUndeliverable"]>(async () => {}),
  } satisfies Effects;
}

function webhook(bound: Effects | null, secret = SECRET) {
  const bind = vi.fn<GithubWebhookDelivery["bind"]>(async () => bound);
  const capability: GithubWebhookCapability = { openDelivery: async () => ({ webhookSecret: secret, bind }) };
  return { capability, bind };
}

describe("verifyWebhookSignature", () => {
  it("accepts only the exact bytes signed with the secret", () => {
    const body = new TextEncoder().encode('{"a":1}');
    expect(verifyWebhookSignature(body, sign('{"a":1}'), SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, sign('{"a": 1}'), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, sign('{"a":1}', "other"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=short", SECRET)).toBe(false);
  });

  it("never verifies with an empty secret", () => {
    const body = new TextEncoder().encode("{}");
    expect(verifyWebhookSignature(body, sign("{}", ""), "")).toBe(false);
  });
});

describe("receiveWebhook", () => {
  it("acknowledges with 204 when no App is configured", async () => {
    const response = await receiveWebhook(request("{}", {}), { openDelivery: async () => null }, githubTriggerDefs);
    expect(response.status).toBe(204);
  });

  it("refuses a bad signature before binding any effect", async () => {
    const { capability, bind } = webhook(effects());
    const body = JSON.stringify({ action: "deleted", installation: { id: 1 } });
    const response = await receiveWebhook(
      request(body, { "x-github-event": "installation", "x-hub-signature-256": sign(body, "wrong") }),
      capability,
      githubTriggerDefs,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "signature verification failed" });
    expect(bind).not.toHaveBeenCalled();
  });

  it("refuses a signed body that is not JSON, including one with a byte order mark", async () => {
    for (const body of ["not json", '﻿{"zen":"x"}']) {
      const { capability, bind } = webhook(effects());
      const response = await receiveWebhook(
        request(body, { "x-github-event": "ping", "x-hub-signature-256": sign(body) }),
        capability,
        githubTriggerDefs,
      );
      expect(response.status).toBe(400);
      expect(bind).not.toHaveBeenCalled();
    }
  });

  it("binds with the verified installation ID and applies installation actions", async () => {
    const bound = effects();
    const { capability, bind } = webhook(bound);
    for (const action of ["deleted", "suspend", "unsuspend", "created", "new_permissions_accepted"]) {
      const body = JSON.stringify({ action, installation: { id: 42 } });
      const response = await receiveWebhook(
        request(body, { "x-github-event": "installation", "x-hub-signature-256": sign(body) }),
        capability,
        githubTriggerDefs,
      );
      expect(response.status).toBe(204);
    }
    expect(bind).toHaveBeenCalledWith({ installationId: 42 });
    expect(bound.installationRemoved).toHaveBeenCalledWith(42);
    expect(bound.installationSuspended.mock.calls).toEqual([[42, true], [42, false]]);
    expect(bound.installationCreated.mock.calls).toEqual([[{ installationId: 42, senderId: null }]]);
    expect(bound.emit).not.toHaveBeenCalled();
  });

  it("passes the installing GitHub user to the host", async () => {
    // The host approves another organization's installation only when an
    // org member installed it.
    const bound = effects();
    const { capability } = webhook(bound);
    const body = JSON.stringify({ action: "created", installation: { id: 42 }, sender: { id: 4242 } });
    await receiveWebhook(
      request(body, { "x-github-event": "installation", "x-hub-signature-256": sign(body) }),
      capability,
      githubTriggerDefs,
    );
    expect(bound.installationCreated.mock.calls).toEqual([[{ installationId: 42, senderId: "4242" }]]);
  });

  it("keeps acknowledging when best-effort effects fail", async () => {
    const bound = effects();
    bound.contentPushed.mockRejectedValueOnce(new Error("sync down"));
    bound.installationCreated.mockRejectedValueOnce(new Error("GitHub down"));
    const { capability } = webhook(bound);
    const push = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "acme/app" } });
    const created = JSON.stringify({ action: "created", installation: { id: 7 } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await receiveWebhook(request(push, { "x-github-event": "push", "x-hub-signature-256": sign(push) }), capability, githubTriggerDefs)).status).toBe(204);
      expect((await receiveWebhook(request(created, { "x-github-event": "installation", "x-hub-signature-256": sign(created) }), capability, githubTriggerDefs)).status).toBe(204);
    } finally {
      errors.mockRestore();
    }
    expect(bound.contentPushed).toHaveBeenCalledWith({ repoFullName: "acme/app", gitRef: "refs/heads/main", defaultBranch: "main" });
  });

  it("emits a matching trigger event and records events no trigger can ingest", async () => {
    const bound = effects();
    const { capability } = webhook(bound);
    const pr = JSON.stringify({ action: "closed", pull_request: { html_url: "https://github.com/acme/app/pull/1", state: "closed", merged: true } });
    await receiveWebhook(
      request(pr, { "x-github-event": "pull_request", "x-github-delivery": "d-1", "x-hub-signature-256": sign(pr) }),
      capability,
      githubTriggerDefs,
    );
    expect(bound.pullRequestChanged).toHaveBeenCalledWith({ url: "https://github.com/acme/app/pull/1", state: "merged" });
    expect(bound.emit).toHaveBeenCalledOnce();
    expect(bound.emit.mock.calls[0][0]).toMatchObject({ dedupeKey: "d-1" });

    await receiveWebhook(
      request(pr, { "x-github-event": "pull_request", "x-hub-signature-256": sign(pr) }),
      capability,
      githubTriggerDefs,
    );
    await receiveWebhook(
      request(pr, { "x-github-event": "unknown_family", "x-github-delivery": "d-2", "x-hub-signature-256": sign(pr) }),
      capability,
      githubTriggerDefs,
    );
    expect(bound.recordUndeliverable.mock.calls).toEqual([
      [{ deliveryId: undefined, detail: "github event pull_request: missing x-github-delivery header" }],
      [{ deliveryId: "d-2", detail: "github event unknown_family: no registered TriggerDef (github.unknown_family)" }],
    ]);
  });

  // The App is public. A stranger who installs it and opens a pull request
  // must not start the organization's subscriptions with text they wrote.
  it("drops every non-installation event from an installation that does not serve the organization", async () => {
    const bound = effects(false);
    const { capability } = webhook(bound);
    const pr = JSON.stringify({
      action: "opened", installation: { id: 777 },
      pull_request: { html_url: "https://github.com/stranger/app/pull/1", state: "open" },
    });
    const push = JSON.stringify({ ref: "refs/heads/main", installation: { id: 777 }, repository: { full_name: "stranger/app" } });
    for (const [event, body] of [["pull_request", pr], ["push", push]] as const) {
      expect(
        (await receiveWebhook(
          request(body, { "x-github-event": event, "x-github-delivery": `d-${event}`, "x-hub-signature-256": sign(body) }),
          capability,
          githubTriggerDefs,
        )).status,
      ).toBe(204);
    }
    expect(bound.emit).not.toHaveBeenCalled();
    expect(bound.pullRequestChanged).not.toHaveBeenCalled();
    expect(bound.contentPushed).not.toHaveBeenCalled();
    expect(bound.recordUndeliverable.mock.calls).toEqual([
      [{ deliveryId: "d-pull_request", detail: "github event pull_request from installation 777: the installation does not serve this organization" }],
      [{ deliveryId: "d-push", detail: "github event push from installation 777: the installation does not serve this organization" }],
    ]);

    // Installation lifecycle events still apply, so the row stays current.
    const deleted = JSON.stringify({ action: "deleted", installation: { id: 777 } });
    await receiveWebhook(
      request(deleted, { "x-github-event": "installation", "x-hub-signature-256": sign(deleted) }),
      capability,
      githubTriggerDefs,
    );
    expect(bound.installationRemoved).toHaveBeenCalledWith(777);
  });

  it("acknowledges a verified delivery with no organization to receive it", async () => {
    const { capability } = webhook(null);
    const body = JSON.stringify({ zen: "x" });
    const response = await receiveWebhook(
      request(body, { "x-github-event": "ping", "x-hub-signature-256": sign(body) }),
      capability,
      githubTriggerDefs,
    );
    expect(response.status).toBe(204);
  });
});
