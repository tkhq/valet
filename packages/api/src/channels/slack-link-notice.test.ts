import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { createEventReceipt } from "../events/receipts.js";
import { eventReceipts, userIdentityLinks } from "../schema/index.js";
import { maybeNotifyUnlinkedSlackSender, SLACK_LINK_NOTICE } from "./slack-link-notice.js";

async function fixture() {
  const { appDb: db } = await freshTestPgDb();
  const orgId = randomUUID();
  const receiptId = await createEventReceipt(db, { orgId, service: "slack" });
  const sendPrivateNotice = vi.fn(async () => {});
  return { db, orgId, receiptId, workspaceId: "T1", transport: { sendPrivateNotice }, raw: {
    type: "event_callback", team_id: "T1", event: { type: "app_mention", user: "U1", channel: "C1" },
  } };
}

describe("private Slack account-link notices", () => {
  it("explains account creation and linking once across concurrent denials and retries", async () => {
    const args = await fixture();
    await Promise.all([maybeNotifyUnlinkedSlackSender(args), maybeNotifyUnlinkedSlackSender(args)]);
    await maybeNotifyUnlinkedSlackSender(args);
    expect(args.transport.sendPrivateNotice).toHaveBeenCalledExactlyOnceWith("C1", "U1", SLACK_LINK_NOTICE);
    expect(SLACK_LINK_NOTICE).toContain("sign up");
    expect(SLACK_LINK_NOTICE).toContain("Connected accounts");
    const [receipt] = await args.db.select().from(eventReceipts);
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "account_link_notice", outcome: "sent" })]));
  });

  it("records failure without throwing or pretending Slack accepted the notice", async () => {
    const args = await fixture();
    args.transport.sendPrivateNotice.mockRejectedValue(new Error("provider rejected"));
    await expect(maybeNotifyUnlinkedSlackSender(args)).resolves.toBeUndefined();
    await maybeNotifyUnlinkedSlackSender(args);
    expect(args.transport.sendPrivateNotice).toHaveBeenCalledTimes(1);
    const [receipt] = await args.db.select().from(eventReceipts);
    expect(receipt.stages).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "failed" })]));
    expect(receipt.stages).not.toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "sent" })]));
  });

  it("does not tell a linked non-member to create or link another account", async () => {
    const args = await fixture();
    await args.db.insert(userIdentityLinks).values({ id: randomUUID(), userId: "outsider", provider: "slack", externalId: "U1", createdAt: Date.now() });
    await maybeNotifyUnlinkedSlackSender(args);
    expect(args.transport.sendPrivateNotice).not.toHaveBeenCalled();
  });

  it("ignores foreign workspaces, bots, edits, and the installed bot user", async () => {
    const args = await fixture();
    await maybeNotifyUnlinkedSlackSender({ ...args, workspaceId: "OTHER" });
    for (const extra of [{ bot_id: "B1" }, { bot_profile: { id: "B1" } }, { subtype: "message_changed" }]) {
      await maybeNotifyUnlinkedSlackSender({ ...args, raw: { ...args.raw, event: { ...args.raw.event, ...extra } } });
    }
    await maybeNotifyUnlinkedSlackSender({ ...args, botUserId: "U1" });
    expect(args.transport.sendPrivateNotice).not.toHaveBeenCalled();
  });

  it("does not rate-limit another sender, channel, or organization", async () => {
    const args = await fixture();
    await maybeNotifyUnlinkedSlackSender(args);
    await maybeNotifyUnlinkedSlackSender({ ...args, orgId: randomUUID() });
    await maybeNotifyUnlinkedSlackSender({ ...args, raw: { ...args.raw, event: { ...args.raw.event, user: "U2" } } });
    await maybeNotifyUnlinkedSlackSender({ ...args, raw: { ...args.raw, event: { ...args.raw.event, channel: "C2" } } });
    expect(args.transport.sendPrivateNotice).toHaveBeenCalledTimes(4);
  });
});
