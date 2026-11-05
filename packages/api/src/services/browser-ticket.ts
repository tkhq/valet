import { createHmac, timingSafeEqual } from "node:crypto";

export interface BrowserTicketClaims {
  sessionId: string;
  actorId: string;
  runtimeId: string;
  policyVersion: string;
  scope: "view" | "control";
}
const TTL = 5 * 60_000;
function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update(`valet.browser.v1.${payload}`)
    .digest();
}
export function mintBrowserTicket(
  secret: string,
  claims: BrowserTicketClaims,
  now = Date.now(),
) {
  const expiresAt = now + TTL;
  const payload = Buffer.from(
    JSON.stringify({ ...claims, expiresAt }),
  ).toString("base64url");
  return {
    ticket: `${payload}.${signature(secret, payload).toString("base64url")}`,
    expiresAt,
  };
}
export function verifyBrowserTicket(
  secret: string,
  ticket: string,
  expected: BrowserTicketClaims,
  now = Date.now(),
): boolean {
  try {
    if (ticket.length > 4096) return false;
    const [payload, mac, extra] = ticket.split(".");
    if (!payload || !mac || extra) return false;
    const actual = Buffer.from(mac, "base64url");
    const wanted = signature(secret, payload);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
      return false;
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      !claims ||
      typeof claims !== "object" ||
      !("expiresAt" in claims) ||
      typeof claims.expiresAt !== "number" ||
      claims.expiresAt <= now ||
      claims.expiresAt > now + TTL
    )
      return false;
    return Object.entries(expected).every(
      ([key, value]) => key in claims && Reflect.get(claims, key) === value,
    );
  } catch {
    return false;
  }
}
