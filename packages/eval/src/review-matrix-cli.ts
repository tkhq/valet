/**
 * Print the reviewer matrix for a code-review suite: every issue any
 * reviewer raised, and who raised it.
 *
 *   tsx src/review-matrix-cli.ts --cases <dir | private:<suite>> --run valet=<baselines dir> \
 *     [--run valet-context=<baselines dir>] [--model anthropic/claude-sonnet-5-5] \
 *     [--judge-model <provider/model>] [--out matrix.md] [--json matrix.json] [--concurrency 4]
 *
 * Each `--run` names a baselines directory that a suite run wrote with
 * `--save-baseline --baselines <dir>`. `--model` is the reviewer model whose
 * saved baselines are read, for cases that name no model. `--judge-model`
 * picks the model that matches issues across reviewers (default
 * DEFAULT_REVIEW_JUDGE_MODEL). The judge calls go through the Valet
 * gateway (VALET_LLM_GATEWAY_URL and VALET_API_KEY or VALET_API_KEY_FILE).
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveModelId } from "@valet/engine";
import { loadLatestBaseline } from "./baseline.js";
import { loadCases } from "./case-loader.js";
import { DEFAULT_REVIEW_JUDGE_MODEL, modelLlm } from "./checks/review-match.js";
import { llmGatewayFromEnv, viaGateway } from "./gateway.js";
import { resolvePrivateCases } from "./private-pull-request.js";
import { buildCaseMatrix, loadReferenceSidecar, renderMatrixMarkdown, runFindings, type CaseMatrix, type RunReview } from "./review-matrix.js";

function parse(argv: string[]): { cases: string; runs: { label: string; dir: string }[]; model: string; judgeModel: string; out?: string; json?: string; concurrency: number } {
  const runs: { label: string; dir: string }[] = [];
  let cases: string | undefined;
  let model = "anthropic/claude-sonnet-5-5";
  let judgeModel = DEFAULT_REVIEW_JUDGE_MODEL;
  let out: string | undefined;
  let json: string | undefined;
  let concurrency = 4;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--cases": cases = v; i++; break;
      case "--model": model = v; i++; break;
      case "--judge-model": judgeModel = v; i++; break;
      case "--out": out = v; i++; break;
      case "--json": json = v; i++; break;
      case "--concurrency": concurrency = Math.max(1, Number(v)); i++; break;
      case "--run": {
        const eq = v?.indexOf("=") ?? -1;
        if (eq <= 0) throw new Error("Pass --run <label>=<baselines dir>, for example --run valet=/tmp/baselines.");
        runs.push({ label: v.slice(0, eq), dir: resolve(v.slice(eq + 1)) });
        i++;
        break;
      }
      default:
        throw new Error(`Unknown argument ${argv[i]}. See the usage at the top of review-matrix-cli.ts.`);
    }
  }
  if (cases === undefined) throw new Error("Pass --cases <dir>, the suite's case directory.");
  if (runs.length === 0) throw new Error("Pass at least one --run <label>=<baselines dir>.");
  const priv = resolvePrivateCases(cases);
  if (priv !== undefined && "skip" in priv) {
    process.stdout.write(`SKIP ${priv.skip}\n`);
    process.exit(0);
  }
  return { cases: priv !== undefined ? priv.dir : resolve(cases), runs, model, judgeModel, ...(out ? { out } : {}), ...(json ? { json } : {}), concurrency };
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const gateway = llmGatewayFromEnv();
  if (gateway === undefined) throw new Error("The matrix judge runs on a Valet key. Set VALET_LLM_GATEWAY_URL and VALET_API_KEY (or VALET_API_KEY_FILE).");
  const judge = resolveModelId(args.judgeModel);
  if (!judge) throw new Error(`Unknown judge model ${args.judgeModel}. Pass --judge-model as provider/model, e.g. ${DEFAULT_REVIEW_JUDGE_MODEL}.`);
  const llm = modelLlm(viaGateway(judge, gateway), gateway.apiKey);

  const cases = (await loadCases(args.cases)).filter((c) => c.pull_request !== undefined);
  const matrices: CaseMatrix[] = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, cases.length) }, async () => {
      while (next < cases.length) {
        const i = next++;
        const c = cases[i];
        const runs: RunReview[] = [];
        for (const r of args.runs) {
          const record = await loadLatestBaseline(r.dir, c.id, c.model ?? args.model);
          const findings = record ? runFindings(record.trajectory) : undefined;
          if (findings === undefined) process.stderr.write(`${c.id}: no review recorded in ${r.dir}; the ${r.label} column is empty for it\n`);
          runs.push({ label: r.label, findings: findings ?? [] });
        }
        matrices[i] = await buildCaseMatrix(llm, c, runs, await loadReferenceSidecar(args.cases, c.id));
        process.stderr.write(`[matrix] ${c.id}: ${matrices[i].rows.length} issues\n`);
      }
    }),
  );
  const markdown = renderMatrixMarkdown(matrices, args.runs.map((r) => r.label));
  if (args.out) await writeFile(args.out, `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
  if (args.json) await writeFile(args.json, `${JSON.stringify(matrices, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
