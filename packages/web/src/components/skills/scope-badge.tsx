/**
 * The scope badge shared by the Library grid and both settings source panels.
 *
 * One badge names where a skill or a source lives: Personal, Team, Org, or
 * Plugin. The colours are pre-mixed theme washes, never invented CSS vars —
 * an invented var paints nothing (see the OPACITY-MODIFIER-TRAP note in
 * theme.css). Personal is neutral, Team is an ink wash, Org is a moss wash,
 * Plugin is muted text.
 */
import type { SkillSummary } from "@valet/api/wire";
import { Badge } from "~/components/primitives";

/** The four library scopes. `plugin` never applies to a source. */
export type Scope = "personal" | "team" | "org" | "plugin";

const LABEL: Record<Scope, string> = {
  personal: "Personal",
  team: "Team",
  org: "Org",
  plugin: "Plugin",
};

/** Real theme tokens only. `bg-ink-wash` / `bg-moss-wash` / `text-muted` are
 * defined in tailwind.config.ts; a made-up var would paint nothing. */
const CLASS: Record<Scope, string> = {
  personal: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  team: "bg-ink-wash text-ink",
  org: "bg-moss-wash text-moss",
  plugin: "bg-transparent text-muted",
};

/** Maps a stored owner type onto a scope. `user` reads as personal. */
export function scopeForOwnerType(ownerType: "user" | "team" | "org"): Scope {
  if (ownerType === "team") return "team";
  if (ownerType === "org") return "org";
  return "personal";
}

/** Maps a catalog summary onto a scope: a plugin skill is `plugin`, a stored
 * skill follows its `ownerType`. */
export function scopeForSkill(skill: SkillSummary): Scope {
  if (skill.origin === "plugin") return "plugin";
  return scopeForOwnerType(skill.ownerType);
}

export function ScopeBadge({ scope }: { scope: Scope }) {
  return <Badge className={CLASS[scope]}>{LABEL[scope]}</Badge>;
}
