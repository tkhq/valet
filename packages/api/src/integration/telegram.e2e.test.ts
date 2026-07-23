/**
 * Live e2e for the Telegram channel (Task 12, spec
 * `docs/specs/2026-07-15-telegram-channel-design.md`). Token-gated: skips
 * cleanly unless BOTH `TELEGRAM_TEST_BOT_TOKEN` and `TELEGRAM_TEST_CHAT_ID`
 * are set, mirroring the `describeIfKey` pattern in
 * `orchestrator-restart.test.ts`.
 *
 * Scope (per the brief): this proves OUTBOUND delivery + the identity-link
 * plumbing against the real Telegram Bot API. It does NOT prove inbound —
 * receiving a real inbound update requires a human sending a DM to the test
 * bot, which is the manual dogfood (task brief Step 4), not an automated
 * test.
 *
 * Flow: boot the api harness with the real telegram plugin, save an
 * org-owned `bot_token` credential holding `TELEGRAM_TEST_BOT_TOKEN`, start
 * the `ChannelHost` (long-poll mode — no `channelPublicUrl` set), link
 * `local-user`'s identity to `TELEGRAM_TEST_CHAT_ID` via the same
 * mint/consume-code path the real `/start <code>` flow uses, then exercise
 * two independent outbound paths:
 *
 *   1. `host.attentionDeliverer().deliver(...)` — the attention-router
 *      adapter (spec decision 9). `deliver` swallows errors by design
 *      (rule: "Best-effort per-recipient channel delivery ... must never
 *      throw"), so a bare call proves nothing about reachability on its
 *      own — it's exercised here to prove the plumbing (identity resolution
 *      + notifyAttention gating + markdown formatting) doesn't throw before
 *      it ever reaches the transport.
 *   2. `host.transportFor("telegram").send(...)` called DIRECTLY — this is
 *      the strongest assertion available: `TelegramApi`'s `call()` throws
 *      `TelegramApiError` on any non-`ok` Bot API response (see
 *      `packages/plugin-telegram/src/transport/api.ts`), so an awaited
 *      resolution here is a real network round-trip proving the token is
 *      valid and the Bot API accepted a message send to the test chat. The
 *      returned `SendRef.messageId` is asserted non-empty as further
 *      evidence of a genuine accepted send (not a mocked no-op).
 */
import { describe, expect, it } from "vitest";
import telegramPlugin from "@valet/plugin-telegram/plugin";
import { bootTestApi, type TestApi } from "./_setup.js";
import { mintLinkCode, consumeLinkCode, linkIdentity } from "../channels/identity-links.js";

const BOT_TOKEN = process.env.TELEGRAM_TEST_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;

const describeIfCreds = BOT_TOKEN && CHAT_ID ? describe : describe.skip;

const ORG_ID = "local-org";
const USER_ID = "local-user";

describeIfCreds("telegram channel — live e2e (token-gated)", () => {
  it("links local-user to the test chat and delivers an attention notification via the real Bot API", async () => {
    let api: TestApi | undefined;
    try {
      api = await bootTestApi({ plugins: [telegramPlugin] });
      const { providers } = api;

      await providers.engineCredentials.save({ type: "org", id: ORG_ID }, "telegram", {
        type: "bot_token",
        accessToken: BOT_TOKEN as string,
      });

      // Long-poll mode (no channelPublicUrl passed to bootTestApi) — start()
      // resolves the credential, probes getMe(), and registers the poll
      // loop. This is also the first real network call: a bad/expired
      // TELEGRAM_TEST_BOT_TOKEN surfaces here as a console.error from the
      // getMe probe (host.start() swallows it — see host.ts), not a thrown
      // error, so the assertions below are what actually catches an invalid
      // token.
      await providers.channelHost.start();
      expect(providers.channelHost.isRunning("telegram")).toBe(true);

      // Mirror the real /start <code> flow: mint a link code for
      // local-user, "consume" it (as the host would on an inbound /start
      // command), then link the identity to the test chat id.
      const code = await mintLinkCode(providers.db, USER_ID, "telegram");
      const consumed = await consumeLinkCode(providers.db, "telegram", code);
      expect(consumed).toEqual({ userId: USER_ID, externalId: null });
      await linkIdentity(providers.db, {
        provider: "telegram",
        externalId: CHAT_ID as string,
        userId: USER_ID,
      });

      // Path 1: the attention-router deliverer. `deliver` never throws by
      // design, so this only proves the plumbing up to (and including) the
      // transport call doesn't blow up before the network round-trip.
      await expect(
        providers.channelHost.attentionDeliverer().deliver(USER_ID, {
          kind: "notification",
          owner: { type: "user", id: USER_ID },
          title: "valet e2e ping",
          body: "packages/api/src/integration/telegram.e2e.test.ts — attentionDeliverer path",
        }),
      ).resolves.toBeUndefined();

      // Path 2: call the transport directly so a Bot API rejection (bad
      // token, chat not started with the bot, etc.) surfaces as a thrown
      // TelegramApiError instead of being swallowed — this is the real
      // reachability proof.
      const transport = providers.channelHost.transportFor("telegram");
      expect(transport).not.toBeNull();
      const ref = await transport?.send(`telegram:dm:${CHAT_ID}`, {
        markdown: "**valet e2e ping** — direct transport.send path",
      });
      expect(ref?.messageId).toBeTruthy();
    } finally {
      await api?.cleanup();
    }
  }, 30_000);
});
