/**
 * `turnkey.request_signing_key` and `turnkey.revoke_signing_key`.
 *
 * The request action is the approval point for commit signing: it opens the
 * `credential_request` gate with the exact scope, and only on approve does
 * it create the Ed25519 key in Turnkey, register the public half on the
 * user's GitHub account, and turn signing on in the sandbox. The plugin pins
 * `defaultApprovalMode: "allow"` so the catalog does not open a second,
 * generic approval gate in front of this one; the `riskLevel` stays
 * `critical` for the connect UI and the audit record.
 */
import { Type, type Static, type TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";
import { loadTurnkeyConfig, NOT_CONFIGURED_MESSAGE } from "../config.js";
import { clampWindowMinutes, githubKeyTitle, signingGateRequest, signingKeyName, type SigningScope } from "../gate.js";
import { githubSigningKeys, type GitHubSigningKeys } from "../github-keys.js";
import { disableSandboxSigning, enableSandboxSigning } from "../sandbox.js";
import { opensshEd25519PublicKey } from "../ssh.js";
import {
  COLLECTIONS,
  CURRENT_KEY,
  DEFAULT_KEY,
  signingKeyDocKey,
  type SigningKeyIndexDoc,
  type EnrollmentDoc,
  type SigningKeyDoc,
} from "../store.js";
import { turnkeyOps, type TurnkeyOpsFactory } from "../turnkey-client.js";

export const NOT_ENROLLED_MESSAGE =
  "Set up commit signing under Settings, Connected accounts (it creates your Turnkey signing organization), then run this again.";
export const NO_GITHUB_MESSAGE =
  "Missing GitHub access token. Connect GitHub under Settings, Connected accounts, then run this again.";
export const REJECTED_MESSAGE =
  "The user rejected signing for this branch. Do not retry. Push the commits unsigned, or ask the user what they want.";
export const NO_STORE_MESSAGE = "This session has no plugin store, so signing keys cannot be recorded. Report this to an admin.";

/** Seams the tests replace: the Turnkey client, the GitHub client, the env, and the clock. */
export interface SigningDeps {
  turnkey: TurnkeyOpsFactory;
  github: (token: string) => GitHubSigningKeys;
  env: Record<string, string | undefined>;
  now: () => number;
}

const defaultDeps: SigningDeps = {
  turnkey: turnkeyOps,
  github: (token) => githubSigningKeys(token),
  env: process.env,
  now: () => Date.now(),
};

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const fail = (error: string): PluginActionResult => ({ success: false, error });

async function readEnrollment(ctx: PluginActionContext): Promise<EnrollmentDoc | null> {
  const store = ctx.pluginStore;
  if (!store) return null;
  const doc = await store.user(ctx.userId).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
  return doc?.doc ?? null;
}

export function buildTurnkeyActionPlugin(overrides: Partial<SigningDeps> = {}): ActionPlugin {
  const deps: SigningDeps = { ...defaultDeps, ...overrides };

  const requestSigningKey = action(
    Type.Object({
      repo: Type.String({ description: "Repository as owner/name, for example tkhq/valet" }),
      branch: Type.String({ description: "Branch the signed commits will be pushed to" }),
      pr_number: Type.Optional(Type.Integer({ description: "Pull request number, when one exists", minimum: 1 })),
      window_minutes: Type.Optional(
        Type.Integer({ description: "How long the key may sign. Default 120, maximum 1440.", minimum: 1 }),
      ),
    }),
  )({
    id: "turnkey.request_signing_key",
    name: "Request commit signing key",
    description:
      "Ask the user to approve commit signing for one repository and branch. On approval an Ed25519 key is " +
      "created in Turnkey, registered on the user's GitHub account for the window, and git in this sandbox " +
      "signs every commit with it. Call once per pull request, when it is ready for review.",
    riskLevel: "critical",
    execute: async (args, ctx) => {
      const config = loadTurnkeyConfig(deps.env);
      if (!config) return fail(NOT_CONFIGURED_MESSAGE);
      if (!ctx.pluginStore) return fail(NO_STORE_MESSAGE);
      const enrollment = await readEnrollment(ctx);
      if (!enrollment) return fail(NOT_ENROLLED_MESSAGE);
      const github = await ctx.credentials.get("github");
      if (!github?.accessToken) return fail(NO_GITHUB_MESSAGE);

      const scope: SigningScope = {
        repo: args.repo.trim(),
        branch: args.branch.trim(),
        ...(args.pr_number === undefined ? {} : { prNumber: args.pr_number }),
        windowMinutes: clampWindowMinutes(args.window_minutes),
      };

      const resolution = await ctx.requestDecision(signingGateRequest(scope));
      if (resolution.actionId !== "approve") return fail(REJECTED_MESSAGE);

      const createdAt = deps.now();
      const notAfter = new Date(createdAt + scope.windowMinutes * 60_000);
      const turnkey = deps.turnkey(config);
      const key = await turnkey.createSigningKey({
        subOrgId: enrollment.subOrgId,
        name: signingKeyName(ctx.sessionId, scope),
        tagIds: [enrollment.signingTagId],
      });
      const publicKey = opensshEd25519PublicKey(key.publicKeyHex);
      const registered = await deps
        .github(github.accessToken)
        .create(githubKeyTitle(ctx.sessionId, scope, notAfter), publicKey.line);

      const doc: SigningKeyDoc = {
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        orgId: ctx.orgId,
        repo: scope.repo,
        branch: scope.branch,
        ...(scope.prNumber === undefined ? {} : { prNumber: scope.prNumber }),
        fingerprint: publicKey.fingerprint,
        publicKey: publicKey.line,
        githubKeyId: registered.id,
        turnkeySubOrgId: enrollment.subOrgId,
        turnkeyPrivateKeyId: key.privateKeyId,
        turnkeyCreateActivityId: key.activityId,
        ...(ctx.decisionGateId ? { gateId: ctx.decisionGateId } : {}),
        notBefore: createdAt,
        notAfter: notAfter.getTime(),
        status: "active",
        createdAt,
      };
      const store = ctx.pluginStore;
      const userKey = signingKeyDocKey(createdAt, doc.fingerprint);
      await store.user(ctx.userId).put(COLLECTIONS.signingKeys, userKey, doc);
      await store.session(ctx.sessionId).put(COLLECTIONS.signingKeys, CURRENT_KEY, doc);
      const index: SigningKeyIndexDoc = {
        userId: ctx.userId,
        ...(ctx.actor?.email ? { userEmail: ctx.actor.email } : {}),
        orgId: ctx.orgId,
        sessionId: ctx.sessionId,
        userKey,
        fingerprint: doc.fingerprint,
        publicKey: doc.publicKey,
        githubKeyId: doc.githubKeyId,
        notBefore: doc.notBefore,
        notAfter: doc.notAfter,
        status: "active",
      };
      await store.global().put(COLLECTIONS.signingKeyIndex, userKey, index);

      await enableSandboxSigning(ctx.sandbox, { privateKeyId: key.privateKeyId, publicKeyLine: publicKey.line });

      return {
        success: true,
        data: {
          fingerprint: publicKey.fingerprint,
          private_key_id: key.privateKeyId,
          not_after: notAfter.toISOString(),
          next: "git is configured to sign. Rewrite the branch with signed commits and force-push with lease.",
        },
      };
    },
  });

  const revokeSigningKey = action(
    Type.Object({
      fingerprint: Type.String({ description: "The SHA256: fingerprint request_signing_key returned" }),
    }),
  )({
    id: "turnkey.revoke_signing_key",
    name: "Revoke commit signing key",
    description: "Remove a signing key from the user's GitHub account before its window ends, and turn signing off.",
    riskLevel: "low",
    execute: async (args, ctx) => {
      const store = ctx.pluginStore;
      if (!store) return fail(NO_STORE_MESSAGE);
      const userStore = store.user(ctx.userId);
      const { items } = await userStore.list<SigningKeyDoc>(COLLECTIONS.signingKeys, { limit: 200 });
      const match = items.find((d) => d.doc.fingerprint === args.fingerprint.trim());
      if (!match) return fail(`No signing key with fingerprint ${args.fingerprint} belongs to you.`);
      if (match.doc.status !== "active") {
        return { success: true, data: { fingerprint: match.doc.fingerprint, status: match.doc.status } };
      }
      const github = await ctx.credentials.get("github");
      if (!github?.accessToken) return fail(NO_GITHUB_MESSAGE);
      await deps.github(github.accessToken).remove(match.doc.githubKeyId);
      const closed: SigningKeyDoc = { ...match.doc, status: "revoked", closedAt: deps.now() };
      await userStore.put(COLLECTIONS.signingKeys, match.key, closed, { ifRevision: match.revision });
      const indexRow = await store.global().get<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, match.key);
      if (indexRow) {
        await store.global().put(COLLECTIONS.signingKeyIndex, match.key, { ...indexRow.doc, status: "revoked" });
      }
      if (match.doc.sessionId === ctx.sessionId) {
        await store.session(ctx.sessionId).delete(COLLECTIONS.signingKeys, CURRENT_KEY);
        await disableSandboxSigning(ctx.sandbox);
      }
      return { success: true, data: { fingerprint: closed.fingerprint, status: closed.status } };
    },
  });

  return {
    service: "turnkey",
    description: "Turnkey commit signing",
    // The request action opens its own gate with the exact scope; a generic
    // catalog gate in front of it would ask the same question twice.
    defaultApprovalMode: "allow",
    actions: [requestSigningKey, revokeSigningKey],
  };
}

export const turnkeyActionPlugin: ActionPlugin = buildTurnkeyActionPlugin();
