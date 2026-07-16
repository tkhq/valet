/**
 * Systematic guard against ambient provider env vars (e.g. a real
 * `OPENAI_API_KEY` in the dev shell) leaking into catalog synthesis during
 * tests. Deletes the known provider-key env vars before every test in this
 * project so a test only sees a key when it explicitly `vi.stubEnv`s it —
 * replacing the previous fragile per-test `vi.stubEnv("...", "")` pattern
 * (see `services/model-catalog.ts`'s zero-config env fallback).
 *
 * Only wired into vitest.config.ts's "unit" project — the "integration"
 * project (`src/integration/**`) is deliberately excluded because several
 * of those suites are key-gated (`describeIfKey = process.env.ANTHROPIC_API_KEY
 * ? describe : describe.skip`, see e.g. `src/integration/orchestrator.test.ts`)
 * and need the real ambient `ANTHROPIC_API_KEY` both to decide whether to
 * run and to drive live Anthropic calls.
 */
import { beforeEach } from "vitest";

const SCRUBBED_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;

beforeEach(() => {
  for (const key of SCRUBBED_ENV_VARS) delete process.env[key];
});
