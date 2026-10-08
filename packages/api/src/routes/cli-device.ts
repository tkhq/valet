/**
 * Device sign-in for `valet login` (`docs/specs/2026-07-14-auth-v2-design.md`,
 * "CLI device sign-in"). The flow follows OAuth device authorization
 * (RFC 8628):
 *
 *   POST /api/cli/device/code     { device }              public: start, get a user code
 *   POST /api/cli/device/token    { device_code }         public: poll until allowed
 *   POST /api/cli/token/refresh   { refresh_token }       public: replace both tokens
 *   POST /api/cli/token/revoke    { token }               public: sign the CLI out
 *   GET  /api/cli/device?user_code=                       browser session: what is asking
 *   POST /api/cli/device          { user_code, accept }   browser session: allow or deny
 *
 * The CLI shows a user code and opens `/cli/device`. The person types the
 * code there and chooses Allow. The page never takes the code from its URL:
 * a link that someone else sent cannot approve their CLI with one click.
 * The CLI polls with its device code and receives a CLI token
 * (`auth/cli-tokens.ts`), not an API key. The device code is stored only as
 * a hash, and works once.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { mintCliToken, refreshCliToken, revokeCliToken } from "../auth/cli-tokens.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { cliDeviceRequests } from "../schema/index.js";
import type { CliDeviceCodeResponse, CliDeviceInfo } from "../wire/types.js";
import { trustedRequestOrigins } from "./oauth-consent.js";

/** How long a person has to enter the code. */
const REQUEST_TTL_MS = 10 * 60_000;
/** Seconds the CLI waits between polls. A faster poll gets `slow_down`. */
export const POLL_INTERVAL_S = 5;
const MAX_DEVICE_LENGTH = 64;
/** No vowels or look-alike characters, so a code cannot spell a word or be misread. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** What a CLI sign-in can do, shown on the web page. */
const CLI_ACCESS = [
  "Act as you in Valet from that computer's terminal: start and continue threads, run workflows, and use your connected integrations",
  "Stay signed in while the CLI is in use. It signs out after 30 days without use, or when you disconnect it in Settings > Agent access",
];

/** What a CLI token cannot do, shown below the access list. */
const CLI_LIMITS = ["It cannot approve requests, change policies, or administer your organization or teams. You do those in the browser."];

/** The computer name the CLI reports, trimmed to printable text. The CLI chooses it, so it proves nothing. */
export function deviceLabel(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/[^\x20-\x7e]/g, "").trim() : "";
  return text.slice(0, MAX_DEVICE_LENGTH) || "unknown computer";
}

/** `bcdf-ghjk`, `BCDFGHJK`, or `BCDF GHJK` → `BCDF-GHJK`; anything else → undefined. */
export function normalizeUserCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== 8 || [...letters].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return undefined;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function newUserCode(): string {
  const letters = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function deviceError(c: Context<AppEnv>, error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token", description: string) {
  return c.json({ error, error_description: description }, 400);
}

/** Public routes, mounted before the auth middleware: the CLI has no credential yet. */
export function cliDevicePublicRouter(db: AppDb): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post("/device/code", async (c) => {
    const body = await readOptionalJsonObject(c);
    const now = Date.now();
    // Requests nobody finished are useless after they expire.
    await db.delete(cliDeviceRequests).where(lt(cliDeviceRequests.expiresAt, now));
    const deviceCode = randomBytes(32).toString("base64url");
    // A collision with a live code is possible but rare; the unique index
    // turns it into an error, and the CLI starts again.
    const userCode = newUserCode();
    await db.insert(cliDeviceRequests).values({
      deviceCodeHash: hashCode(deviceCode), userCode, device: deviceLabel(body?.device),
      createdAt: now, expiresAt: now + REQUEST_TTL_MS,
    });
    return c.json({
      device_code: deviceCode,
      user_code: userCode,
      verification_path: "/cli/device",
      expires_in: REQUEST_TTL_MS / 1000,
      interval: POLL_INTERVAL_S,
    } satisfies CliDeviceCodeResponse);
  });

  router.post("/device/token", async (c) => {
    const body = await readOptionalJsonObject(c);
    const deviceCode = body?.device_code;
    if (typeof deviceCode !== "string" || deviceCode === "") return c.json({ error: "invalid_request", error_description: "Send { device_code }." }, 400);
    const hash = hashCode(deviceCode);
    const now = Date.now();
    const [request] = await db.select().from(cliDeviceRequests).where(eq(cliDeviceRequests.deviceCodeHash, hash)).limit(1);
    if (!request || request.expiresAt <= now) return deviceError(c, "expired_token", "The sign-in code expired. Run `valet login` again.");
    if (request.status === "denied") {
      await db.delete(cliDeviceRequests).where(eq(cliDeviceRequests.deviceCodeHash, hash));
      return deviceError(c, "access_denied", "The sign-in was denied in the browser.");
    }
    if (request.status === "pending") {
      const tooFast = request.lastPollAt !== null && now - request.lastPollAt < (POLL_INTERVAL_S * 1000) - 500;
      await db.update(cliDeviceRequests).set({ lastPollAt: now }).where(eq(cliDeviceRequests.deviceCodeHash, hash));
      return tooFast
        ? deviceError(c, "slow_down", `Poll at most every ${POLL_INTERVAL_S} seconds.`)
        : deviceError(c, "authorization_pending", "Waiting for the person to enter the code and choose Allow.");
    }
    // Approved: take the request once, so two polls cannot both get a token.
    const [taken] = await db.delete(cliDeviceRequests)
      .where(and(eq(cliDeviceRequests.deviceCodeHash, hash), eq(cliDeviceRequests.status, "approved")))
      .returning({ userId: cliDeviceRequests.userId, device: cliDeviceRequests.device });
    if (!taken?.userId) return deviceError(c, "expired_token", "The sign-in code was already used. Run `valet login` again.");
    return c.json(await mintCliToken(db, taken.userId, taken.device, now));
  });

  router.post("/token/refresh", async (c) => {
    const body = await readOptionalJsonObject(c);
    const token = body?.refresh_token;
    const refreshed = typeof token === "string" && token !== "" ? await refreshCliToken(db, token) : undefined;
    if (!refreshed) return c.json({ error: "invalid_grant", error_description: "This CLI sign-in expired or was disconnected. Run `valet login` again." }, 401);
    return c.json(refreshed);
  });

  router.post("/token/revoke", async (c) => {
    const body = await readOptionalJsonObject(c);
    if (typeof body?.token === "string" && body.token !== "") await revokeCliToken(db, body.token);
    // Like OAuth token revocation (RFC 7009): an unknown token is not an error.
    return c.json({ ok: true });
  });

  return router;
}

/** Browser routes, behind the auth middleware. */
export const cliDeviceRouter = new Hono<AppEnv>();

function sessionOnly(c: Context<AppEnv>): Response | undefined {
  if (c.var.authVia === "session") return undefined;
  return c.json({ error: "Sign in to Valet in your browser to approve a CLI sign-in. API keys and app tokens cannot approve it." }, 403);
}

async function pendingRequest(db: AppDb, userCode: string) {
  const [request] = await db.select().from(cliDeviceRequests)
    .where(and(eq(cliDeviceRequests.userCode, userCode), eq(cliDeviceRequests.status, "pending"), gt(cliDeviceRequests.expiresAt, Date.now())))
    .limit(1);
  return request;
}

const NOT_FOUND = "No sign-in is waiting for this code. Check the code in your terminal, or run `valet login` again.";

cliDeviceRouter.get("/", async (c) => {
  const refused = sessionOnly(c);
  if (refused) return refused;
  const userCode = normalizeUserCode(c.req.query("user_code"));
  const request = userCode ? await pendingRequest(c.var.providers.db, userCode) : undefined;
  if (!userCode || !request) return c.json({ error: NOT_FOUND }, 404);
  return c.json({ account: c.var.user.email, device: request.device, user_code: userCode, access: CLI_ACCESS, limits: CLI_LIMITS } satisfies CliDeviceInfo);
});

cliDeviceRouter.post("/", async (c) => {
  // The session cookie is SameSite=Lax, so a cross-site POST arrives signed
  // out. Refuse a foreign Origin anyway, before any state changes.
  const origin = c.req.header("origin");
  if (origin && !trustedRequestOrigins(c).has(origin)) return c.json({ error: "Approve the sign-in from the Valet page." }, 403);
  const refused = sessionOnly(c);
  if (refused) return refused;
  const body = await readOptionalJsonObject(c);
  const userCode = normalizeUserCode(body?.user_code);
  if (!body || !userCode || typeof body.accept !== "boolean") return c.json({ error: "Send { user_code, accept: true | false }." }, 400);
  const [decided] = await c.var.providers.db.update(cliDeviceRequests)
    .set(body.accept ? { status: "approved", userId: c.var.user.id } : { status: "denied" })
    .where(and(eq(cliDeviceRequests.userCode, userCode), eq(cliDeviceRequests.status, "pending"), gt(cliDeviceRequests.expiresAt, Date.now())))
    .returning({ device: cliDeviceRequests.device });
  if (!decided) return c.json({ error: NOT_FOUND }, 404);
  return c.json({ ok: true });
});
