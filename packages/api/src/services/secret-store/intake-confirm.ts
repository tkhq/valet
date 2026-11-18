/**
 * Stage 2 of secret intake (`docs/specs/2026-11-17-secret-intake-design.md`):
 * the organization's smallest model tier (`xs`) confirms stage-1 candidates
 * that are not in a known provider format. It runs only when such a
 * candidate exists, so most messages make no model call. The model has no
 * tools and sees each candidate with 200 characters of context.
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { CredentialStore } from "@valet/engine";
import { INTAKE_SYSTEM_PROMPT, buildIntakePrompt, parseIntakeVerdicts, type IntakeVerdict, type SecretTokenCandidate } from "@valet/shared";
import type { AppDb } from "../../lib/drizzle.js";
import { modelFetchFor } from "../../lib/outbound-url.js";
import { resolveModelSpec } from "../model-resolution.js";

export interface IntakeConfirmRequest {
  orgId: string;
  text: string;
  candidates: SecretTokenCandidate[];
  credentialRequested: boolean;
}

/** One verdict per candidate; `undefined` where the model gave none. */
export type ConfirmIntake = (request: IntakeConfirmRequest) => Promise<(IntakeVerdict | undefined)[]>;

/** How long a message waits for the model before intake decides without it. */
export const INTAKE_CONFIRM_TIMEOUT_MS = 5000;

export function intakeConfirmer(db: AppDb, credentials: CredentialStore): ConfirmIntake {
  return async ({ orgId, text, candidates, credentialRequested }) => {
    const none = candidates.map((): IntakeVerdict | undefined => undefined);
    const resolved = await resolveModelSpec(db, credentials, orgId, "xs");
    if (!resolved) return none;
    const signal = AbortSignal.timeout(INTAKE_CONFIRM_TIMEOUT_MS);
    try {
      const result = await completeSimple(
        resolved.model,
        {
          systemPrompt: INTAKE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: buildIntakePrompt(text, candidates, credentialRequested) }], timestamp: Date.now() }],
        },
        { apiKey: resolved.apiKey, fetch: modelFetchFor(resolved.model), temperature: 0, maxTokens: 600, signal },
      );
      if (result.stopReason === "error" || result.stopReason === "aborted") return none;
      const answer = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      return parseIntakeVerdicts(answer, candidates.length);
    } catch {
      // The message is never held up by the model: intake decides without it.
      return none;
    }
  };
}
