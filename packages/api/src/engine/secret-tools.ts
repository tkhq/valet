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
 *
 * `delete_secret` — the agent deletes a saved secret after the person
 * approves a card that names it. The delete runs as the person who approved,
 * with the same permission rules as Settings (`assertMayWrite`). It is an
 * assistant tool, not a `valet-secrets` command: a sandbox token can read a
 * secret but never change one.
 */
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ToolDef } from "@valet/engine";
import { SecretStoreError } from "../services/secret-store/provider.js";
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
export const DELETE_SECRET_TOOL = "delete_secret";
export const SECRET_SAVED_ACTION = "saved";
export const SECRET_DECLINE_ACTION = "decline";

/** What the card needs, stored on the gate. Never holds a value. */
export interface SecretRequestContext {
  scope: "personal" | "team";
  teamId?: string;
  name: string;
  purpose: string;
  /** Where the agent will send the value, for example api.openai.com. Shown
   * on the card so the person can judge the request before saving. */
  sendsTo?: string;
  /** The saved value stopped working: the card replaces it. */
  replace?: boolean;
}

/** Reads `context.secretRequest` off a gate, or undefined when it is not one. */
export function secretRequestOf(context: Record<string, unknown> | undefined): SecretRequestContext | undefined {
  const raw = context?.secretRequest;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { scope, teamId, name, purpose, sendsTo, replace } = raw as Record<string, unknown>;
  if ((scope !== "personal" && scope !== "team") || typeof name !== "string" || typeof purpose !== "string") return undefined;
  return {
    scope,
    name,
    purpose,
    ...(typeof teamId === "string" ? { teamId } : {}),
    ...(typeof sendsTo === "string" && sendsTo ? { sendsTo } : {}),
    ...(replace === true ? { replace: true } : {}),
  };
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
      purpose: Type.String({ description: "One sentence: what you will use it for." }),
      sends_to: Type.Optional(Type.String({ description: "The host or service the value will be sent to, for example api.openai.com." })),
      replace: Type.Optional(Type.Boolean({ description: "True when the saved value stopped working and the user should enter a new one." })),
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
      const sendsTo = args.sends_to?.trim().slice(0, 200);
      const base = {
        name,
        purpose: args.purpose.trim(),
        ...(sendsTo ? { sendsTo } : {}),
        ...(args.replace ? { replace: true } : {}),
      };
      const request: SecretRequestContext =
        owner.type === "team" ? { scope: "team", teamId: owner.id, ...base } : { scope: "personal", ...base };
      const scope = scopeOf(request);
      const reference = secretReference(scope, name);
      const actor = { orgId: ctx.orgId, userId: ctx.userId };
      // Already saved and not being replaced: no card, no question.
      if (!request.replace && (await deps.secretStore.exists(actor, scope, name).catch(() => false))) {
        return { text: `Saved as ${reference}. Run commands with valet-secrets run --env ${envName(name)}=${reference} -- <command>. Never print the value.` };
      }
      const where = request.scope === "team" ? "this team's secrets" : "your personal secrets";
      const resolution = await ctx.requestDecision({
        type: "credential_request",
        title: request.replace ? `Replace ${name}` : `Add ${name}`,
        body: `${request.purpose}${sendsTo ? `\nIt will be sent to ${sendsTo}.` : ""}\nIt is saved to ${where} and never appears in this conversation. Enter it only in Valet, never in chat.`,
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
  const deleteSecret = defineTool({
    name: DELETE_SECRET_TOOL,
    description:
      "Delete a saved secret from the secret store after the user approves a card that names it. Use it only when the user " +
      "asks to remove a credential, for example after a test or a rotation. The scope defaults to this session's owner: " +
      "personal in a personal session, the team in a team session. Pass scope \"company\" only for a company secret; " +
      "only an organization admin can approve that. Run `valet-secrets find` first if you do not know the exact name.",
    parameters: Type.Object({
      name: Type.String({ description: "The saved name, for example OPENAI_API_KEY. Not the value and not the secret:// reference." }),
      scope: Type.Optional(Type.Union([Type.Literal("personal"), Type.Literal("team"), Type.Literal("company")], {
        description: "Which secrets to delete from. Omit it for this session's own scope.",
      })),
    }),
    execute: async (args, ctx) => {
      const name = args.name.trim();
      if (!validSecretName(name)) {
        return { text: "Pass the saved name, for example OPENAI_API_KEY. Run valet-secrets find to list the saved names." };
      }
      if (ctx.unattendedWorkflow) {
        return { text: "A workflow run cannot delete a secret. Ask the user to delete it in Settings, Secrets." };
      }
      const scope = deleteScopeOf(args.scope, ctx.owner);
      if (typeof scope === "string") return { text: scope };
      const reference = secretReference(scope, name);
      const where = scope.kind === "company" ? "the company's secrets" : scope.kind === "team" ? "this team's secrets" : "your personal secrets";
      const asker = { orgId: ctx.orgId, userId: ctx.userId };
      if (!(await deps.secretStore.exists(asker, scope, name).catch(() => false))) {
        return { text: `No secret named ${name} in ${where}. Run valet-secrets find to list the saved names.` };
      }
      // The card shows the agent's stated reason on its own (`agentReason`).
      const resolution = await ctx.requestDecision({
        type: "approval",
        title: `Delete ${name}?`,
        body: `This deletes ${reference} from ${where}. Commands that use it stop working. You cannot undo this.`,
        resumeKey: `${DELETE_SECRET_TOOL}:${reference}`,
      });
      if (resolution.actionId !== "approve") {
        return { text: `The user did not approve deleting ${name}. It is still saved. Do not delete it another way.` };
      }
      try {
        await deps.secretStore.remove({ orgId: ctx.orgId, userId: resolution.resolvedBy }, scope, name);
      } catch (err) {
        if (err instanceof SecretStoreError) return { text: `${name} was not deleted: ${err.message}` };
        throw err;
      }
      return { text: `Deleted ${reference}. Commands that reference it now fail.` };
    },
  });
  return [requestSecret, deleteSecret];
}

/**
 * The scope a delete targets. A session reaches its own owner's secrets and
 * the company's: a team session never names a person's personal secrets,
 * and a personal session never names a team's.
 */
export function deleteScopeOf(
  requested: "personal" | "team" | "company" | undefined,
  owner: { type: "user" | "team" | "org"; id: string } | undefined,
): SecretScope | string {
  if (requested === "company") return { kind: "company" };
  if (!owner || owner.type === "org") {
    return "This session belongs to the whole organization. It can delete only company secrets: pass scope \"company\".";
  }
  if (owner.type === "team") {
    if (requested === "personal") return "A team session cannot delete a personal secret. Ask the user to delete it from a personal thread or in Settings, Secrets.";
    return { kind: "team", teamId: owner.id };
  }
  if (requested === "team") return "A personal session cannot delete a team secret. Delete it from a thread in that team, or in Settings, Secrets.";
  return { kind: "personal" };
}

/** The env var the reference goes into: the last segment, as a shell name. */
function envName(name: string): string {
  const last = name.split("/").pop() ?? name;
  const cleaned = last.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
