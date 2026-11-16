/**
 * Commit signing, per user (agent commit signing design).
 *
 *   GET  /api/me/commit-signing          state: configured, enrolled, keys
 *   POST /api/me/commit-signing/enroll   create the user's Turnkey sub-organization
 *   GET  /api/org/allowed-signers        `gpg.ssh.allowedSignersFile` text for the org
 *
 * Browser-session auth only: the sandbox rung never reaches these paths.
 * Enrollment takes the passkey attestation the browser produced with
 * `@turnkey/sdk-browser` and runs `enrollUser`, which leaves the passkey as
 * the only root of the new sub-organization.
 */
import { Hono } from "hono";
import { loadTurnkeyConfig, type TurnkeyDeploymentConfig } from "@valet/plugin-turnkey/config";
import { enrollUser, type PasskeyAuthenticator } from "@valet/plugin-turnkey/enrollment";
import { discardedP256PublicKeyHex } from "@valet/plugin-turnkey/p256";
import {
  COLLECTIONS,
  DEFAULT_KEY,
  PLUGIN_NAME,
  type EnrollmentDoc,
  type SigningKeyDoc,
  type SigningKeyIndexDoc,
} from "@valet/plugin-turnkey/store";
import { turnkeyOps, type TurnkeyOpsFactory } from "@valet/plugin-turnkey/turnkey-client";
import type { AppEnv } from "../env.js";
import { pluginStore } from "../services/plugin-store.js";
import type {
  CommitSigningKeySummary,
  GetCommitSigningResponse,
  PostCommitSigningEnrollRequest,
  PostCommitSigningEnrollResponse,
} from "../wire/types.js";

export interface CommitSigningRouteDeps {
  config?: () => TurnkeyDeploymentConfig | null;
  turnkey?: TurnkeyOpsFactory;
  rpId?: string;
}

function loadConfig(deps: CommitSigningRouteDeps): TurnkeyDeploymentConfig | null {
  return deps.config ? deps.config() : loadTurnkeyConfig(process.env);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const TRANSPORTS = new Set([
  "AUTHENTICATOR_TRANSPORT_BLE",
  "AUTHENTICATOR_TRANSPORT_INTERNAL",
  "AUTHENTICATOR_TRANSPORT_NFC",
  "AUTHENTICATOR_TRANSPORT_USB",
  "AUTHENTICATOR_TRANSPORT_HYBRID",
]);

/** Narrows the enroll body; the SDK's transport enum is checked by name. */
export function parseEnrollBody(body: unknown): PostCommitSigningEnrollRequest | null {
  if (!isRecord(body) || typeof body.challenge !== "string" || !isRecord(body.attestation)) return null;
  const a = body.attestation;
  if (
    typeof a.credentialId !== "string" ||
    typeof a.clientDataJson !== "string" ||
    typeof a.attestationObject !== "string" ||
    !isStringArray(a.transports) ||
    !a.transports.every((t) => TRANSPORTS.has(t))
  ) {
    return null;
  }
  return {
    ...(typeof body.authenticatorName === "string" ? { authenticatorName: body.authenticatorName } : {}),
    challenge: body.challenge,
    attestation: {
      credentialId: a.credentialId,
      clientDataJson: a.clientDataJson,
      attestationObject: a.attestationObject,
      transports: a.transports,
    },
  };
}

function summarize(doc: SigningKeyDoc): CommitSigningKeySummary {
  return {
    fingerprint: doc.fingerprint,
    repo: doc.repo,
    branch: doc.branch,
    ...(doc.prNumber === undefined ? {} : { prNumber: doc.prNumber }),
    sessionId: doc.sessionId,
    notBefore: doc.notBefore,
    notAfter: doc.notAfter,
    status: doc.status,
  };
}

export function buildCommitSigningRouter(deps: CommitSigningRouteDeps = {}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    const user = c.var.user;
    const config = loadConfig(deps);
    const store = pluginStore(c.var.providers.db, PLUGIN_NAME).user(user.id);
    const enrollment = await store.get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
    const keys = await store.list<SigningKeyDoc>(COLLECTIONS.signingKeys, { limit: 100 });
    const resp: GetCommitSigningResponse = {
      configured: config !== null,
      enrolled: enrollment !== null,
      ...(enrollment ? { subOrgId: enrollment.doc.subOrgId, enrolledAt: enrollment.doc.createdAt } : {}),
      ...(config
        ? {
            passkey: {
              apiBaseUrl: config.apiBaseUrl,
              organizationId: config.organizationId,
              ...(deps.rpId ? { rpId: deps.rpId } : {}),
            },
          }
        : {}),
      keys: keys.items
        .map((row) => summarize(row.doc))
        .sort((a, b) => b.notBefore - a.notBefore),
    };
    return c.json(resp);
  });

  router.post("/enroll", async (c) => {
    const user = c.var.user;
    const config = loadConfig(deps);
    if (!config) {
      return c.json({ error: "Commit signing is not configured for this deployment. Ask an admin to set the VALET_TURNKEY_* variables." }, 409);
    }
    const store = pluginStore(c.var.providers.db, PLUGIN_NAME).user(user.id);
    const existing = await store.get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
    if (existing) {
      return c.json({ error: "Commit signing is already set up for this account." }, 409);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = parseEnrollBody(body);
    if (!parsed) {
      return c.json({ error: "The passkey attestation is incomplete. Try the setup again from Settings." }, 400);
    }
    const passkey: PasskeyAuthenticator = {
      authenticatorName: parsed.authenticatorName ?? "passkey",
      challenge: parsed.challenge,
      // Checked against the enum names in `parseEnrollBody`; the SDK type is
      // a string-literal union, so this is a narrowing cast, not a widening one.
      attestation: {
        ...parsed.attestation,
        transports: parsed.attestation.transports as PasskeyAuthenticator["attestation"]["transports"],
      },
    };

    const ops = (deps.turnkey ?? turnkeyOps)(config);
    const doc = await enrollUser(ops, config, {
      userId: user.id,
      userEmail: user.email,
      passkey,
      discardedAgentPublicKey: discardedP256PublicKeyHex(),
    });
    await store.put(COLLECTIONS.enrollment, DEFAULT_KEY, doc);
    const resp: PostCommitSigningEnrollResponse = { subOrgId: doc.subOrgId, enrolledAt: doc.createdAt };
    return c.json(resp, 201);
  });

  return router;
}

/**
 * The `allowed_signers` file for the caller's organization: one line per key
 * ever issued, with its window, so `git verify-commit` accepts a commit made
 * inside the window after the key is gone from GitHub.
 */
export function renderAllowedSigners(rows: SigningKeyIndexDoc[]): string {
  return rows
    .map((row) => {
      const principal = row.userEmail ?? `user:${row.userId}@valet`;
      const after = new Date(row.notBefore).toISOString().replace(/\.\d{3}Z$/, "Z");
      const before = new Date(row.notAfter).toISOString().replace(/\.\d{3}Z$/, "Z");
      return `${principal} valid-after="${after}" valid-before="${before}" ${row.publicKey}`;
    })
    .join("\n")
    .concat(rows.length > 0 ? "\n" : "");
}

export function buildOrgAllowedSignersRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.get("/", async (c) => {
    const user = c.var.user;
    const store = pluginStore(c.var.providers.db, PLUGIN_NAME).global();
    const rows: SigningKeyIndexDoc[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.items) if (item.doc.orgId === user.orgId) rows.push(item.doc);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return c.text(renderAllowedSigners(rows), 200, { "content-type": "text/plain; charset=utf-8" });
  });
  return router;
}

export const commitSigningRouter = buildCommitSigningRouter();
export const orgAllowedSignersRouter = buildOrgAllowedSignersRouter();
