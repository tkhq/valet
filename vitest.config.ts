import { defineConfig } from 'vitest/config';
import { apiProjects } from './packages/api/vitest.config';
import { TESTED_PLUGINS } from './scripts/e2e/lib';

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
      ...apiProjects,
      'packages/workflow',
      ...TESTED_PLUGINS.map((name) => `packages/${name.replace('@valet/', '')}`),
      {
        test: {
          name: '@valet/sandbox-docker:unit',
          include: [
            'packages/sandbox-docker/test/run-args.test.ts',
            'packages/sandbox-docker/test/browser-companion.test.ts',
            'packages/sandbox-docker/test/browser-companion-lifecycle.test.ts',
          ],
          testTimeout: 60_000,
        },
      },
      'packages/engine',
      'packages/web',
      // The `make e2e` runner's pure library (step table, scorecard).
      {
        test: {
          name: 'scripts',
          include: ['scripts/e2e/*.test.ts'],
        },
      },
    ],
  },
});
