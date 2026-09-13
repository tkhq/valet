#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out="$root/packages/api/src/authorization/evaluators/wasm"

rustup target add wasm32-unknown-unknown
RUSTFLAGS="-C link-arg=--max-memory=67108864" \
  cargo build --release --locked --target wasm32-unknown-unknown \
  -p valet-policy-engine-wasm
wasm-bindgen --version | grep -q '0.2.128' || {
  echo 'wasm-bindgen-cli 0.2.128 is required.' >&2
  exit 1
}
rm -rf "$out"
mkdir -p "$out"
wasm-bindgen --target nodejs --out-dir "$out" \
  "$root/target/wasm32-unknown-unknown/release/valet_policy_engine_wasm.wasm"
mv "$out/valet_policy_engine_wasm.js" "$out/valet_policy_engine_wasm.cjs"
rm "$out"/*.d.ts
node "$root/scripts/verify-policy-wasm.mjs"
