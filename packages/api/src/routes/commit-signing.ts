/**
 * Commit signing, per user (agent commit signing design).
 *
 *   GET  /api/me/commit-signing               state: configured, enrolled, key, windows
 *   POST /api/me/commit-signing/enroll        create the user's Turnkey sub-organization
 *   POST /api/me/commit-signing/github-check  is the signing key on the user's GitHub account?
 *   GET  /api/org/allowed-signers             `gpg.ssh.allowedSignersFile` text for the org
 *
 * Browser-session auth only: the sandbox rung never reaches these paths.
 * Enrollment takes the passkey attestation the browser produced with
 * `@turnkey/sdk-browser` and runs `enrollUser`, which leaves the passkey as
 * the only root of the new sub-organization and creates the person's signing
 * key. The person adds that key to GitHub themselves; Valet only reads the
 * public key list (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 */
import { Hono, type Context } from "hono";
import { forwardStamped, isWebauthnStamp, settleActivity, type ForwardStamped } from "../services/passkey-approval/turnkey-forward.js";
import { loadTurnkeyConfig, type TurnkeyDeploymentConfig } from "@valet/plugin-turnkey/config";
import {
  enrollUser,
  finishPresenceEnrollment,
  keyCreationBody,
  keyCreationRefusal,
  startPresenceEnrollment,
  type PasskeyAuthenticator,
} from "@valet/plugin-turnkey/enrollment";
import { discardedP256PublicKeyHex } from "@valet/plugin-turnkey/p256";
import {
  COLLECTIONS,
  DEFAULT_KEY,
  PLUGIN_NAME,
  type EnrollmentDoc,
  type SigningHistoryDoc,
  type SigningKeyDoc,
  type SigningKeyIndexDoc,
} from "@valet/plugin-turnkey/store";
import { turnkeyOps, type TurnkeyOpsFactory } from "@valet/plugin-turnkey/turnkey-client";
import { publicSigningKeyListed } from "@valet/plugin-turnkey/github-keys";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { resolveUserApiToken } from "../services/github-tokens.js";
import type { AppEnv } from "../env.js";
import { pluginStore } from "../services/plugin-store.js";
import type {
  CommitSigningHistoryEntry,
  CommitSigningKeySummary,
  GetCommitSigningResponse,
  PostCommitSigningEnrollRequest,
  PostCommitSigningEnrollResponse,
  PostCommitSigningGithubCheckResponse,
} from "../wire/types.js";

export interface CommitSigningRouteDeps {
  config?: () => TurnkeyDeploymentConfig | null;
  turnkey?: TurnkeyOpsFactory;
  rpId?: string;
  /** Test seams: the user's GitHub login, and the public key list check. */
  githubLogin?: (orgId: string, userId: string) => Promise<string | null>;
  keyListed?: (login: string, publicKeyLine: string) => Promise<boolean>;
  /** Test seam: forwards the passkey-stamped key creation to Turnkey. */
  forward?: ForwardStamped;
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

/** Signing history for Settings: newest first, at most 50 rows. */
export function recentHistory(docs: SigningHistoryDoc[]): CommitSigningHistoryEntry[] {
  return [...docs].sort((a, b) => b.signedAt - a.signedAt).slice(0, 50);
}

/** An enrollment from the shipped per-approval design has no person key and must be set up again. */
export function needsReenroll(doc: EnrollmentDoc): boolean {
  return doc.signingKey === undefined;
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

/**
 * The person's key has no window: it goes in the allowed-signers file from
 * enrollment on, so `git verify-commit` accepts passkey-signed commits.
 */
async function recordEnrollmentKey(c: Context<AppEnv>, doc: EnrollmentDoc): Promise<void> {
  if (!doc.signingKey) return;
  const user = c.var.user;
  const index: SigningKeyIndexDoc = {
    userId: user.id,
    ...(user.email ? { userEmail: user.email } : {}),
    orgId: user.orgId,
    sessionId: "",
    userKey: `enrollment-${doc.subOrgId}`,
    fingerprint: doc.signingKey.fingerprint,
    publicKey: doc.signingKey.publicKey,
    notBefore: doc.createdAt,
    status: "active",
  };
  await pluginStore(c.var.providers.db, PLUGIN_NAME).global().put(COLLECTIONS.signingKeyIndex, index.userKey, index);
}

/** Setup needs a sign-in this recent, so a stolen session cannot enroll its own passkey. */
export const ENROLL_FRESH_SIGN_IN_MS = 15 * 60_000;

export function freshSignInRefusal(user: { sessionCreatedAt?: number }, now: number): string | null {
  if (user.sessionCreatedAt === undefined) return null;
  return now - user.sessionCreatedAt > ENROLL_FRESH_SIGN_IN_MS
    ? "Sign out of Valet and sign in again, then set up commit signing within 15 minutes. A recent sign-in protects your signing setup."
    : null;
}

export function buildCommitSigningRouter(deps: CommitSigningRouteDeps = {}): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    const user = c.var.user;
    const config = loadConfig(deps);
    const store = pluginStore(c.var.providers.db, PLUGIN_NAME).user(user.id);
    const enrollment = await store.get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
    const keys = await store.list<SigningKeyDoc>(COLLECTIONS.signingKeys, { limit: 100 });
    const history = await store.list<SigningHistoryDoc>(COLLECTIONS.signingHistory, { limit: 200 });
    const resp: GetCommitSigningResponse = {
      configured: config !== null,
      enrolled: enrollment !== null,
      ...(enrollment
        ? {
            subOrgId: enrollment.doc.subOrgId,
            enrolledAt: enrollment.doc.createdAt,
            mode: enrollment.doc.mode ?? "session",
            needsReenroll: needsReenroll(enrollment.doc) && !enrollment.doc.pendingKey,
            ...(enrollment.doc.pendingKey ? { pendingKey: true } : {}),
            ...(enrollment.doc.signingKey
              ? { signingKey: { publicKey: enrollment.doc.signingKey.publicKey, fingerprint: enrollment.doc.signingKey.fingerprint } }
              : {}),
          }
        : {}),
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
      history: recentHistory(history.items.map((row) => row.doc)),
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
    if (existing && !needsReenroll(existing.doc)) {
      return c.json({ error: "Commit signing is already set up for this account." }, 409);
    }
    const stale = freshSignInRefusal(user, Date.now());
    if (stale) return c.json({ error: stale }, 403);

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
    if (config.assurance === "presence") {
      // Step one: the organization with the passkey as its only root. The
      // browser then stamps the key creation with the same passkey.
      const pending = await startPresenceEnrollment(ops, { userId: user.id, userEmail: user.email, passkey });
      await store.put(COLLECTIONS.enrollment, DEFAULT_KEY, pending);
      const resp: PostCommitSigningEnrollResponse = {
        subOrgId: pending.subOrgId,
        enrolledAt: pending.createdAt,
        keyStep: { body: keyCreationBody(pending.subOrgId, Date.now()) },
      };
      return c.json(resp, 201);
    }
    const doc = await enrollUser(ops, config, {
      userId: user.id,
      userEmail: user.email,
      passkey,
      discardedAgentPublicKey: discardedP256PublicKeyHex(),
    });
    await store.put(COLLECTIONS.enrollment, DEFAULT_KEY, doc);
    await recordEnrollmentKey(c, doc);
    const resp: PostCommitSigningEnrollResponse = { subOrgId: doc.subOrgId, enrolledAt: doc.createdAt };
    return c.json(resp, 201);
  });

  /** A fresh key-creation body for an enrollment whose key step did not finish. */
  router.get("/enroll/key-step", async (c) => {
    const pending = (await pluginStore(c.var.providers.db, PLUGIN_NAME).user(c.var.user.id).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY))?.doc;
    if (!pending?.pendingKey) return c.json({ error: "There is no setup waiting for its key. Set up commit signing from Settings." }, 409);
    return c.json({ body: keyCreationBody(pending.subOrgId, Date.now()) });
  });

  /** Step two: forwards the passkey-stamped key creation to Turnkey and records the key. */
  router.post("/enroll/key", async (c) => {
    const user = c.var.user;
    const config = loadConfig(deps);
    if (!config) return c.json({ error: "Commit signing is not configured for this deployment. Ask an admin to set the VALET_TURNKEY_* variables." }, 409);
    const store = pluginStore(c.var.providers.db, PLUGIN_NAME).user(user.id);
    const row = await store.get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
    const pending = row?.doc;
    if (!row || !pending?.pendingKey) return c.json({ error: "There is no setup waiting for its key. Set up commit signing from Settings." }, 409);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const field = (name: string): string | undefined => {
      const value = isRecord(raw) ? raw[name] : undefined;
      return typeof value === "string" ? value : undefined;
    };
    const body = field("body");
    const stampHeaderName = field("stampHeaderName");
    const stampHeaderValue = field("stampHeaderValue");
    if (!body || !stampHeaderName || !stampHeaderValue) return c.json({ error: "Send body, stampHeaderName, and stampHeaderValue from the passkey stamp." }, 400);
    if (!isWebauthnStamp(stampHeaderName)) return c.json({ error: "Create the key with your passkey. Other credentials cannot finish setup." }, 400);
    const refusal = keyCreationRefusal(body, pending.subOrgId, Date.now());
    if (refusal) return c.json({ error: refusal }, 400);
    const ops = (deps.turnkey ?? turnkeyOps)(config);
    let doc: EnrollmentDoc;
    try {
      const submitted = await (deps.forward ?? forwardStamped)(config.apiBaseUrl, { body, stampHeaderName, stampHeaderValue }, "create_private_keys");
      doc = await finishPresenceEnrollment(ops, pending, await settleActivity(ops, submitted));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
    await store.put(COLLECTIONS.enrollment, DEFAULT_KEY, doc, { ifRevision: row.revision });
    await recordEnrollmentKey(c, doc);
    const resp: PostCommitSigningEnrollResponse = { subOrgId: doc.subOrgId, enrolledAt: doc.createdAt };
    return c.json(resp, 201);
  });

  router.post("/github-check", async (c) => {
    const user = c.var.user;
    const store = pluginStore(c.var.providers.db, PLUGIN_NAME).user(user.id);
    const enrollment = await store.get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
    const key = enrollment?.doc.signingKey;
    if (!key) {
      return c.json({ error: "Set up commit signing first. Then add the key on GitHub and check again." }, 409);
    }
    const login = deps.githubLogin
      ? await deps.githubLogin(user.orgId, user.id)
      : await (async () => {
          const { db, engineCredentials, encryptionKey } = c.var.providers;
          const token = await resolveUserApiToken({ db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) }, user.orgId, user.id);
          return token?.login ?? null;
        })();
    if (!login) {
      const resp: PostCommitSigningGithubCheckResponse = { connected: false, listed: false };
      return c.json(resp);
    }
    const listed = await (deps.keyListed ?? publicSigningKeyListed)(login, key.publicKey);
    const resp: PostCommitSigningGithubCheckResponse = { connected: true, login, listed };
    return c.json(resp);
  });

  return router;
}

/** `ssh-keygen` reads `valid-after`/`valid-before` as `YYYYMMDDHHMMSSZ`, not ISO 8601. */
function sshTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:T]/g, "");
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
      const window = row.notAfter === undefined
        ? `valid-after="${sshTime(row.notBefore)}"`
        : `valid-after="${sshTime(row.notBefore)}",valid-before="${sshTime(row.notAfter)}"`;
      return `${principal} ${window} ${row.publicKey}`;
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
