/**
 * `request_secret` — the agent asks the person for a credential without the
 * value entering the thread.
 *
 * The tool opens a `credential_request` gate whose context carries
 * `secretRequest`. The web card shows the name, where it will be saved, and
 * a masked field. The browser seals the value and saves it through
 * `/api/secrets/import/*`, then answers the gate with only the reference.
 * The resolve route refuses any other answer on such a gate
 * (`secretRequestAnswerRefusal`), so a typed value cannot land in the gate.
 *
 * The scope follows the session's owner: a personal session saves a
 * personal secret, a team session a team secret. Company secrets are set by
 * admins in Settings, never requested by an agent.
 */
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ToolDef } from "@valet/engine";
import {
  parseSecretReference,
  secretReference,
  validSecretName,
  type SecretScope,
  type SecretStoreService,
} from "../services/secret-store/service.js";

/** Preserves the schema's static type through `execute`, like the other tool files. */
function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

export const REQUEST_SECRET_TOOL = "request_secret";
export const SECRET_SAVED_ACTION = "saved";
export const SECRET_DECLINE_ACTION = "decline";

/** What the card needs, stored on the gate. Never holds a value. */
export interface SecretRequestContext {
  scope: "personal" | "team";
  teamId?: string;
  name: string;
  purpose: string;
}

/** Reads `context.secretRequest` off a gate, or undefined when it is not one. */
export function secretRequestOf(context: Record<string, unknown> | undefined): SecretRequestContext | undefined {
  const raw = context?.secretRequest;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { scope, teamId, name, purpose } = raw as Record<string, unknown>;
  if ((scope !== "personal" && scope !== "team") || typeof name !== "string" || typeof purpose !== "string") return undefined;
  return { scope, name, purpose, ...(typeof teamId === "string" ? { teamId } : {}) };
}

function scopeOf(request: SecretRequestContext): SecretScope {
  return request.scope === "team" && request.teamId ? { kind: "team", teamId: request.teamId } : { kind: "personal" };
}

/**
 * Why an answer to a secret-request gate is refused, or null when it is
 * allowed. Allowed: decline with no value, or "saved" with exactly the
 * reference the gate asked for.
 */
export function secretRequestAnswerRefusal(
  request: SecretRequestContext,
  answer: { actionId?: string; value?: string },
): string | null {
  if (answer.actionId === SECRET_DECLINE_ACTION && answer.value === undefined) return null;
  if (answer.actionId === SECRET_SAVED_ACTION && answer.value === secretReference(scopeOf(request), request.name)) return null;
  return "Answer this request from the card in Valet: save the value there, or decline. Never send the value as text.";
}

/** A name the user can read and a shell can use: letters, digits, underscore. */
function normalizeName(raw: string): string | null {
  const name = raw.trim().replace(/[^A-Za-z0-9_./-]/g, "_");
  return validSecretName(name) ? name : null;
}

export function buildSecretTools(deps: { secretStore: SecretStoreService }): ToolDef[] {
  const requestSecret = defineTool({
    name: REQUEST_SECRET_TOOL,
    description:
      "Ask the user for a credential, such as an API key or token, through a secure card. The value is saved to the secret store " +
      "and never enters the conversation; you get back a reference. Use it whenever a task needs a credential the user has not " +
      "saved. Never ask the user to paste a credential into chat. Then run commands with " +
      "`valet-secrets run --env NAME=<reference> -- <command>`.",
    parameters: Type.Object({
      name: Type.String({ description: "Name to save it under, in env-var style, for example OPENAI_API_KEY." }),
      purpose: Type.String({ description: "One sentence: what you will use it for, and where it will be sent." }),
    }),
    execute: async (args, ctx) => {
      const name = normalizeName(args.name);
      if (!name) return { text: "Pick a name of letters, digits, and underscore, for example OPENAI_API_KEY, then call request_secret again." };
      const owner = ctx.owner;
      if (!owner || owner.type === "org") {
        return {
          text: "This session cannot save a credential: it belongs to the whole organization. Ask an organization admin to add it under Settings, Secrets, Company, then use secret://company/NAME.",
        };
      }
      if (ctx.unattendedWorkflow) {
        return { text: "A workflow run cannot ask the user for a credential. Ask the user to save it in Settings, Secrets, before the run." };
      }
      const request: SecretRequestContext =
        owner.type === "team"
          ? { scope: "team", teamId: owner.id, name, purpose: args.purpose.trim() }
          : { scope: "personal", name, purpose: args.purpose.trim() };
      const scope = scopeOf(request);
      const reference = secretReference(scope, name);
      const actor = { orgId: ctx.orgId, userId: ctx.userId };
      // Already saved: no card, no question.
      if (await deps.secretStore.exists(actor, scope, name).catch(() => false)) {
        return { text: `Already saved as ${reference}. Run commands with valet-secrets run --env ${envName(name)}=${reference} -- <command>.` };
      }
      const where = request.scope === "team" ? "this team's secrets" : "your personal secrets";
      const resolution = await ctx.requestDecision({
        type: "credential_request",
        title: `Add ${name}`,
        body: `${request.purpose}\nIt is saved to ${where} and never appears in this conversation.`,
        context: { secretRequest: request },
        actions: [{ id: SECRET_DECLINE_ACTION, label: "Decline" }],
        resumeKey: `${REQUEST_SECRET_TOOL}:${reference}`,
      });
      if (resolution.actionId !== SECRET_SAVED_ACTION) {
        return { text: `The user declined to add ${name}. Do not ask for it in chat. Continue without it, or ask what they want instead.` };
      }
      const saved = parseSecretReference(resolution.value ?? "");
      const savedBy = { orgId: ctx.orgId, userId: resolution.resolvedBy };
      if (!saved || resolution.value !== reference || !(await deps.secretStore.exists(savedBy, scope, name).catch(() => false))) {
        return { text: `The card closed, but ${reference} is not saved. Call request_secret again.` };
      }
      return {
        text: `Saved as ${reference}. Run commands with valet-secrets run --env ${envName(name)}=${reference} -- <command>. Never print the value.`,
      };
    },
  });
  return [requestSecret];
}

/** The env var the reference goes into: the last segment, as a shell name. */
function envName(name: string): string {
  const last = name.split("/").pop() ?? name;
  const cleaned = last.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
