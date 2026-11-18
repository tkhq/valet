/**
 * Passkey approval steps for decision gates
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 *   GET  /api/sessions/:id/decisions/:gateId/passkey   the next step to stamp
 *   POST /api/sessions/:id/decisions/:gateId/passkey   a stamped step
 *   (and the same under /api/threads/:threadId/decisions/:gateId/passkey)
 *
 * Both answer `{ done: false, index, total, label, body }` for the next step,
 * or `{ done: true }` once the gate is resolved. The browser stamps `body`
 * with the person's passkey (`WebauthnStamper`) and posts it back. The api
 * checks the body is the step it issued, forwards it to Turnkey unchanged,
 * checks the completed activity, and after the last step resolves the gate
 * with `assurance: "presence"` and a proof of presence shaped as an AuthZEN
 * approval object (`presenceApproval`). That is the only code that sets it.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { gateAssurance, isApprovingAction, type AuthzenApproval, type DecisionGate as EngineDecisionGate } from "@valet/engine";
import { loadTurnkeyConfig, type TurnkeyDeploymentConfig } from "@valet/plugin-turnkey/config";
import { presenceStepsKey, signingContextOf } from "@valet/plugin-turnkey/presence";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc, type PresenceStepsDoc } from "@valet/plugin-turnkey/store";
import { turnkeyOps, type TurnkeyOpsFactory } from "@valet/plugin-turnkey/turnkey-client";
import type { AppEnv } from "../env.js";
import { isAgentCaller } from "../lib/request-principal.js";
import { pluginStore } from "../services/plugin-store.js";
import {
  nextPresenceStep,
  stepBody,
  submittedBodyRefusal,
  verifiedTap,
  type PresenceSigner,
  type PresenceStep,
} from "../services/passkey-approval/steps.js";
import { forwardStampedSignature, isWebauthnStamp, settleActivity, type ForwardStamped } from "../services/passkey-approval/turnkey-forward.js";
import { answersGate } from "../services/session-access.js";
import type { PresenceStepResponse } from "../wire/types.js";
import { canAnswerDecision, decisionDenied, loadDecisionSession, visibleGates } from "./messages.js";

export interface PresenceDeps {
  config: () => TurnkeyDeploymentConfig | null;
  turnkey: TurnkeyOpsFactory;
  forward: ForwardStamped;
  now: () => number;
}

/** Production wiring. Tests replace fields with `Object.assign` and restore them after. */
export const presenceDeps: PresenceDeps = {
  config: () => loadTurnkeyConfig(process.env),
  turnkey: turnkeyOps,
  forward: forwardStampedSignature,
  now: () => Date.now(),
};

const NOT_SET_UP_MESSAGE =
  "This approval needs a passkey you set up for Valet. Open Settings, Commit signing, set it up, then approve again.";

type Loaded =
  | { error: Response }
  | {
      gate: EngineDecisionGate;
      signer: PresenceSigner;
      resolve: (signatures: PresenceStepsDoc["signatures"]) => Promise<void>;
      readSteps: () => Promise<{ signatures: PresenceStepsDoc["signatures"]; revision?: number }>;
      writeSteps: (doc: PresenceStepsDoc, revision?: number) => Promise<void>;
    };

async function load(c: Context<AppEnv>, sessionId: string, threadId?: string): Promise<Loaded> {
  const result = await loadDecisionSession(c, sessionId, threadId);
  if ("error" in result) return { error: result.error };
  const { session, engineSession } = result;
  if (!(await canAnswerDecision(c, session, sessionId))) return { error: decisionDenied(c) };
  if (isAgentCaller(c.var.authVia) || c.var.principal.type !== "user") {
    return { error: c.json({ error: "A person must approve this with their passkey. Open the thread in Valet." }, 403) };
  }
  const gateId = c.req.param("gateId");
  const gate = (await visibleGates(c, session, engineSession)).find((g) => g.id === gateId && (!threadId || g.threadId === threadId));
  if (!gate) return { error: c.json({ error: "gate not pending" }, 404) };
  if (gateAssurance(gate) !== "presence") {
    return { error: c.json({ error: "This approval does not use a passkey. Answer it with its buttons." }, 400) };
  }
  if (!answersGate(gate, c.var.principal)) {
    return { error: c.json({ error: "Only the person who asked can approve this. Ask them in the thread." }, 403) };
  }
  const config = presenceDeps.config();
  if (!config) return { error: c.json({ error: NOT_SET_UP_MESSAGE }, 409) };

  const plugin = pluginStore(c.var.providers.db, PLUGIN_NAME);
  const enrollment = (await plugin.user(c.var.user.id).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY))?.doc;
  const key = enrollment?.signingKey;
  if (!enrollment || !key) return { error: c.json({ error: NOT_SET_UP_MESSAGE }, 409) };
  const signing = signingContextOf(gate.context);
  if (signing && (signing.subOrgId !== enrollment.subOrgId || signing.privateKeyId !== key.privateKeyId)) {
    return { error: c.json({ error: "Only the person who asked can sign these commits, with their own passkey." }, 403) };
  }
  const signer: PresenceSigner = {
    organizationId: enrollment.subOrgId,
    privateKeyId: key.privateKeyId,
    publicKeyHex: key.publicKeyHex,
    passkeyUserId: enrollment.passkeyUserId,
  };

  const steps = plugin.session(sessionId);
  const stepsKey = presenceStepsKey(gate.resumeKey, gate.ordinal);
  const approve = gate.actions.find((a) => isApprovingAction(gate.actions, a.id))?.id ?? "approve";
  return {
    gate,
    signer,
    readSteps: async () => {
      const row = await steps.get<PresenceStepsDoc>(COLLECTIONS.presenceSteps, stepsKey);
      return row ? { signatures: row.doc.signatures, revision: row.revision } : { signatures: [] };
    },
    writeSteps: async (doc, revision) => {
      await steps.put(COLLECTIONS.presenceSteps, stepsKey, doc, revision === undefined ? undefined : { ifRevision: revision });
    },
    resolve: async (signatures) => {
      const resolvedAt = presenceDeps.now();
      await engineSession.resolveDecision(gate.id, {
        actionId: approve,
        resolvedBy: c.var.user.id,
        resolvedAt,
        source: { channelType: "web" },
        assurance: "presence",
        approval: presenceApproval(signer, signatures, resolvedAt),
      });
    },
  };
}

/**
 * The AuthZEN-shaped approval for a resolved passkey gate. Its `state` is the
 * proof of presence: every tap's Turnkey activity, the digest of the exact
 * bytes it approved, and the authenticator Turnkey recorded. Single use, so
 * `approved_until` equals `approved_at`.
 */
export function presenceApproval(signer: PresenceSigner, signatures: PresenceStepsDoc["signatures"], resolvedAt: number): AuthzenApproval {
  const at = new Date(resolvedAt).toISOString();
  const authenticator = signatures.find((s) => s.authenticator)?.authenticator;
  return {
    id: `apr_${randomUUID()}`,
    approved_at: at,
    approved_until: at,
    state: {
      iss: "turnkey",
      organization_id: signer.organizationId,
      amr: ["pop", "user"],
      approver: { user_id: signer.passkeyUserId, ...(authenticator ? { authenticator } : {}) },
      activities: signatures.map((s) => ({
        activity_id: s.activityId,
        payload_sha256: s.payloadSha256 ?? "",
        approved_at: new Date(s.approvedAtMs ?? resolvedAt).toISOString(),
      })),
    },
  };
}

function stepResponse(step: PresenceStep, signer: PresenceSigner): PresenceStepResponse {
  return { done: false, index: step.index, total: step.total, label: step.label, body: stepBody(step, signer, presenceDeps.now()) };
}

const signaturesOf = (doc: PresenceStepsDoc["signatures"]) => doc.map((s) => Buffer.from(s.signatureHex, "hex"));

export async function getPresenceStep(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const loaded = await load(c, sessionId, threadId);
  if ("error" in loaded) return loaded.error;
  const { signatures } = await loaded.readSteps();
  const step = nextPresenceStep(loaded.gate, signaturesOf(signatures));
  if (!step) {
    // Every step was signed but the gate is still pending (a crash between
    // the last signature and the resolve). Finish it now.
    await loaded.resolve(signatures);
    return c.json({ done: true } satisfies PresenceStepResponse);
  }
  return c.json(stepResponse(step, loaded.signer));
}

export async function postPresenceStep(c: Context<AppEnv>, sessionId: string, threadId?: string) {
  const loaded = await load(c, sessionId, threadId);
  if ("error" in loaded) return loaded.error;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const body = typeof raw === "object" && raw !== null && "body" in raw && typeof raw.body === "string" ? raw.body : undefined;
  const name = typeof raw === "object" && raw !== null && "stampHeaderName" in raw && typeof raw.stampHeaderName === "string" ? raw.stampHeaderName : undefined;
  const value = typeof raw === "object" && raw !== null && "stampHeaderValue" in raw && typeof raw.stampHeaderValue === "string" ? raw.stampHeaderValue : undefined;
  if (!body || !name || !value) return c.json({ error: "Send body, stampHeaderName, and stampHeaderValue from the passkey stamp." }, 400);
  if (!isWebauthnStamp(name)) return c.json({ error: "Sign with your passkey. Other credentials cannot approve this." }, 400);

  const { signatures, revision } = await loaded.readSteps();
  const step = nextPresenceStep(loaded.gate, signaturesOf(signatures));
  if (!step) {
    await loaded.resolve(signatures);
    return c.json({ done: true } satisfies PresenceStepResponse);
  }
  const refusal = submittedBodyRefusal(body, step, loaded.signer, presenceDeps.now());
  if (refusal) return c.json({ error: refusal }, 400);

  const config = presenceDeps.config();
  if (!config) return c.json({ error: NOT_SET_UP_MESSAGE }, 409);
  let tap: ReturnType<typeof verifiedTap>;
  try {
    const submitted = await presenceDeps.forward(config.apiBaseUrl, { body, stampHeaderName: name, stampHeaderValue: value });
    const settled = await settleActivity(presenceDeps.turnkey(config), submitted);
    tap = verifiedTap(settled, step, loaded.signer, presenceDeps.now());
  } catch (err) {
    return c.json({ error: `${err instanceof Error ? err.message : String(err)}. Sign again from the card.` }, 502);
  }
  if (typeof tap === "string") return c.json({ error: tap }, 400);

  const next: PresenceStepsDoc = {
    signatures: [
      ...signatures,
      {
        activityId: tap.activityId,
        signatureHex: tap.signature.toString("hex"),
        payloadSha256: tap.payloadSha256,
        approvedAtMs: tap.approvedAtMs,
        ...(tap.authenticator ? { authenticator: tap.authenticator } : {}),
      },
    ],
  };
  try {
    await loaded.writeSteps(next, revision);
  } catch {
    return c.json({ error: "Another tab signed this step at the same time. Reload the thread and continue." }, 409);
  }
  const following = nextPresenceStep(loaded.gate, signaturesOf(next.signatures));
  if (following) return c.json(stepResponse(following, loaded.signer));
  await loaded.resolve(next.signatures);
  return c.json({ done: true } satisfies PresenceStepResponse);
}

/** Mounted at `/api/sessions` beside the messages router. */
export const passkeyApprovalRouter = new Hono<AppEnv>();
passkeyApprovalRouter.get("/:id/decisions/:gateId/passkey", (c) => getPresenceStep(c, c.req.param("id")));
passkeyApprovalRouter.post("/:id/decisions/:gateId/passkey", (c) => postPresenceStep(c, c.req.param("id")));
