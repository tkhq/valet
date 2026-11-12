/**
 * The backstop for a key that reaches the api inside a user message: a
 * client without the composer prompt, a channel such as Slack, or a key the
 * user kept as text. Each key in a known provider format is saved as a
 * secret and replaced with its reference before the message is stored or
 * reaches the model. A note at the end of the message tells the user and
 * the agent what happened.
 *
 * Only `known` formats (`@valet/shared` `detectSecrets`). A guessed match
 * would rewrite an ordinary message.
 *
 * The api holds the value in memory for this request: it arrived in the
 * message. The note says so and asks the user to rotate a key that was
 * also shared elsewhere, for example in a Slack channel, where the
 * original message stays.
 */
import { detectSecrets, replaceSecrets, type SecretCandidate } from "@valet/shared";
import { SecretStoreError } from "./provider.js";
import { secretReference, type SecretActor, type SecretScope, type SecretStoreService } from "./service.js";

export interface ScrubResult {
  text: string;
  /** References saved, in message order. Empty when nothing matched. */
  saved: string[];
  /** Keys that were removed but could not be saved. */
  removed: number;
}

async function freeName(store: SecretStoreService, actor: SecretActor, scope: SecretScope, base: string): Promise<string> {
  const taken = new Set((await store.list(actor, scope)).map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`;
}

export async function scrubInboundSecrets(deps: {
  store: SecretStoreService;
  actor: SecretActor;
  scope: SecretScope;
  text: string;
  /** Where the message came from, for the note. */
  channel?: "web" | "channel";
}): Promise<ScrubResult> {
  const { store, actor, scope, text } = deps;
  const candidates = detectSecrets(text).filter((c) => c.confidence === "known");
  if (candidates.length === 0 || !store.enabled) return { text, saved: [], removed: 0 };

  const replacements: { candidate: SecretCandidate; with: string }[] = [];
  const saved: string[] = [];
  let removed = 0;
  for (const candidate of candidates) {
    try {
      const name = await freeName(store, actor, scope, candidate.suggestedName);
      await store.saveValue(actor, scope, name, candidate.value);
      const reference = secretReference(scope, name);
      saved.push(reference);
      replacements.push({ candidate, with: reference });
    } catch (err) {
      if (!(err instanceof SecretStoreError)) throw err;
      removed += 1;
      replacements.push({ candidate, with: `[removed ${candidate.label.toLowerCase()}]` });
    }
  }

  const notes: string[] = [];
  if (saved.length > 0) {
    notes.push(
      `Valet saved ${saved.length === 1 ? "a key" : `${saved.length} keys`} from this message as ${saved.join(", ")} and removed ${saved.length === 1 ? "it" : "them"} from the text.`,
    );
  }
  if (removed > 0) {
    notes.push(`Valet removed ${removed === 1 ? "a key" : `${removed} keys`} it could not save. Add ${removed === 1 ? "it" : "them"} in Settings, Secrets.`);
  }
  notes.push(
    deps.channel === "channel"
      ? "The original message is still in the channel: delete it there, and rotate the key."
      : "If you shared the key anywhere else, rotate it.",
  );
  return { text: `${replaceSecrets(text, replacements)}\n\n(${notes.join(" ")})`, saved, removed };
}
