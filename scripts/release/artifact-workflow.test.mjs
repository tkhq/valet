import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const workflow = name => YAML.parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const docker = workflow('docker-publish');
const cli = workflow('release-cli');
const imageStep = docker.jobs.merge.steps.find(step => step.id === 'img');

for (const [ref, version, latest] of [
  ['refs/heads/dev-v2', 'dev-v2', false],
  ['refs/heads/v1.2.3', 'v1.2.3', false],
  ['refs/tags/v1.2.3', 'v1.2.3', true],
  ['refs/tags/valet/v1.2.3', 'v1.2.3', true],
  ['refs/tags/v1.2.3-rc.1', 'v1.2.3-rc.1', false],
  ['refs/tags/valet/v1.2.3-rc.1', 'v1.2.3-rc.1', false],
  ['refs/tags/vnext', 'vnext', false],
  ['refs/tags/valet/vnext', 'vnext', false],
  ['refs/tags/v01.2.3', 'v01.2.3', false],
  ['refs/tags/v1.2', 'v1.2', false],
]) {
  test(`Docker version and latest for ${ref}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'valet-image-tags-'));
    try {
      const output = join(directory, 'output');
      // Supply matrix and owner values; tag computation also runs on macOS Bash 3.
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', imageStep.run.replaceAll('${{ matrix.image }}', 'valet-api').replaceAll('${OWNER,,}', 'tkhq')], {
        env: { ...process.env, OWNER: 'tkhq', BUILD_REF: ref, BUILD_TAG: ref.replace(/^refs\/(heads|tags)\//, ''), GITHUB_OUTPUT: output },
      });
      const result = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
      assert.equal(result.version, version);
      assert.equal(result.latest, String(latest));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Docker metadata consumes the computed version and stable-release decision', () => {
  const meta = docker.jobs.merge.steps.find(step => step.id === 'meta').with;
  assert.equal(meta.flavor, 'latest=false');
  assert.match(meta.tags, /type=raw,value=\$\{\{ steps.img.outputs.version \}\}/);
  assert.match(meta.tags, /type=raw,value=latest,enable=\$\{\{ steps.img.outputs.latest == 'true' \}\}/);
  // GitHub startsWith is a prefix match, so refs/tags/v includes refs/tags/valet/v.
  assert.match(meta.tags, /startsWith\(env.BUILD_REF, 'refs\/tags\/v'\)/);
  assert.equal('refs/tags/valet/v1.2.3'.startsWith('refs/tags/v'), true);
});

for (const [name, job] of [['Docker', docker.jobs.build], ['CLI', cli.jobs.binaries]]) {
  const step = job.steps.find(step => step.name === 'Generate changelog artifact');
  test(`${name} generates metadata for all build refs`, () => {
    assert.equal(step.if, name === 'Docker' ? "matrix.image.name == 'valet-api'" : undefined);
  });
  for (const tag of ['v1.2.3', 'valet/v1.2.3', 'v1.2.3-rc.1', 'valet/v1.2.3-rc.1']) {
    test(`${name} embeds version and source SHA for ${tag}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'valet-release-metadata-'));
      try {
        const metadata = join(directory, 'release.json');
        const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
        git('init', '-q');
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'chore: release fixture');
        git('tag', tag);
        // Run the real generator while redirecting its two output files to the fixture.
        writeFileSync(join(directory, 'node'), `#!${process.execPath}\n` + `
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
args[0] = process.env.TEST_GENERATOR;
args[args.indexOf('--metadata') + 1] = process.env.TEST_METADATA;
args.push('--manifest', process.env.TEST_MANIFEST);
execFileSync(process.execPath, args, { stdio: 'pipe' });
`, { mode: 0o755 });
        execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
          cwd: directory,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUILD_REF: `refs/tags/${tag}`, BUILD_TAG: tag,
            TEST_GENERATOR: fileURLToPath(new URL('../../packages/api/scripts/generate-changelog.mjs', import.meta.url)), TEST_METADATA: metadata, TEST_MANIFEST: join(directory, 'manifest.json'), GITHUB_REPOSITORY: 'tkhq/valet', GITHUB_RUN_ID: '1' },
          stdio: 'pipe',
        });
        assert.deepEqual(JSON.parse(readFileSync(metadata, 'utf8')), {
          version: tag.replace(/^(valet\/)?v/, ''),
          sha: git('rev-parse', 'HEAD'),
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
