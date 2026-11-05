// Writes the generated step reference into the workflows skill.
// Run after a change to packages/workflow/src/dag/step-reference.ts or to
// the validator's field tables: `pnpm exec tsx scripts/workflows/write-step-reference.mjs`.
// The api test `workflows/step-reference-skill.test.ts` fails until the
// skill holds the current block.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderStepReferenceBlock, STEP_REFERENCE_END } from "../../packages/workflow/src/dag/step-reference.ts";

const skillPath = fileURLToPath(new URL("../../packages/plugin-workflows/skills/workflows/SKILL.md", import.meta.url));
const skill = readFileSync(skillPath, "utf8");
const block = renderStepReferenceBlock();
const startAt = skill.indexOf("<!-- step-reference:start");
const anchor = "## Templates: reading data between nodes";
let next;
if (startAt !== -1) {
  const endAt = skill.indexOf(STEP_REFERENCE_END, startAt);
  if (endAt === -1) throw new Error("the skill has a step-reference start marker with no end marker");
  next = skill.slice(0, startAt) + block + skill.slice(endAt + STEP_REFERENCE_END.length);
} else {
  const at = skill.indexOf(anchor);
  if (at === -1) throw new Error(`the skill has no "${anchor}" heading to insert the step reference before`);
  next = `${skill.slice(0, at)}## Step reference\n\n${block}\n\n${skill.slice(at)}`;
}
if (next !== skill) writeFileSync(skillPath, next);
console.log(next === skill ? "step reference is current" : "step reference written");
