# Shared model catalog implementation plan

**Goal:** Revise PR #578 around the model support already merged in #583.

**Architecture:** The engine owns one portable bundled model catalog. API registry,
engine resolution, evals, workflow validation and execution, and proxy pricing
read that catalog. The API retains its runtime registry overlay. Keep `shared`
dependency-free. Move the existing Astra record without changing its metadata.

**Tech stack:** TypeScript, pi-ai 0.85.0, pnpm, Vitest.

- [x] Add regression coverage for Astra resolution, workflow acceptance, and pricing.
- [x] Confirm the regressions fail against current `dev-v2`.
- [x] Move the existing manual record into `engine/model-catalog`.
- [x] Route bundled catalog consumers through that module. Preserve upstream precedence.
- [x] Remove the obsolete eval fallback. Keep dependency versions unchanged.
- [x] Update provider and eval specs. Retain the upstream-removal canary.
- [x] Run focused tests, typecheck, full `make e2e`, and independent review.

Validation: root typecheck, unit sweep, focused catalog suites, and both reviews
passed. The full e2e run had three failures. The unit mock was corrected;
unit/typecheck, Docker workspace preparation, and the Kubernetes Secret
propagation test passed on rerun. Four optional live suites were skipped.
