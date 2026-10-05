import type { ChannelTransport } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { appendReceiptStage } from "../events/receipts.js";
import { identityForExternal } from "./identity-links.js";

export const SLACK_LINK_NOTICE = "To use this team assistant, you need a Valet account linked to Slack. " +
  "If you do not have a Valet account, sign up in the Valet web app. " +
  "If signup requires an invitation, ask your Valet administrator. " +
  "Then sign in and open Settings → Connected accounts to link Slack. " +
  "Send your message again after linking.";

const COOLDOWN_MS = 5 * 60_000;
const MAX_KEYS = 10_000;
const attempts = new Map<string, number>();

/** Call only for a denied team mention or an active followed-thread message,
 * after signature and connected-workspace verification. No ambient notices.
 * Ephemeral failure is diagnostic only; it must never retry accepted work. */
export async function maybeNotifyUnlinkedSlackSender(args: {
  db: AppDb;
  transport: Pick<ChannelTransport, "sendPrivateNotice">;
  orgId: string;
  workspaceId: string;
  raw: unknown;
  receiptId?: string;
  botUserId?: string;
}): Promise<void> {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!record(args.raw) || args.raw.type !== "event_callback" || !record(args.raw.event)) return;
  if (!args.workspaceId || args.raw.team_id !== args.workspaceId) return;
  const event = args.raw.event;
  if (event.type !== "app_mention" && event.type !== "message") return;
  if (event.bot_id !== undefined || event.bot_profile !== undefined || event.subtype !== undefined) return;
  if (typeof event.channel !== "string" || !event.channel || typeof event.user !== "string" || !event.user || event.user === args.botUserId) return;
  const report = (outcome: string, detail: string) => appendReceiptStage(args.db, args.receiptId, { stage: "account_link_notice", outcome, detail });
  try {
    // A linked non-member needs membership, not another account-link notice.
    // A missing identity cannot distinguish a missing account from an unlinked account.
    if (await identityForExternal(args.db, "slack", event.user)) return;
    const now = Date.now();
    const key = JSON.stringify([args.orgId, event.channel, event.user]);
    for (const [entry, at] of attempts) if (now - at >= COOLDOWN_MS) attempts.delete(entry);
    if (attempts.has(key)) {
      await report("throttled", "An account-link notice was already attempted for this sender and channel within five minutes.");
      return;
    }
    if (!args.transport.sendPrivateNotice) {
      await report("unavailable", "The Slack transport cannot send a private account-link notice. Check the transport configuration.");
      return;
    }
    // Claim before awaiting Slack to coalesce simultaneous rules and deliveries.
    // At capacity, suppress new notices instead of evicting active cooldowns.
    if (attempts.size >= MAX_KEYS) {
      await report("throttled", "Private account-link notices reached the process rate limit. Try again after five minutes.");
      return;
    }
    attempts.set(key, now);
    await args.transport.sendPrivateNotice(event.channel, event.user, SLACK_LINK_NOTICE);
    await report("sent", "Slack accepted a private account-link notice for the sender. Ephemeral display is not guaranteed.");
  } catch {
    await report("failed", "The private account-link notice failed. Check the Slack connection and chat:write permission. The sender remains unauthorized.");
  }
}
