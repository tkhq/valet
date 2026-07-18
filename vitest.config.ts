import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `packages/worker` is the FROZEN legacy Cloudflare worker (excluded from
    // root typecheck; its generated `channels/packages.ts` / `integrations/
    // packages.ts` registries were retired when plugin registry generation
    // moved to `packages/api`). Its test files import those now-absent
    // generated modules and fail to load, so it is not part of the dev-v2
    // stack's test run. Run its suite directly (`cd packages/worker && pnpm
    // test`) if you ever need it.
    projects: [
      'packages/shared',
      'packages/sdk',
      'packages/api',
      'packages/web',
    ],
  },
});
