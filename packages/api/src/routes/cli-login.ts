/**
 * Browser sign-in for `valet login` (`docs/specs/2026-07-14-auth-v2-design.md`,
 * "CLI browser sign-in").
 *
 *   GET  /api/cli/login?redirect_uri=&code_challenge=&device=   what is asking, for the web page
 *   POST /api/cli/login          { redirect_uri, code_challenge, state, device, accept }
 *   POST /api/cli/login/token    { code, code_verifier, redirect_uri }   (public)
 *
 * The CLI listens on a loopback port, opens `/cli/login` in the browser with
 * a PKCE challenge, and waits. The person approves on the web page. The
 * browser then carries a one-time code to the CLI's loopback `/callback`,
 * and the CLI exchanges the code and its PKCE verifier for a personal API
 * key named after the computer. The key is never shown in the browser, and
 * a code without the verifier is useless, so a code that leaks from browser
 * history or a log grants nothing.
 *
 * Only a signed-in browser session can approve, a POST must come from a
 * Valet origin, and the redirect must be a loopback address on the
 * person's own computer.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ValetAuth } from "../auth/index.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { verification } from "../schema/index.js";
import type { CliLoginDecision, CliLoginInfo, CliLoginTokenResponse } from "../wire/types.js";
import { trustedRequestOrigins } from "./oauth-consent.js";

export const cliLoginRouter = new Hono<AppEnv>();

/** How long an approved code waits for the CLI to exchange it. */
const CODE_TTL_MS = 5 * 60_000;
const IDENTIFIER_PREFIX = "cli-login:";
const MAX_DEVICE_LENGTH = 64;
const MAX_STATE_LENGTH = 256;

/** What a CLI key can do, shown on the web page. */
const CLI_ACCESS = [
  "Act as you in Valet from that computer's terminal, with the same access you have in the browser",
  "Start and continue threads, run workflows, and use your connected integrations",
  "Keep this access until you revoke the key in Settings > API keys",
];

interface PendingLogin {
  userId: string;
  challenge: string;
  redirectUri: string;
  device: string;
}

/** A loopback `/callback` URL with an explicit port, or undefined. */
export function loopbackRedirect(raw: unknown): URL | undefined {
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.port === "" || url.pathname !== "/callback") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url;
}

/** A PKCE S256 challenge: 43 base64url characters. */
function isChallenge(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw);
}

/** The computer name the CLI reports, trimmed to printable text. The CLI chooses it, so it proves nothing. */
export function deviceLabel(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/[^\x20-\x7e]/g, "").trim() : "";
  return text.slice(0, MAX_DEVICE_LENGTH) || "unknown computer";
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function identifierFor(code: string): string {
  return `${IDENTIFIER_PREFIX}${createHash("sha256").update(code).digest("hex")}`;
}

function parsePending(value: string): PendingLogin | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const p = parsed as Record<string, unknown>;
    if (typeof p.userId !== "string" || typeof p.challenge !== "string" || typeof p.redirectUri !== "string") return undefined;
    return { userId: p.userId, challenge: p.challenge, redirectUri: p.redirectUri, device: deviceLabel(p.device) };
  } catch {
    return undefined;
  }
}

function sessionOnly(c: Context<AppEnv>): Response | undefined {
  if (c.var.authVia === "session") return undefined;
  return c.json({ error: "Sign in to Valet in your browser to approve a CLI sign-in. API keys and app tokens cannot approve it." }, 403);
}

const BAD_REQUEST = "This sign-in link is not valid. Run `valet login` again in your terminal.";

cliLoginRouter.get("/", (c) => {
  const refused = sessionOnly(c);
  if (refused) return refused;
  if (!loopbackRedirect(c.req.query("redirect_uri")) || !isChallenge(c.req.query("code_challenge"))) {
    return c.json({ error: BAD_REQUEST }, 400);
  }
  const body: CliLoginInfo = { account: c.var.user.email, device: deviceLabel(c.req.query("device")), access: CLI_ACCESS };
  return c.json(body);
});

cliLoginRouter.post("/", async (c) => {
  // The session cookie is SameSite=Lax, so a cross-site POST arrives signed
  // out. Refuse a foreign Origin anyway, before any state changes.
  const origin = c.req.header("origin");
  if (origin && !trustedRequestOrigins(c).has(origin)) return c.json({ error: "Approve the sign-in from the Valet page." }, 403);
  const refused = sessionOnly(c);
  if (refused) return refused;
  const body = await readOptionalJsonObject(c);
  const redirect = loopbackRedirect(body?.redirect_uri);
  if (!body || !redirect || !isChallenge(body.code_challenge) || typeof body.accept !== "boolean") {
    return c.json({ error: BAD_REQUEST }, 400);
  }
  const redirectUri = redirect.toString();
  const state = typeof body.state === "string" ? body.state.slice(0, MAX_STATE_LENGTH) : "";
  if (state) redirect.searchParams.set("state", state);
  if (!body.accept) {
    redirect.searchParams.set("error", "access_denied");
    return c.json({ redirect: redirect.toString() } satisfies CliLoginDecision);
  }
  const code = randomBytes(32).toString("base64url");
  const pending: PendingLogin = {
    userId: c.var.user.id,
    challenge: body.code_challenge,
    redirectUri,
    device: deviceLabel(body.device),
  };
  await c.var.providers.db.insert(verification).values({
    id: randomUUID(),
    identifier: identifierFor(code),
    value: JSON.stringify(pending),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  redirect.searchParams.set("code", code);
  return c.json({ redirect: redirect.toString() } satisfies CliLoginDecision);
});

/**
 * `POST /api/cli/login/token`, mounted before the auth middleware: the CLI
 * has no credential yet. The code is deleted on first use, whether the
 * exchange succeeds or not.
 */
export function cliLoginTokenHandler(deps: { auth: Pick<ValetAuth, "api">; db: AppDb }) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const body = await readOptionalJsonObject(c);
    const code = body?.code;
    const verifier = body?.code_verifier;
    const redirect = loopbackRedirect(body?.redirect_uri);
    if (typeof code !== "string" || code === "" || typeof verifier !== "string" || !redirect) {
      return c.json({ error: "Send { code, code_verifier, redirect_uri }." }, 400);
    }
    const [row] = await deps.db.delete(verification)
      .where(and(eq(verification.identifier, identifierFor(code)), gt(verification.expiresAt, new Date())))
      .returning();
    const pending = row ? parsePending(row.value) : undefined;
    if (!pending || pending.redirectUri !== redirect.toString() || pending.challenge !== s256(verifier)) {
      return c.json({ error: "This sign-in expired or was already used. Run `valet login` again." }, 400);
    }
    const created = await deps.auth.api.createApiKey({ body: { name: `valet CLI (${pending.device})`, userId: pending.userId } });
    if (!created?.key) return c.json({ error: "Valet could not create the CLI key. Run `valet login` again." }, 500);
    return c.json({ key: created.key, name: created.name ?? "" } satisfies CliLoginTokenResponse);
  };
}
