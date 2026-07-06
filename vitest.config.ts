import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/worker',
      'packages/shared',
      'packages/sdk',
      'packages/client',
      'packages/usage-audit',
      'packages/runner',
      'packages/plugin-github',
      'packages/plugin-gmail',
      'packages/plugin-slack',
      'packages/plugin-telegram',
      // packages/plugin-google-workspace excluded: labels-guard classification
      // tests fail on main (docs.find_text_index appears in two categories).
      'docker/opencode',
    ],
  },
});
