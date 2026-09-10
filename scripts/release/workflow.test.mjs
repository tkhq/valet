import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.release.steps;

test('retries release creation with the same tag after the tag push succeeds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'valet-release-'));
  try {
    const repo = join(directory, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('commit', '--allow-empty', '-m', 'initial');
    git('tag', 'valet/v0.3.5');
    git('tag', 'chart/valet-v9.0.0');
    execFileSync('git', ['init', '--bare', '-q', join(directory, 'remote')]);
    git('remote', 'add', 'origin', join(directory, 'remote'));
    mkdirSync(join(repo, 'scripts/release'), { recursive: true });
    copyFileSync(new URL('./version.mjs', import.meta.url), join(repo, 'scripts/release/version.mjs'));
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
if [[ "$2" == view ]]; then test -f "$RELEASE_STATE"; exit $?; fi
if [[ "$FAIL_CREATE" == 1 ]]; then exit 1; fi
printf '%s\\n' "$@" > "$RELEASE_STATE"
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_RUN_ID: '42', BUMP: 'minor', RUNNER_TEMP: directory,
      GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      RELEASE_STATE: join(directory, 'release'), FAIL_CREATE: '1' };
    const run = (name) => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', steps.find(step => step.name === name).run],
      { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    run('Compute application version');
    env.TAG = readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('=')[1];
    assert.equal(env.TAG, 'valet/v0.4.0');
    assert.throws(() => run('Create tag and application release'));
    assert.equal(git('rev-parse', 'valet/v0.4.0^{commit}'), git('rev-parse', 'HEAD'));
    git('tag', 'valet/v0.5.0');
    writeFileSync(env.GITHUB_OUTPUT, '');
    run('Compute application version');
    assert.equal(readFileSync(env.GITHUB_OUTPUT, 'utf8').trim(), 'tag=valet/v0.4.0');
    env.FAIL_CREATE = '0';
    run('Create tag and application release');
    assert.match(readFileSync(env.RELEASE_STATE, 'utf8'), /--notes-start-tag\nvalet\/v0.3.5/);
    run('Create tag and application release');
    assert.equal(git('tag', '--list', 'valet/v0.4.*'), 'valet/v0.4.0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
