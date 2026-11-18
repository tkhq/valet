/**
 * The backstop for a key that reaches the api inside a user message: a
 * client without the composer prompt, a channel such as Slack, an answer to
 * an agent's question, or a key the user kept as text. Each key in a known provider format is saved as a
 * secret and replaced with its reference before the message is stored or
 * reaches the model. A note at the end of the message tells the user and
 * the agent what happened.
 *
 * Keys in a known provider format, and stage-1 candidates scored at least
 * 0.5, are always caught. With a model (`confirm`, the organization's `xs`
 * tier), weaker candidates are caught too when the model confirms them. The
 * model may add candidates but never veto a strong one: in the eval
 * (`docs/specs/2026-11-17-secret-intake-design.md`) a veto cost recall and
 * prevented no false alarm. Without a model verdict, a weak candidate is
 * left as text.
 *
 * The api holds the value in memory for this request: it arrived in the
 * message. The note says so and asks the user to rotate a key that was
 * also shared elsewhere, for example in a Slack channel, where the
 * original message stays.
 */
import { detectSecrets, findSecretCandidates, replaceSecrets, suggestSecretName, type SecretTokenCandidate } from "@valet/shared";
import type { ConfirmIntake } from "./intake-confirm.js";
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

/** Stage-1 score at which a candidate is caught without asking the model. */
export const STRONG_CANDIDATE_SCORE = 0.5;
/** Lowest stage-1 score the model is asked about. */
export const MODEL_CANDIDATE_SCORE = 0.2;

interface Caught {
  candidate: SecretTokenCandidate;
  name: string;
  label: string;
}

/** The candidates to replace: known formats, plus confirmed or strong others. */
export async function catchSecrets(
  text: string,
  opts: { orgId: string; confirm?: ConfirmIntake; credentialRequested?: boolean },
): Promise<Caught[]> {
  const all = findSecretCandidates(text, opts.credentialRequested ? { credentialRequested: true } : {});
  const caught: Caught[] = all
    .filter((c) => c.reason === "known")
    .map((c) => ({ candidate: c, name: suggestSecretName(c), label: (c.provider ?? "key").toLowerCase() }));
  for (const c of all) {
    if (c.reason !== "known" && c.score >= STRONG_CANDIDATE_SCORE) caught.push({ candidate: c, name: suggestSecretName(c), label: "key" });
  }
  const weak = all.filter((c) => c.reason !== "known" && c.score >= MODEL_CANDIDATE_SCORE && c.score < STRONG_CANDIDATE_SCORE);
  if (weak.length > 0 && opts.confirm) {
    const verdicts = await opts.confirm({ orgId: opts.orgId, text, candidates: weak, credentialRequested: opts.credentialRequested === true });
    weak.forEach((c, i) => {
      const verdict = verdicts[i];
      if (verdict?.secret === true) caught.push({ candidate: c, name: suggestSecretName(c, verdict.provider), label: "key" });
    });
  }
  return caught.sort((a, b) => a.candidate.start - b.candidate.start);
}

export async function scrubInboundSecrets(deps: {
  store: SecretStoreService;
  actor: SecretActor;
  scope: SecretScope;
  text: string;
  /** Where the message came from, for the note. */
  channel?: "web" | "channel";
  /** Stage 2. Without it, only known formats and strong candidates are caught. */
  confirm?: ConfirmIntake;
}): Promise<ScrubResult> {
  const { store, actor, scope, text } = deps;
  if (!store.enabled) return { text, saved: [], removed: 0 };
  const caught = await catchSecrets(text, { orgId: actor.orgId, ...(deps.confirm ? { confirm: deps.confirm } : {}) });
  if (caught.length === 0) return { text, saved: [], removed: 0 };

  const replacements: { candidate: { start: number; end: number }; with: string }[] = [];
  const saved: string[] = [];
  let removed = 0;
  for (const { candidate, name: suggested, label } of caught) {
    try {
      const name = await freeName(store, actor, scope, suggested);
      await store.saveValue(actor, scope, name, candidate.value);
      const reference = secretReference(scope, name);
      saved.push(reference);
      replacements.push({ candidate, with: reference });
    } catch (err) {
      if (!(err instanceof SecretStoreError)) throw err;
      removed += 1;
      replacements.push({ candidate, with: `[removed ${label}]` });
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

/** The session a piece of user input goes to: who owns it, and who typed. */
export interface InboundSession {
  orgId: string;
  userId: string;
  ownerType: string;
  ownerId: string | null;
}

/**
 * The backstop for any text a person sends into a session: a message, an
 * answer to a question, a first prompt, an artifact comment. A team
 * session saves to the team's secrets, any other session to the person's
 * own. Returns `text` unchanged when the deployment has no secret store.
 */
export async function scrubSessionInput(
  store: SecretStoreService | undefined,
  session: InboundSession,
  text: string,
  channel: "web" | "channel",
): Promise<string> {
  if (!store?.enabled) return text;
  const scope: SecretScope = session.ownerType === "team" && session.ownerId ? { kind: "team", teamId: session.ownerId } : { kind: "personal" };
  return (
    await scrubInboundSecrets({
      store,
      actor: { orgId: session.orgId, userId: session.userId },
      scope,
      text,
      channel,
      ...(store.confirmIntake ? { confirm: store.confirmIntake } : {}),
    })
  ).text;
}

/**
 * `text` with each key in a known format replaced by a placeholder, and
 * nothing saved. For text that repeats an earlier message, such as both
 * sides of an edit: the backstop already saved the original key, and saving
 * it again would make a duplicate. Unchanged without a secret store, like
 * the backstop.
 */
export function maskKnownSecrets(store: SecretStoreService | undefined, text: string): string {
  if (!store?.enabled) return text;
  const candidates = detectSecrets(text).filter((c) => c.confidence === "known");
  if (candidates.length === 0) return text;
  return replaceSecrets(text, candidates.map((candidate) => ({ candidate, with: `[removed ${candidate.label.toLowerCase()}]` })));
}
