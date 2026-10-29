/**
 * Playbooks: skills whose steps seed the thread plan
 * (`docs/specs/2026-10-27-brain-principles-playbooks-design.md`).
 *
 * A playbook is an ordinary Agent Skills `SKILL.md` that sets
 * `metadata.kind: playbook` and lists its steps under a `## Steps` heading.
 * The spec's `metadata` map keeps the file valid for every other harness.
 */
import { THREAD_PLAN_MAX_ITEMS, THREAD_PLAN_MAX_TEXT, type ThreadPlanItem } from "@valet/shared";
import type { SkillSource } from "../types.js";

export const PLAYBOOK_KIND = "playbook";

/** The result of reading a playbook's steps. `reason` says why a playbook
 * cannot seed the plan, so the skill result can tell the model. */
export type PlaybookSteps =
  | { kind: "steps"; steps: string[] }
  | { kind: "invalid"; reason: string };

export function isPlaybook(skill: Pick<SkillSource, "metadata">): boolean {
  return skill.metadata?.kind === PLAYBOOK_KIND;
}

const STEPS_HEADING = /^#{2,3}\s+steps\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s{0,3}(?:\d+[.)]|[-*])\s+(.+?)\s*$/;

/**
 * The steps of a playbook body: the list items under the first `## Steps`
 * (or `### Steps`) heading, up to the next heading. Fenced code is skipped.
 */
export function readPlaybookSteps(content: string): PlaybookSteps {
  const steps: string[] = [];
  let inSteps = false;
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!inSteps) {
      if (STEPS_HEADING.test(line)) inSteps = true;
      continue;
    }
    if (ANY_HEADING.test(line)) break;
    const match = LIST_ITEM.exec(line);
    if (match) steps.push(match[1]!);
  }
  if (steps.length === 0) {
    return { kind: "invalid", reason: "It has no list items under a \"## Steps\" heading." };
  }
  if (steps.length > THREAD_PLAN_MAX_ITEMS) {
    return { kind: "invalid", reason: `It has ${steps.length} steps. A plan holds at most ${THREAD_PLAN_MAX_ITEMS}.` };
  }
  const long = steps.findIndex((step) => step.length > THREAD_PLAN_MAX_TEXT);
  if (long !== -1) {
    return { kind: "invalid", reason: `Step ${long + 1} is longer than ${THREAD_PLAN_MAX_TEXT} characters.` };
  }
  return { kind: "steps", steps };
}

/** Plan items for `steps`: the first step in progress, the rest pending. */
export function playbookPlanItems(steps: string[]): ThreadPlanItem[] {
  return steps.map((text, index) => ({ text, status: index === 0 ? "in_progress" : "pending" }));
}

/**
 * What seeding did. `seeded`: the plan now holds the steps. `kept`: the
 * thread had an open plan, which stays. `invalid`: the playbook cannot seed
 * a plan. `unavailable`: this context cannot keep a plan.
 */
export type PlaybookSeedResult =
  | { kind: "seeded"; steps: string[] }
  | { kind: "kept"; steps: string[] }
  | { kind: "invalid"; reason: string }
  | { kind: "unavailable" };

/** One line for the model about a seed result. */
export function playbookSeedNote(name: string, result: PlaybookSeedResult): string {
  switch (result.kind) {
    case "seeded":
      return `[playbook] Your plan now holds the ${result.steps.length} steps of "${name}". Follow them in order. Keep the plan current with update_plan.`;
    case "kept":
      return `[playbook] This thread already has an open plan, so the plan did not change. If the steps of "${name}" apply, add them with update_plan.`;
    case "invalid":
      return `[playbook] "${name}" did not set your plan. ${result.reason} Follow the skill as written.`;
    case "unavailable":
      return `[playbook] This session cannot keep a plan. Follow the steps of "${name}" in order.`;
  }
}
