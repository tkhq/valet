import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "packages/api/src/authorization/evaluators/wasm");
const bytes = readFileSync(resolve(out, "valet_policy_engine_wasm_bg.wasm"));
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
if (
  imports.length !== 1 ||
  imports[0].kind !== "function" ||
  imports[0].module !== "./valet_policy_engine_wasm_bg.js" ||
  imports[0].name !== "__wbindgen_init_externref_table"
) {
  throw new Error(`Unexpected policy WASM imports: ${JSON.stringify(imports)}`);
}
const instance = new WebAssembly.Instance(module, {
  "./valet_policy_engine_wasm_bg.js": { __wbindgen_init_externref_table() {} },
});
const memory = instance.exports.memory;
if (!(memory instanceof WebAssembly.Memory) || memory.buffer instanceof SharedArrayBuffer) {
  throw new Error("Policy WASM must define and export unshared linear memory.");
}
const initialPages = memory.buffer.byteLength / 65_536;
memory.grow(1_024 - initialPages);
try {
  memory.grow(1);
  throw new Error("Policy WASM memory maximum exceeds 1,024 pages.");
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
}
const require = createRequire(import.meta.url);
const engine = require(resolve(out, "valet_policy_engine_wasm.cjs"));
const identity = JSON.parse(engine.run(JSON.stringify({ operation: "identity" })));
if (
  identity.status !== "ok" ||
  identity.value.interpreterRevision !== "309ba35067d2118aafd696198a33037f5af9e1bd" ||
  identity.value.capabilityProfileVersion !== 1 ||
  identity.value.maxEngineMemoryBytes !== 67_108_864
) {
  throw new Error("Policy WASM identity does not match the pinned engine profile.");
}
console.log(`Verified policy WASM: ${initialPages} initial pages, 1,024 maximum pages, unshared memory.`);
