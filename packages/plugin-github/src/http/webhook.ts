/**
 * GitHub App webhook ingress. GitHub signs each delivery with the App's
 * webhook secret, not a per-installation secret, and the delivery names no
 * Valet organization. The host resolves the App and its owning organization.
 * This module verifies the raw bytes, parses the payload, and selects the
 * effects. The host binds those effects only after verification.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PluginHttpRequest, TriggerDef } from "@valet/engine";
import type {
  GithubDeliveryEffects,
  GithubPullRequestState,
  GithubPushRef,
  GithubWebhookCapability,
} from "./capabilities.js";
import { isRecord, json, noContent } from "./respond.js";

const SIG_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastSigFailureLogAt = 0;

/** Throttled, so a scan or replay flood cannot flood the log. */
function logSigFailureThrottled(message: string): void {
  const now = Date.now();
  if (now - lastSigFailureLogAt < SIG_FAILURE_LOG_INTERVAL_MS) return;
  lastSigFailureLogAt = now;
  console.warn(message);
}

/** Checks `X-Hub-Signature-256` over the exact request bytes in constant time. */
export function verifyWebhookSignature(rawBody: Uint8Array, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  // A webhook-less App stores an empty secret. An empty HMAC key must never
  // verify a guess.
  if (secret.length === 0) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const encoder = new TextEncoder();
  const a = encoder.encode(header);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The repository and ref a `push` names. Null when the payload is not a push. */
export function parseContentPushPayload(payload: unknown): GithubPushRef | null {
  if (!isRecord(payload) || Array.isArray(payload)) return null;
  if (typeof payload.ref !== "string" || payload.ref.length === 0) return null;
  const repository = payload.repository;
  if (!isRecord(repository) || Array.isArray(repository) || typeof repository.full_name !== "string") return null;
  const defaultBranch =
    typeof repository.default_branch === "string" && repository.default_branch.length > 0
      ? repository.default_branch
      : "main";
  return { repoFullName: repository.full_name, gitRef: payload.ref, defaultBranch };
}

/** The pull request state a `pull_request` payload names, if any. */
export function pullRequestWebhookState(payload: unknown): { url: string; state: GithubPullRequestState } | null {
  if (typeof payload !== "object" || payload === null || !("pull_request" in payload)) return null;
  const pr = payload.pull_request;
  if (typeof pr !== "object" || pr === null || !("html_url" in pr) || typeof pr.html_url !== "string") return null;
  const merged = "merged" in pr && pr.merged === true;
  const closed = "state" in pr && pr.state === "closed";
  return { url: pr.html_url, state: merged ? "merged" : closed ? "closed" : "open" };
}

function installationId(payload: unknown): number | null {
  if (!isRecord(payload) || !isRecord(payload.installation)) return null;
  return typeof payload.installation.id === "number" ? payload.installation.id : null;
}

/** The GitHub user who caused the delivery, as a string id. */
function senderId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.sender)) return null;
  return typeof payload.sender.id === "number" ? String(payload.sender.id) : null;
}

/**
 * `installation` event. `created` records the installation, binds a
 * personal one to its owner, and approves another organization's when an
 * org member installed it. `deleted`, `suspend`, and `unsuspend` change the row
 * from the payload alone, because webhook delivery has a short timeout.
 * Other actions, such as `new_permissions_accepted`, do nothing.
 */
async function handleInstallationEvent(effects: GithubDeliveryEffects, payload: unknown): Promise<void> {
  if (!isRecord(payload)) return;
  const id = installationId(payload);
  if (id === null) return;
  const { action } = payload;
  if (action === "deleted") {
    await effects.installationRemoved(id);
    return;
  }
  if (action === "suspend" || action === "unsuspend") {
    await effects.installationSuspended(id, action === "suspend");
    return;
  }
  if (action === "created") {
    try {
      await effects.installationCreated({ installation: payload.installation, senderId: senderId(payload) });
    } catch (err) {
      console.error("github-app webhook: discovery after installation.created failed:", err);
    }
  }
}

/** `installation_repositories` event: the payload carries the current
 * repository selection, so no GitHub call is needed. */
async function handleInstallationRepositoriesEvent(effects: GithubDeliveryEffects, payload: unknown): Promise<void> {
  if (!isRecord(payload)) return;
  const id = installationId(payload);
  if (id === null) return;
  const selection = typeof payload.repository_selection === "string" ? payload.repository_selection : undefined;
  await effects.repositorySelectionChanged(id, selection);
}

export async function receiveWebhook(
  request: PluginHttpRequest,
  webhook: GithubWebhookCapability,
  triggers: readonly TriggerDef[],
): Promise<Response> {
  // The webhook secret is App-level, so verification never needs the organization first.
  const delivery = await webhook.openDelivery();
  if (!delivery) return noContent();

  if (!verifyWebhookSignature(request.rawBody, request.headers["x-hub-signature-256"], delivery.webhookSecret)) {
    logSigFailureThrottled("github-app webhook: signature verification failed");
    return json({ error: "signature verification failed" }, 403);
  }

  let payload: unknown;
  try {
    // Keep a byte order mark, so a body that starts with one stays invalid JSON.
    payload = JSON.parse(new TextDecoder("utf-8", { ignoreBOM: true }).decode(request.rawBody));
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const effects = await delivery.bind({ installationId: installationId(payload) });
  if (!effects) return noContent();

  const event = request.headers["x-github-event"];
  // Anybody can install the public App, and the App's webhook secret signs
  // every installation's deliveries. Only installation lifecycle events
  // apply to an installation that does not serve this organization.
  const lifecycle = event === "installation" || event === "installation_repositories" || event === "ping";
  if (event && !lifecycle && !effects.acceptsEvents) {
    await effects.recordUndeliverable({
      deliveryId: request.headers["x-github-delivery"],
      detail: `github event ${event} from installation ${installationId(payload) ?? "none"}: the installation does not serve this organization`,
    });
    return noContent();
  }
  // A verified push marks every matching enabled source due. The sync runs
  // later under each source's own credential, so a push storm collapses into
  // one sync per source per tick.
  if (event === "push") {
    const push = parseContentPushPayload(payload);
    if (push) {
      await effects.contentPushed(push).catch((err) => {
        console.error(`content sync onPush (${push.repoFullName}):`, err);
      });
    }
  }
  // Thread pull request icons follow GitHub's state, whether or not a
  // subscription matches the delivery.
  if (event === "pull_request") {
    const pr = pullRequestWebhookState(payload);
    if (pr) {
      await effects.pullRequestChanged(pr).catch((err) => {
        console.error(`thread pull request state (${pr.url}):`, err);
      });
    }
  }
  if (event === "installation") {
    await handleInstallationEvent(effects, payload);
  } else if (event === "installation_repositories") {
    await handleInstallationRepositoriesEvent(effects, payload);
  } else if (event && event !== "ping") {
    // The signature is already verified, so build the event directly instead
    // of running the trigger's own verify.
    const deliveryId = request.headers["x-github-delivery"];
    const def = triggers.find((trigger) => trigger.service === "github" && trigger.id === `github.${event}`);
    if (def && deliveryId) {
      await effects.emit(def.toEvent({ eventType: event, deliveryId, payload }));
    } else {
      // Record the gap so operators can see events this deployment cannot ingest.
      await effects.recordUndeliverable({
        deliveryId,
        detail: def
          ? `github event ${event}: missing x-github-delivery header`
          : `github event ${event}: no registered TriggerDef (github.${event})`,
      });
    }
  }
  return noContent();
}
