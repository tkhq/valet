/**
 * Context pack snapshots: build the pack each `pull_request` case would give
 * the reviewer, with no model call, and compare it to a saved snapshot:
 *
 *   pnpm --filter @valet/eval pack-snapshot --cases private:<suite> --out <dir> [--update]
 *
 * A snapshot lists the items in the pack (section, reference, size) and the
 * items left out with their reasons. The cases pin their commits, so the
 * pack changes only when the gather code, the budget or the memory changes.
 * Every difference prints, and the command exits 2, so a change to the pack
 * builder is read before it ships. `--update` saves the current packs.
 * Keep snapshots of private repositories out of the repo.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { directoryMemory, gatherPipelineContext, mergeBase } from "@valet/plugin-pr-review";
import { loadCases } from "./case-loader.js";
import { resolvePrivateCases } from "./private-pull-request.js";
import { githubRepo, withCaseWorkspace } from "./pull-request.js";

export interface PackSnapshot {
  caseId: string;
  head: string;
  budgetChars: number;
  usedChars: number;
  items: { section: string; ref: string; chars: number }[];
  dropped: { section: string; ref: string; reason: string }[];
}

/** Items whose size changed by less than this share count as the same item. */
const SIZE_TOLERANCE = 0.02;

/** What differs between a saved snapshot and the current pack, one line per difference. Empty when they match. */
export function diffSnapshots(saved: PackSnapshot, now: PackSnapshot): string[] {
  const out: string[] = [];
  const key = (x: { section: string; ref: string }): string => `${x.section}: ${x.ref}`;
  const savedItems = new Map(saved.items.map((i) => [key(i), i]));
  const nowItems = new Map(now.items.map((i) => [key(i), i]));
  for (const [k, i] of nowItems) {
    const before = savedItems.get(k);
    if (!before) out.push(`+ item ${k} (${i.chars} chars)`);
    else if (Math.abs(i.chars - before.chars) > Math.max(1, before.chars * SIZE_TOLERANCE)) out.push(`~ item ${k}: ${before.chars} -> ${i.chars} chars`);
  }
  for (const [k, i] of savedItems) if (!nowItems.has(k)) out.push(`- item ${k} (${i.chars} chars)`);
  const dropKey = (d: PackSnapshot["dropped"][number]): string => `${key(d)} (${d.reason.replace(/\(\d+ chars\)/, "(N chars)")})`;
  const savedDrops = new Set(saved.dropped.map(dropKey));
  const nowDrops = new Set(now.dropped.map(dropKey));
  for (const d of nowDrops) if (!savedDrops.has(d)) out.push(`+ left out ${d}`);
  for (const d of savedDrops) if (!nowDrops.has(d)) out.push(`- left out ${d}`);
  if (saved.budgetChars !== now.budgetChars) out.push(`~ budget ${saved.budgetChars} -> ${now.budgetChars} chars`);
  // A snapshot from another commit is not a baseline for this one, even when its items look alike.
  if (saved.head !== now.head) out.push(`~ head ${saved.head.slice(0, 12)} -> ${now.head.slice(0, 12)}: the case now pins another commit`);
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cases: { type: "string" },
      out: { type: "string" },
      update: { type: "boolean" },
      filter: { type: "string" },
      "context-budget": { type: "string" },
      "memory-dir": { type: "string" },
      "memory-mount": { type: "string" },
    },
  });
  if (!values.cases || !values.out) {
    throw new Error("Usage: pack-snapshot --cases <dir | private:suite> --out <snapshot dir> [--update] [--filter text] [--context-budget 12000] [--memory-dir dir] [--memory-mount lib]");
  }
  const privateCases = resolvePrivateCases(values.cases);
  if (privateCases && "skip" in privateCases) throw new Error(privateCases.skip);
  const dir = privateCases ? privateCases.dir : values.cases;
  const budgetTokens = Number(values["context-budget"] ?? 12000);
  const memory = values["memory-dir"] !== undefined ? directoryMemory(values["memory-dir"], values["memory-mount"] ?? "lib") : undefined;
  const cases = (await loadCases(dir)).filter((c) => c.pull_request !== undefined && (values.filter === undefined || c.id.includes(values.filter)));
  if (cases.length === 0) throw new Error(`No pull_request cases in ${dir}. Check --cases and --filter.`);
  await mkdir(values.out, { recursive: true });

  let changed = 0;
  for (const c of cases) {
    const spec = c.pull_request;
    if (!spec) continue;
    const pack = await withCaseWorkspace(c.id, spec, async (workspace) => {
      const repo = githubRepo(spec.remote);
      return gatherPipelineContext({
        workspace,
        base: await mergeBase(workspace, spec.base, spec.head),
        head: spec.head,
        title: spec.title ?? "",
        contextBudget: budgetTokens * 4,
        ...(memory ? { memory } : {}),
        ...(repo ? { repo } : {}),
      });
    });
    if (!pack) throw new Error("--context-budget must be above 0: a budget of 0 builds no pack.");
    const now: PackSnapshot = {
      caseId: c.id,
      head: spec.head,
      budgetChars: pack.manifest.budgetChars,
      usedChars: pack.manifest.usedChars,
      items: pack.manifest.items.map((i) => ({ section: i.section, ref: i.ref, chars: i.chars })),
      dropped: pack.manifest.dropped.map((d) => ({ section: d.section, ref: d.ref, reason: d.reason })),
    };
    const file = join(values.out, `${c.id}.json`);
    const saved = await readFile(file, "utf8").then((t) => JSON.parse(t) as PackSnapshot, () => undefined);
    if (values.update || !saved) {
      await writeFile(file, `${JSON.stringify(now, null, 2)}\n`);
      console.log(`${c.id}: ${saved ? "updated" : "saved"} (${now.items.length} items, ${now.usedChars} chars)`);
      continue;
    }
    const diff = diffSnapshots(saved, now);
    if (diff.length === 0) {
      console.log(`${c.id}: same`);
    } else {
      changed++;
      console.log(`${c.id}: ${diff.length} difference(s)`, ...diff.map((d) => `\n  ${d}`));
    }
  }
  if (changed > 0) {
    console.log(`\n${changed} of ${cases.length} pack(s) changed. Read each difference. If every one is intended, run again with --update.`);
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
