/**
 * Agent-facing skill actions (spec:
 * docs/specs/2026-08-05-agent-skills-design.md). Exposed through the plugin
 * catalog (`list_tools`/`call_tool`), so an orchestrator can turn what it
 * just learned in a conversation into a stored skill.
 *
 * One of two in-product authoring paths: a person writes a skill on the
 * Skills tab, and an agent writes one here. Both reach the same service —
 * `services/skills.ts` — so ownership, team membership, and the frontmatter
 * rules are checked in ONE place: this module adds no rule of its own and
 * skips none.
 *
 * Risk levels are deliberately higher than the workflow actions'. A stored
 * skill is standing instruction text that every later session of that owner
 * can pull in, and the catalog's default policy auto-allows anything below
 * `high`, so each write asks a human first.
 */
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import type { SkillRow } from "../schema/index.js";
import { isOrgAdmin } from "./org.js";
import {
  asRecord,
  createSkill,
  deleteSkill,
  listSkills,
  SkillNameConflictError,
  SkillNotLocalError,
  SkillValidationError,
  updateSkill,
  type SkillOwner,
} from "./skills.js";

/**
 * Curried action builder (same shape as `workflows/actions.ts`): the first
 * call binds T from the parameters schema; the second types `execute`'s args
 * via Static<T>, sidestepping TS's contextual-inference depth limit.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const NO_OWNER: PluginActionResult = {
  success: false,
  error: "no authenticated principal in tool context",
};

/**
 * The caller, from the tool context. A skill is written for the acting
 * USER, exactly as `POST /api/skills` writes it; `team_id` is the only way
 * to write for a team, and the service rejects a team the caller is not on.
 */
export function skillOwnerFromContext(ctx: PluginActionContext): SkillOwner | null {
  const { userId, orgId } = ctx as { userId?: unknown; orgId?: unknown };
  if (typeof userId !== "string" || userId.length === 0) return null;
  if (typeof orgId !== "string" || orgId.length === 0) return null;
  return { userId, orgId };
}

/** A row as the agent sees it. The body stays out: a listing is a catalog,
 * and the `skill` tool is what reads a body into the turn. */
function toSummary(row: SkillRow): Record<string, unknown> {
  // `invocation` and `argHint` live in the `frontmatter` jsonb column, same as
  // `rowToSkillSource` reads them. Both are omitted when absent or the wrong
  // type, so a plain `"context"` skill lists without either field.
  const fm = asRecord(row.frontmatter);
  const invocation = fm.invocation === "context" || fm.invocation === "prompt" ? fm.invocation : undefined;
  const argHint = typeof fm.argHint === "string" ? fm.argHint : undefined;
  return {
    skillId: row.id,
    name: row.name,
    description: row.description,
    origin: row.origin,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    updatedAt: row.updatedAt,
    ...(invocation !== undefined ? { invocation } : {}),
    ...(argHint !== undefined ? { argHint } : {}),
  };
}

/**
 * Turns a service error into a tool result the model can act on. Every one
 * of these messages already names the corrective action, so they pass
 * through unchanged. Anything else rethrows — an unexpected failure must
 * not read as a validation problem.
 */
function failure(err: unknown): PluginActionResult {
  if (
    err instanceof SkillValidationError ||
    err instanceof SkillNameConflictError ||
    err instanceof SkillNotLocalError ||
    err instanceof NotFoundError
  ) {
    return { success: false, error: err.message };
  }
  throw err;
}

/**
 * `db` is passed directly, not through a deferred getter: the app Drizzle
 * handle exists before plugin assembly in `providers/node.ts`, unlike the
 * workflow store and run host that force `workflowsActionPlugin`'s getter.
 */
export function skillsActionPlugin(db: AppDb): ActionPlugin {
  const listSkillsAction = action(Type.Object({}))({
    id: "skills.list_skills",
    name: "List skills",
    description:
      "List the stored skills you can reach: your own, plus every team you belong to. " +
      "Returns names and descriptions, not bodies — call the `skill` tool with a name to " +
      "read one. Skills a plugin ships are not listed here.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const owner = skillOwnerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const rows = await listSkills(db, owner);
      return { success: true, data: { skills: rows.map(toSummary) } };
    },
  });

  const createSkillAction = action(
    Type.Object({
      name: Type.String({
        description:
          'Lookup key, 1-64 characters of "a-z", "0-9", and "-". The agent asks for the skill by this name.',
      }),
      description: Type.String({
        description:
          "One line saying what the skill does and when to use it. Every turn carries this line.",
      }),
      content: Type.String({
        description: "The markdown body, with NO frontmatter. Name and description are fields here.",
      }),
      team_id: Type.Optional(
        Type.String({
          description:
            "Store the skill for a team you belong to instead of for yourself. A team you are not on is reported as not found.",
        }),
      ),
      owner_type: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("team"), Type.Literal("org")], {
          description:
            'Store the skill for the whole org with "org"; you must be an org admin, or the write is refused.',
        }),
      ),
      invocation: Type.Optional(
        Type.Union([Type.Literal("context"), Type.Literal("prompt")], {
          description:
            'How a session runs the skill: "context" (default) loads the body as reference; "prompt" substitutes args into the body and sends it as the message.',
        }),
      ),
      arg_hint: Type.Optional(
        Type.String({
          description:
            'Palette hint for the first argument of a "prompt" skill, e.g. "<topic>". Ignored for a "context" skill.',
        }),
      ),
    }),
  )({
    id: "skills.create_skill",
    name: "Create skill",
    description:
      "Store a new skill: a markdown playbook that any later session of this owner can read " +
      "with the `skill` tool. Write one when the user teaches you a procedure worth keeping. " +
      "The name and the description are checked against the Agent Skills spec before the skill " +
      "is stored. A name a plugin skill already holds is stored but SHADOWED — it never reaches " +
      "a session, so pick a name no installed skill uses. Returns { skillId }.",
    // High → the catalog's default policy asks a human first. The body
    // becomes standing instructions for every later session of this owner,
    // so a silent write would let anything the agent read steer its future
    // turns. Same reasoning that keeps workflows.create_webhook at high.
    riskLevel: "high",
    execute: async ({ name, description, content, team_id, owner_type, invocation, arg_hint }, ctx) => {
      const owner = skillOwnerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // An org write needs the org-admin flag, resolved exactly as the route
      // does. Gate before the write, so a non-admin gets a clear refusal
      // instead of a silently personal skill.
      let orgAdmin = false;
      if (owner_type === "org") {
        orgAdmin = await isOrgAdmin(db, owner.orgId, owner.userId);
        if (!orgAdmin) {
          return {
            success: false,
            error:
              "Only an org admin can store an org-wide skill. Ask an org admin, or omit owner_type to store it for yourself.",
          };
        }
      }
      try {
        const row = await createSkill(db, owner, {
          name,
          description,
          content,
          ...(team_id === undefined ? {} : { teamId: team_id }),
          ...(owner_type === undefined ? {} : { ownerType: owner_type }),
          ...(invocation === undefined ? {} : { invocation }),
          ...(arg_hint === undefined ? {} : { argHint: arg_hint }),
          isOrgAdmin: orgAdmin,
        });
        return { success: true, data: toSummary(row) };
      } catch (err) {
        return failure(err);
      }
    },
  });

  const updateSkillAction = action(
    Type.Object({
      skill_id: Type.String({ description: "Row id from list_skills or create_skill." }),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      content: Type.Optional(Type.String({ description: "Replaces the whole body." })),
      invocation: Type.Optional(
        Type.Union([Type.Literal("context"), Type.Literal("prompt")], {
          description:
            'How a session runs the skill: "context" loads the body as reference; "prompt" substitutes args into the body and sends it as the message.',
        }),
      ),
      arg_hint: Type.Optional(
        Type.String({
          description:
            'Palette hint for the first argument of a "prompt" skill, e.g. "<topic>". Ignored for a "context" skill.',
        }),
      ),
    }),
  )({
    id: "skills.update_skill",
    name: "Update skill",
    description:
      "Edit a stored skill. Every field is optional; the fields you omit keep their stored " +
      "value, and `content` REPLACES the whole body. A skill that came from a repository is " +
      "refused — edit it in that repository. Returns { skillId }.",
    // High, for the same reason as create: this rewrites instructions later
    // sessions follow, and a rename can move the skill in or out of the
    // shadow of another skill of the same name.
    riskLevel: "high",
    execute: async ({ skill_id, name, description, content, invocation, arg_hint }, ctx) => {
      const owner = skillOwnerFromContext(ctx);
      if (!owner) return NO_OWNER;
      // Resolve the org-admin flag so an org-owned row is editable by an org
      // admin, matching route behavior; a non-admin still reads not found.
      const orgAdmin = await isOrgAdmin(db, owner.orgId, owner.userId);
      try {
        const row = await updateSkill(db, owner, skill_id, {
          name,
          description,
          content,
          ...(invocation === undefined ? {} : { invocation }),
          ...(arg_hint === undefined ? {} : { argHint: arg_hint }),
          isOrgAdmin: orgAdmin,
        });
        if (!row) return { success: false, error: `skill not found: ${skill_id}` };
        return { success: true, data: toSummary(row) };
      } catch (err) {
        return failure(err);
      }
    },
  });

  const deleteSkillAction = action(
    Type.Object({ skill_id: Type.String({ description: "Row id from list_skills." }) }),
  )({
    id: "skills.delete_skill",
    name: "Delete skill",
    description:
      "Permanently remove a stored skill. There is no undo and no version history. A skill " +
      "that came from a repository is refused — remove it in that repository.",
    // High → the row is hard-deleted with no restore path, and the body may
    // be text a person wrote by hand.
    riskLevel: "high",
    execute: async ({ skill_id }, ctx) => {
      const owner = skillOwnerFromContext(ctx);
      if (!owner) return NO_OWNER;
      const orgAdmin = await isOrgAdmin(db, owner.orgId, owner.userId);
      const result = await deleteSkill(db, owner, skill_id, { isOrgAdmin: orgAdmin });
      if (result === "not_found") return { success: false, error: `skill not found: ${skill_id}` };
      if (result === "not_local") {
        return {
          success: false,
          error: `skill ${skill_id} comes from a repository. Remove it in the repository it came from.`,
        };
      }
      return { success: true, data: { skillId: skill_id, deleted: true } };
    },
  });

  return {
    service: "skills",
    description: "Create, edit, and remove the markdown skills a session can read.",
    actions: [listSkillsAction, createSkillAction, updateSkillAction, deleteSkillAction],
  };
}
