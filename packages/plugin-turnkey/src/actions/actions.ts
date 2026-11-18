/**
 * Commit signing actions
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 * - `turnkey.sign_commits` (presence mode, the default): reads the branch's
 *   unsigned commits, opens a passkey gate, and after the person's passkey
 *   signed each commit through the api's passkey endpoint, writes the signed
 *   commits into the sandbox and moves the branch. Valet holds no signing
 *   authority between passkey taps.
 * - `turnkey.request_signing_key` (session mode): opens a window in which
 *   git in the sandbox signs through `tk ssh git-sign` with an expiring
 *   session API key.
 * - `turnkey.revoke_signing_key`: ends a session-mode window early.
 *
 * Both modes sign with the person's one enrollment key, which the person
 * added to GitHub themselves. Valet never writes to GitHub. The plugin pins
 * `defaultApprovalMode: "allow"` so the catalog does not open a second,
 * generic gate in front of these actions' own gates; the `riskLevel` stays
 * `critical` for the connect UI and the audit record.
 */
import { Type, type Static, type TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult, Sandbox } from "@valet/engine";
import {
  commitAuthor,
  commitObjectRefusal,
  commitSubject,
  gitObjectId,
  planCommitChain,
  verifiedSignatureCount,
  type SourceCommit,
} from "../commits.js";
import { loadTurnkeyConfig, NOT_CONFIGURED_MESSAGE } from "../config.js";
import { clampWindowMinutes, commitSigningGateRequest, signingGateRequest, type SigningScope } from "../gate.js";
import { githubAccount, publicSigningKeyListed, SIGNING_KEY_MISSING_MESSAGE, type GitHubAccount } from "../github-keys.js";
import {
  GIT_COMMITS_KIND,
  MAX_CARD_FILES,
  presenceStepsKey,
  type CommitCardView,
  type GitCommitsSigningContext,
} from "../presence.js";
import { disableSandboxSigning, enableSandboxSigning, generateSessionKey, shQuote } from "../sandbox.js";
import {
  COLLECTIONS,
  CURRENT_KEY,
  DEFAULT_KEY,
  signingKeyDocKey,
  type EnrollmentDoc,
  type PersonSigningKey,
  type PresenceStepsDoc,
  type SessionKeyDoc,
  type SigningKeyDoc,
  type SigningKeyIndexDoc,
} from "../store.js";
import { turnkeyOps, type TurnkeyOps, type TurnkeyOpsFactory } from "../turnkey-client.js";

export const NOT_ENROLLED_MESSAGE =
  "Set up commit signing under Settings, Commit signing (it creates your Turnkey signing organization), then run this again.";
export const REENROLL_MESSAGE =
  "Your commit signing setup is from an older version. Open Settings, Commit signing, choose Set up again, then run this again.";
export const NO_GITHUB_MESSAGE =
  "Missing GitHub access token. Connect GitHub under Settings, Connected accounts, then run this again.";
export const REJECTED_MESSAGE =
  "The user rejected signing for this branch. Do not retry. Push the commits unsigned, or ask the user what they want.";
export const NO_STORE_MESSAGE = "This session has no plugin store, so signing keys cannot be recorded. Report this to an admin.";
export const PRESENCE_MODE_MESSAGE =
  "This account signs each commit with a passkey. Call turnkey.sign_commits after you commit, instead of requesting a signing key.";
export const SESSION_MODE_MESSAGE =
  "This account signs through a signing window. Call turnkey.request_signing_key before you commit, instead of turnkey.sign_commits.";
export const MAX_COMMITS = 10;

/** Seams the tests replace: the Turnkey client, the GitHub client, the key check, the env, and the clock. */
export interface SigningDeps {
  turnkey: TurnkeyOpsFactory;
  github: (token: string) => GitHubAccount;
  keyListed: (login: string, publicKeyLine: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
  now: () => number;
}

const defaultDeps: SigningDeps = {
  turnkey: turnkeyOps,
  github: (token) => githubAccount(token),
  keyListed: (login, line) => publicSigningKeyListed(login, line),
  env: process.env,
  now: () => Date.now(),
};

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    label?: PluginAction<TParams>["label"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const fail = (error: string): PluginActionResult => ({ success: false, error });

/** Best effort: the key also expires on its own at the end of its window. */
async function deleteSessionKey(turnkey: TurnkeyOps, subOrgId: string, agentUserId: string, apiKeyId: string): Promise<void> {
  try {
    await turnkey.deleteApiKeys({ subOrgId, userId: agentUserId, apiKeyIds: [apiKeyId] });
  } catch (err) {
    console.warn("turnkey: could not delete session key", apiKeyId, err instanceof Error ? err.message : err);
  }
}

async function readEnrollment(ctx: PluginActionContext): Promise<EnrollmentDoc | null> {
  const store = ctx.pluginStore;
  if (!store) return null;
  const doc = await store.user(ctx.userId).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY);
  return doc?.doc ?? null;
}

type Ready = { enrollment: EnrollmentDoc; key: PersonSigningKey; github: GitHubAccount; committerEmail: string };

/** The checks both modes share: configured, enrolled with a person key, GitHub connected, key on GitHub. */
async function readyToSign(ctx: PluginActionContext, deps: SigningDeps): Promise<Ready | PluginActionResult> {
  if (!loadTurnkeyConfig(deps.env)) return fail(NOT_CONFIGURED_MESSAGE);
  if (!ctx.pluginStore) return fail(NO_STORE_MESSAGE);
  const enrollment = await readEnrollment(ctx);
  if (!enrollment) return fail(NOT_ENROLLED_MESSAGE);
  if (!enrollment.signingKey) return fail(REENROLL_MESSAGE);
  const credential = await ctx.credentials.get("github");
  if (!credential?.accessToken) return fail(NO_GITHUB_MESSAGE);
  const github = deps.github(credential.accessToken);
  const login = await github.login();
  if (!(await deps.keyListed(login, enrollment.signingKey.publicKey))) return fail(SIGNING_KEY_MISSING_MESSAGE);
  return { enrollment, key: enrollment.signingKey, github, committerEmail: await github.noreplyEmail() };
}

async function git(sandbox: Sandbox, path: string, command: string, what: string): Promise<string> {
  const res = await sandbox.exec(`cd ${shQuote(path)} && ${command}`);
  if (res.exitCode !== 0) {
    throw new Error(`${what} failed in the sandbox (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout;
}

/** Parses `git diff-tree --numstat` lines: `added<TAB>deleted<TAB>path`, `-` for binary files. */
export function parseNumstat(text: string): Array<{ path: string; additions: number; deletions: number }> {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 3 && parts[2])
    .map(([add, del, ...path]) => ({ path: path.join("\t"), additions: Number(add) || 0, deletions: Number(del) || 0 }));
}

/**
 * The card's view of one commit. GitHub's view when GitHub already has the
 * commit: the commit id fixes the content, so the person can review the real
 * diff there. Otherwise the sandbox's own numstat, labeled as such.
 */
async function commitCard(sandbox: Sandbox, path: string, github: GitHubAccount, repo: string, commit: SourceCommit): Promise<CommitCardView> {
  const base = { sha: commit.sha, subject: commitSubject(commit.object), author: commitAuthor(commit.object) };
  const view = await github.commit(repo, commit.sha).catch(() => null);
  if (view) {
    return { ...base, source: "github", url: view.url, additions: view.additions, deletions: view.deletions, files: view.files.slice(0, MAX_CARD_FILES), filesTotal: view.files.length };
  }
  const files = parseNumstat(await git(sandbox, path, `git diff-tree --no-commit-id --numstat -r --root ${commit.sha}`, `listing files in ${commit.sha}`));
  return {
    ...base,
    source: "sandbox",
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    files: files.slice(0, MAX_CARD_FILES),
    filesTotal: files.length,
  };
}

/** `/workspace/<name>` for `owner/name`, the path workspace prep clones into. */
export function defaultRepoPath(repo: string): string {
  return `/workspace/${repo.split("/").pop() ?? repo}`;
}

export function buildTurnkeyActionPlugin(overrides: Partial<SigningDeps> = {}): ActionPlugin {
  const deps: SigningDeps = { ...defaultDeps, ...overrides };

  const signCommits = action(
    Type.Object({
      repo: Type.String({ description: "Repository as owner/name, for example tkhq/valet" }),
      branch: Type.String({ description: "The checked-out branch whose commits to sign" }),
      base: Type.String({ description: "Where the branch starts, for example origin/main. Commits in base..HEAD are signed." }),
      path: Type.Optional(Type.String({ description: "The repository's working directory. Default /workspace/<name>." })),
    }),
  )({
    id: "turnkey.sign_commits",
    name: "Sign commits with passkey",
    description:
      "Ask the user to sign the commits in base..HEAD with their passkey. The user taps their passkey once per commit " +
      `(at most ${MAX_COMMITS}), so squash first. On approval the branch is rewritten with signed commits; ` +
      "then force-push with lease. Call it after the work is committed, once per push.",
    riskLevel: "critical",
    label: (args) => `Signed commits on ${args.branch} with passkey`,
    execute: async (args, ctx) => {
      const ready = await readyToSign(ctx, deps);
      if ("success" in ready) return ready;
      if (ready.enrollment.mode === "session") return fail(SESSION_MODE_MESSAGE);
      const repo = args.repo.trim();
      const branch = args.branch.trim();
      const path = args.path?.trim() || defaultRepoPath(repo);

      const format = (await git(ctx.sandbox, path, "git rev-parse --show-object-format", "reading the object format")).trim();
      if (format !== "sha1") return fail(`This repository uses ${format} object ids. Commit signing supports SHA-1 repositories only.`);
      const current = (await git(ctx.sandbox, path, "git rev-parse --abbrev-ref HEAD", "reading the current branch")).trim();
      if (current !== branch) return fail(`The working directory is on ${current}, not ${branch}. Check out ${branch}, then run this again.`);
      const headSha = (await git(ctx.sandbox, path, "git rev-parse HEAD", "reading HEAD")).trim();
      const shas = (await git(ctx.sandbox, path, `git rev-list --reverse --topo-order ${shQuote(`${args.base.trim()}..HEAD`)}`, "listing commits"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (shas.length === 0) return fail(`There are no commits in ${args.base}..HEAD. Commit the work, then run this again.`);
      if (shas.length > MAX_COMMITS) {
        return fail(`There are ${shas.length} commits in ${args.base}..HEAD. Squash them to ${MAX_COMMITS} or fewer, then run this again.`);
      }
      const commits: SourceCommit[] = [];
      for (const sha of shas) {
        const object = await git(ctx.sandbox, path, `git cat-file commit ${sha}`, `reading commit ${sha}`);
        if (gitObjectId(object) !== sha) {
          return fail(`Commit ${sha} did not read back exactly (non-UTF-8 content?). Rewrite it, then run this again.`);
        }
        const malformed = commitObjectRefusal(object);
        if (malformed) return fail(`${sha} is not a plain git commit (${malformed}). Only commits can be signed.`);
        commits.push({ sha, object });
      }
      const cards: CommitCardView[] = [];
      for (const commit of commits) cards.push(await commitCard(ctx.sandbox, path, ready.github, repo, commit));

      const signing: GitCommitsSigningContext = {
        commits,
        committerEmail: ready.committerEmail,
        publicKeyHex: ready.key.publicKeyHex,
        privateKeyId: ready.key.privateKeyId,
        subOrgId: ready.enrollment.subOrgId,
        passkeyUserId: ready.enrollment.passkeyUserId,
      };
      const request = commitSigningGateRequest({
        repo,
        branch,
        headSha,
        commits: cards,
        context: {
          assurance: "presence",
          presence: { kind: GIT_COMMITS_KIND, repo, branch, commits: cards },
          signing,
        },
      });
      const resolution = await ctx.requestDecision(request);
      if (resolution.actionId !== "approve") return fail(REJECTED_MESSAGE);
      if (resolution.assurance !== "presence" || resolution.gateOrdinal === undefined || !request.resumeKey) {
        return fail("The approval carried no passkey signatures. Ask the user to sign again in Valet.");
      }

      const steps = await ctx.pluginStore
        ?.session(ctx.sessionId)
        .get<PresenceStepsDoc>(COLLECTIONS.presenceSteps, presenceStepsKey(request.resumeKey, resolution.gateOrdinal));
      const signatures = (steps?.doc.signatures ?? []).map((s) => Buffer.from(s.signatureHex, "hex"));
      const chain = { commits, committerEmail: signing.committerEmail, signatures, publicKeyHex: signing.publicKeyHex };
      // Check every signature against the key before writing anything: the
      // stored signatures are trusted only after they verify.
      if (verifiedSignatureCount(chain) !== signatures.length) {
        return fail("A stored signature does not match your signing key. The branch was not changed. Ask the user to sign again in Valet.");
      }
      const plan = planCommitChain(chain);
      if (plan.rewritten.length !== commits.length) {
        return fail(`Only ${plan.rewritten.length} of ${commits.length} commits were signed. Ask the user to sign again in Valet.`);
      }
      for (const commit of plan.rewritten) {
        const encoded = Buffer.from(commit.object, "utf8").toString("base64");
        const written = (
          await git(ctx.sandbox, path, `printf '%s' ${shQuote(encoded)} | base64 -d | git hash-object -t commit -w --stdin`, "writing a signed commit")
        ).trim();
        if (written !== commit.newSha) throw new Error(`git wrote ${written} for signed commit ${commit.newSha}; the branch was not moved.`);
      }
      const newHead = plan.rewritten[plan.rewritten.length - 1]!.newSha;
      await git(ctx.sandbox, path, `git update-ref ${shQuote(`refs/heads/${branch}`)} ${newHead} ${headSha}`, "moving the branch");

      return {
        success: true,
        data: {
          commits: plan.rewritten.map((c) => ({ old: c.oldSha, new: c.newSha })),
          head: newHead,
          next: `${branch} now points at the signed commits. Push with: git push --force-with-lease origin ${branch}`,
        },
      };
    },
  });

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
    name: "Request commit signing window",
    description:
      "For accounts in session mode only: ask the user to approve a signing window for one repository and branch. " +
      "On approval git in this sandbox signs every commit with the user's key until the window ends. " +
      "Accounts in passkey mode use turnkey.sign_commits instead.",
    riskLevel: "critical",
    execute: async (args, ctx) => {
      const ready = await readyToSign(ctx, deps);
      if ("success" in ready) return ready;
      const { enrollment, key } = ready;
      if (enrollment.mode !== "session" || !enrollment.agentUserId) return fail(PRESENCE_MODE_MESSAGE);
      const agentUserId = enrollment.agentUserId;
      const config = loadTurnkeyConfig(deps.env);
      const store = ctx.pluginStore;
      if (!config || !store) return fail(NOT_CONFIGURED_MESSAGE);

      const scope: SigningScope = {
        repo: args.repo.trim(),
        branch: args.branch.trim(),
        ...(args.pr_number === undefined ? {} : { prNumber: args.pr_number }),
        windowMinutes: clampWindowMinutes(args.window_minutes),
      };

      const resolution = await ctx.requestDecision(signingGateRequest(scope));
      if (resolution.actionId !== "approve") return fail(REJECTED_MESSAGE);

      // Make the sandbox's session key pair first: a sandbox failure then
      // leaves no Turnkey credential behind.
      const sessionPublicKey = await generateSessionKey(ctx.sandbox);
      const createdAt = deps.now();
      const notAfter = new Date(createdAt + scope.windowMinutes * 60_000);
      const turnkey = deps.turnkey(config);

      const doc: SigningKeyDoc = {
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        orgId: ctx.orgId,
        repo: scope.repo,
        branch: scope.branch,
        ...(scope.prNumber === undefined ? {} : { prNumber: scope.prNumber }),
        fingerprint: key.fingerprint,
        publicKey: key.publicKey,
        turnkeySubOrgId: enrollment.subOrgId,
        turnkeyPrivateKeyId: key.privateKeyId,
        turnkeyCreateActivityId: key.activityId,
        ...(ctx.decisionGateId ? { gateId: ctx.decisionGateId } : {}),
        notBefore: createdAt,
        notAfter: notAfter.getTime(),
        status: "active",
        createdAt,
      };
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
        notBefore: doc.notBefore,
        notAfter: doc.notAfter,
        status: "active",
      };
      await store.global().put(COLLECTIONS.signingKeyIndex, userKey, index);

      // The session API key is the sandbox's signing authority. It is made
      // now and expires with the window, so Turnkey refuses a signature
      // after the window whatever the sandbox still holds.
      const sessionKey = await turnkey.createApiKey({
        subOrgId: enrollment.subOrgId,
        userId: agentUserId,
        name: `session:${ctx.sessionId}`,
        publicKey: sessionPublicKey,
        expirationSeconds: scope.windowMinutes * 60,
      });
      const sessionStore = store.session(ctx.sessionId);
      const previous = await sessionStore.get<SessionKeyDoc>(COLLECTIONS.sessionKey, DEFAULT_KEY);
      if (previous) await deleteSessionKey(turnkey, enrollment.subOrgId, agentUserId, previous.doc.apiKeyId);
      const sessionDoc: SessionKeyDoc = {
        apiKeyId: sessionKey.apiKeyId,
        publicKey: sessionPublicKey,
        createdAt,
        expiresAt: notAfter.getTime(),
      };
      await sessionStore.put(COLLECTIONS.sessionKey, DEFAULT_KEY, sessionDoc);

      await enableSandboxSigning(ctx.sandbox, {
        organizationId: enrollment.subOrgId,
        apiBaseUrl: config.apiBaseUrl,
        privateKeyId: key.privateKeyId,
        publicKeyLine: key.publicKey,
        committerEmail: ready.committerEmail,
      });

      return {
        success: true,
        data: {
          fingerprint: key.fingerprint,
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
    name: "End commit signing window",
    description: "End a session-mode signing window before it expires, and turn signing off in this sandbox.",
    riskLevel: "low",
    label: (args) => `Ended commit signing window for ${args.fingerprint}`,
    execute: async (args, ctx) => {
      const store = ctx.pluginStore;
      if (!store) return fail(NO_STORE_MESSAGE);
      const userStore = store.user(ctx.userId);
      const { items } = await userStore.list<SigningKeyDoc>(COLLECTIONS.signingKeys, { limit: 200 });
      const match = items.find((d) => d.doc.fingerprint === args.fingerprint.trim() && d.doc.status === "active");
      if (!match) return fail(`No open signing window with fingerprint ${args.fingerprint} belongs to you.`);
      const closed: SigningKeyDoc = { ...match.doc, status: "revoked", closedAt: deps.now() };
      await userStore.put(COLLECTIONS.signingKeys, match.key, closed, { ifRevision: match.revision });
      const indexRow = await store.global().get<SigningKeyIndexDoc>(COLLECTIONS.signingKeyIndex, match.key);
      if (indexRow) {
        await store.global().put(COLLECTIONS.signingKeyIndex, match.key, { ...indexRow.doc, status: "revoked" });
      }
      if (match.doc.sessionId === ctx.sessionId) {
        const sessionStore = store.session(ctx.sessionId);
        await sessionStore.delete(COLLECTIONS.signingKeys, CURRENT_KEY);
        const sessionKey = await sessionStore.get<SessionKeyDoc>(COLLECTIONS.sessionKey, DEFAULT_KEY);
        const config = loadTurnkeyConfig(deps.env);
        const enrollment = await readEnrollment(ctx);
        if (sessionKey && config && enrollment?.agentUserId) {
          await deleteSessionKey(deps.turnkey(config), enrollment.subOrgId, enrollment.agentUserId, sessionKey.doc.apiKeyId);
          await sessionStore.delete(COLLECTIONS.sessionKey, DEFAULT_KEY);
        }
        await disableSandboxSigning(ctx.sandbox);
      }
      return { success: true, data: { fingerprint: closed.fingerprint, status: closed.status } };
    },
  });

  return {
    service: "turnkey",
    description: "Turnkey commit signing",
    // Each action opens its own gate with the exact scope; a generic
    // catalog gate in front of it would ask the same question twice.
    defaultApprovalMode: "allow",
    actions: [signCommits, requestSigningKey, revokeSigningKey],
  };
}

export const turnkeyActionPlugin: ActionPlugin = buildTurnkeyActionPlugin();
