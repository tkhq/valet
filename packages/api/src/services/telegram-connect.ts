/**
 * Connect-time validation for the org Telegram bot token.
 *
 * The channel host reads the org bot token only at boot, so a mistyped token
 * shows up as a bot that never answers, long after the admin left the
 * settings page. The connect route pays one round trip to `getMe` and turns
 * that into an error the admin reads immediately. `getMe` also returns the
 * bot's username, which the settings page shows.
 */

/** Overridable so tests point at a fixture server instead of Telegram. */
const DEFAULT_API_BASE = "https://api.telegram.org";

/** A hung request must not hold the connect route open. */
const GET_ME_TIMEOUT_MS = 10_000;

export type TelegramConnectCheck =
  | { ok: true; username: string }
  | { ok: false; error: string };

function telegramApiBase(env: NodeJS.ProcessEnv): string {
  return env.VALET_TELEGRAM_API_BASE ?? DEFAULT_API_BASE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function verifyTelegramBotToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<TelegramConnectCheck> {
  let response: Response;
  try {
    response = await fetch(`${telegramApiBase(env)}/bot${token}/getMe`, {
      method: "POST",
      signal: AbortSignal.timeout(GET_ME_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach Telegram to check the token: ${detail}. Check network access, then try again.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const result = isRecord(payload) && payload.ok === true && isRecord(payload.result) ? payload.result : undefined;
  if (!result) {
    return { ok: false, error: "Telegram rejected the bot token. Copy the token from @BotFather again, then try again." };
  }
  if (result.is_bot !== true || typeof result.username !== "string" || result.username === "") {
    return { ok: false, error: "The token does not belong to a Telegram bot. Create a bot with @BotFather and use its token." };
  }
  return { ok: true, username: result.username };
}
