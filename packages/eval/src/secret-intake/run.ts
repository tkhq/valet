/**
 * Runs the secret-intake detection eval and prints a scorecard.
 *
 *   pnpm --filter @valet/eval secret-intake            # rule-based detectors
 *   pnpm --filter @valet/eval secret-intake --model    # also stage 2 (needs a model key)
 *   pnpm --filter @valet/eval secret-intake --held-out # providers and templates not used while tuning
 *   pnpm --filter @valet/eval secret-intake --json out.json
 *
 * Stage 2 uses the Valet gateway when VALET_LLM_GATEWAY_URL and a vlt_
 * VALET_API_KEY are set, else ANTHROPIC_API_KEY. SECRET_INTAKE_MODEL picks
 * the model.
 */
import { writeFileSync } from "node:fs";
import { buildDataset, buildHeldOutDataset, type LabeledMessage } from "./dataset.js";
import { backstopToday, composerToday, modelEndpointFromEnv, stage1, stage2, type Detector } from "./detectors.js";
import { recallByCategory, score, type Score, type Span } from "./metrics.js";

async function runDetector(messages: LabeledMessage[], detect: Detector, concurrency = 8): Promise<Map<string, Span[]>> {
  const out = new Map<string, Span[]>();
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < messages.length) {
      const m = messages[next++]!;
      out.set(m.id, await detect(m));
    }
  });
  await Promise.all(workers);
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useModel = args.includes("--model");
  const jsonPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
  const messages = args.includes("--held-out") ? buildHeldOutDataset() : buildDataset();
  const detectors: [string, Detector][] = [
    ["backstop today (known)", backstopToday],
    ["composer today (known+assigned)", composerToday],
    ["stage 1 score>=0.3", stage1(0.3)],
    ["stage 1 score>=0.5", stage1(0.5)],
    ["stage 1 score>=0.6", stage1(0.6)],
  ];
  if (useModel) {
    const endpoint = modelEndpointFromEnv();
    if (!endpoint) throw new Error("--model needs VALET_LLM_GATEWAY_URL + VALET_API_KEY (vlt_) or ANTHROPIC_API_KEY.");
    detectors.push([`stage 1+2 (${endpoint.model})`, stage2(endpoint)]);
    detectors.push([`stage 1>=0.5 + model adds`, stage2(endpoint, 0.2, 0.5)]);
  }

  const pos = messages.filter((m) => m.secrets.length > 0).length;
  console.log(`secret-intake eval: ${messages.length} messages (${pos} with keys, ${messages.length - pos} without)\n`);
  console.log("detector                               recall   false-alarm  span-precision");
  const report: Record<string, { score: Score; byCategory: Record<string, number> }> = {};
  for (const [name, detect] of detectors) {
    const results = await runDetector(messages, detect, name.includes("model") || name.startsWith("stage 1+2") ? 4 : 32);
    const s = score(messages, results);
    report[name] = { score: s, byCategory: Object.fromEntries(recallByCategory(messages, results)) };
    console.log(`${name.padEnd(38)} ${pct(s.recall).padStart(6)}   ${pct(s.falseAlarmRate).padStart(9)}   ${pct(s.spanPrecision).padStart(12)}`);
  }

  for (const [name, r] of Object.entries(report)) {
    if (!name.startsWith("stage")) continue;
    const weak = Object.entries(r.byCategory).filter(([, v]) => v < 1).map(([k, v]) => `${k} ${pct(v)}`);
    console.log(`\n${name}`);
    console.log(`  categories below 100% recall: ${weak.length ? weak.join(", ") : "none"}`);
    console.log(`  misses: ${r.score.misses.slice(0, 12).join(", ") || "none"}`);
    console.log(`  false alarms: ${r.score.falseAlarms.slice(0, 12).join(", ") || "none"}`);
  }
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
