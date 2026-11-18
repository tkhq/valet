/**
 * Forwards a passkey-stamped Turnkey request unchanged. The body and the
 * stamp come from the browser; changing either breaks the stamp, so the api
 * can only pass it on or refuse it. Only a WebAuthn stamp is accepted: an
 * API key stamp would not prove a person was present.
 */
import { parseTurnkeyActivity, type TurnkeyActivity, type TurnkeyOps } from "@valet/plugin-turnkey/turnkey-client";

export const WEBAUTHN_STAMP_HEADER = "X-Stamp-WebAuthn";

export interface StampedRequest {
  body: string;
  stampHeaderName: string;
  stampHeaderValue: string;
}

export type ForwardStamped = (apiBaseUrl: string, request: StampedRequest) => Promise<TurnkeyActivity>;

export function isWebauthnStamp(name: string): boolean {
  return name.toLowerCase() === WEBAUTHN_STAMP_HEADER.toLowerCase();
}

export const forwardStampedSignature: ForwardStamped = async (apiBaseUrl, request) => {
  const res = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/public/v1/submit/sign_raw_payload`, {
    method: "POST",
    headers: { "content-type": "application/json", [WEBAUTHN_STAMP_HEADER]: request.stampHeaderValue },
    body: request.body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Turnkey refused the signed request: ${res.status} ${text.slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Turnkey answered with something other than JSON.");
  }
  const activity = parseTurnkeyActivity(typeof parsed === "object" && parsed !== null && "activity" in parsed ? parsed.activity : undefined);
  if (!activity) throw new Error("Turnkey returned no activity for the signed request.");
  return activity;
};

/** Reads the activity again until it leaves the pending states, for at most `attempts` reads. */
export async function settleActivity(
  ops: Pick<TurnkeyOps, "getActivity">,
  activity: TurnkeyActivity,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<TurnkeyActivity> {
  let current = activity;
  for (let i = 0; i < (opts.attempts ?? 10); i += 1) {
    if (current.status !== "ACTIVITY_STATUS_CREATED" && current.status !== "ACTIVITY_STATUS_PENDING") return current;
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 500));
    current = await ops.getActivity({ subOrgId: current.organizationId, activityId: current.id });
  }
  return current;
}
