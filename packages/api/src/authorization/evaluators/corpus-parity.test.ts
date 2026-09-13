import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { testBundle } from "../test-bundle.js";
import { LocalEvaluatorError } from "./errors.js";
import { WasmPolicyRuntime } from "./wasm-runtime.js";

interface CorpusCase {
  readonly id: string;
  readonly policy: string;
  readonly input: string;
  readonly data: string;
  readonly max_work_units?: number;
  readonly expected: {
    readonly kind: "decision" | "error";
    readonly effect?: "allow" | "deny";
    readonly error?: string;
  };
}

interface CorpusManifest {
  readonly cases: readonly CorpusCase[];
}

const corpusRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../crates/valet-policy-engine/corpus",
);
const manifest: CorpusManifest = JSON.parse(readFileSync(resolve(corpusRoot, "manifest-v1.json"), "utf8"));

describe("WASM compatibility corpus parity", () => {
  const runtime = new WasmPolicyRuntime();
  afterAll(() => runtime.close());

  for (const corpusCase of manifest.cases) {
    it(corpusCase.id, async () => {
      const source = readFileSync(resolve(corpusRoot, corpusCase.policy), "utf8");
      const bundle = testBundle(source, corpusCase.data);
      try {
        const identity = await runtime.run<{ sourceBundleDigest: string }>({
          operation: "validate_bundle",
          bundle,
        });
        await runtime.loadBundle(identity.sourceBundleDigest, bundle);
        const result = await runtime.run<{ decision: { effect: string } }>({
          operation: "evaluate",
          sourceBundleDigest: identity.sourceBundleDigest,
          input: JSON.parse(corpusCase.input),
          maxWorkUnits: corpusCase.max_work_units,
          explain: "off",
        });
        expect(corpusCase.expected.kind, `${corpusCase.id} returned a decision`).toBe("decision");
        expect(result.decision.effect).toBe(corpusCase.expected.effect);
      } catch (error) {
        if (!(error instanceof LocalEvaluatorError)) throw error;
        expect(corpusCase.expected.kind, `${corpusCase.id} returned an error`).toBe("error");
        expect(error.code).toBe(corpusCase.expected.error);
      }
    });
  }
});
