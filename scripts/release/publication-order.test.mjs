import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

const workflow = name => YAML.parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const ci = workflow('ci');
const docker = workflow('docker-publish');
const cli = workflow('release-cli');
const oldSha = 'a'.repeat(40);
const tipSha = 'b'.repeat(40);
const context = (sha, ref = 'refs/heads/dev-v2', releaseTag = '') => ({
  github: { sha, ref, run_id: sha, event_name: 'push', event: {} },
  inputs: { release_tag: releaseTag },
  steps: {},
});

// Evaluate the trusted workflow expressions, including their surrounding group names.
function evaluate(source, { github, inputs, steps }) {
  const expression = value => Function('github', 'inputs', 'steps', 'format', 'startsWith', `return (${value});`)(
    github, inputs, steps,
    (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]),
    (value, prefix) => value.startsWith(prefix),
  );
  if (typeof source !== 'string') return source;
  const whole = source.match(/^\$\{\{ (.*?) \}\}$/);
  if (whole) return expression(whole[1]);
  return source.replace(/\$\{\{ (.*?) \}\}/g, (_, value) => expression(value));
}

for (const [name, publisher] of [['Docker', docker], ['CLI', cli]]) {
  test(`${name} publishers from different commits cannot cancel each other in either arrival order`, () => {
    for (const order of [[oldSha, tipSha], [tipSha, oldSha]]) {
      const active = new Map();
      for (const sha of order) {
        const event = context(sha);
        const group = evaluate(publisher.concurrency.group, event);
        if (evaluate(publisher.concurrency['cancel-in-progress'], event)) active.delete(group);
        active.set(group, sha);
      }
      assert.deepEqual([...active.values()].sort(), [oldSha, tipSha]);
    }
  });

  test(`${name} keeps version tags serialized without cancellation`, () => {
    for (const tag of ['v1.2.3', 'valet/v1.2.3', 'valet/v1.2.3-rc.1']) {
      const direct = context(oldSha, `refs/tags/${tag}`);
      const reusable = context(oldSha, 'refs/heads/dev-v2', tag);
      const group = evaluate(publisher.concurrency.group, direct);
      assert.equal(group, evaluate(publisher.concurrency.group, reusable));
      assert.equal(group, evaluate(publisher.concurrency.group, context(tipSha, `refs/tags/${tag}`)));
      assert.equal(evaluate(publisher.concurrency['cancel-in-progress'], direct), false);
      assert.equal(evaluate(publisher.concurrency['cancel-in-progress'], reusable), false);
    }
  });
}

test('CI still gates both publishers and cancels only superseded PR validation', () => {
  for (const name of ['publish', 'publish-cli']) {
    assert.equal(ci.jobs[name].needs, 'ci');
    assert.doesNotMatch(ci.jobs[name].if, /always\(|failure\(|cancelled\(/);
  }
  assert.equal(evaluate(ci.concurrency['cancel-in-progress'], context(oldSha)), false);
  const pr = context(oldSha);
  pr.github.event_name = 'pull_request';
  pr.github.event.pull_request = { number: 42 };
  assert.equal(evaluate(ci.concurrency['cancel-in-progress'], pr), true);
  assert.equal(evaluate(ci.concurrency.group, pr), evaluate(ci.concurrency.group, { ...pr, github: { ...pr.github, sha: tipSha, run_id: tipSha } }));
});

test('CLI publish jobs serialize uploads without replacing pending publishers', () => {
  const { concurrency } = cli.jobs.publish;
  assert.ok(concurrency, 'the head check and upload must share one serialized job');
  assert.equal(concurrency['cancel-in-progress'], false);
  assert.equal(concurrency.queue, 'max');
  assert.equal(evaluate(concurrency.group, context(oldSha)), evaluate(concurrency.group, context(tipSha)));
  assert.notEqual(evaluate(concurrency.group, context(oldSha)), evaluate(cli.concurrency.group, context(oldSha)));
  assert.notEqual(evaluate(concurrency.group, context(oldSha)), evaluate(concurrency.group, context(oldSha, 'refs/tags/v1.2.3')));
});

const rollingIndex = cli.jobs.publish.steps.findIndex(step => step.name === 'Publish rolling dev-v2 prerelease');
const rolling = cli.jobs.publish.steps[rollingIndex];
const fence = cli.jobs.publish.steps[rollingIndex - 1];

function checkHead(sha, head, failed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'valet-publication-order-'));
  try {
    // Reject any endpoint other than the current remote branch ref.
    writeFileSync(join(directory, 'gh'), `#!/bin/bash
set -euo pipefail
[[ "$*" == 'api repos/test/valet/git/ref/heads/dev-v2 --jq .object.sha' ]]
if [[ "$TEST_API_FAILURE" == 1 ]]; then exit 1; fi
printf '%s\\n' "$TEST_REMOTE_HEAD"
`, { mode: 0o755 });
    const output = join(directory, 'output');
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', fence.run], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_REPOSITORY: 'test/valet',
        GITHUB_SHA: sha, GITHUB_OUTPUT: output, TEST_REMOTE_HEAD: head, TEST_API_FAILURE: failed ? '1' : '0' },
      stdio: 'pipe',
    });
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split('=')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('only the current remote dev-v2 tip can replace rolling assets in either completion order', () => {
  assert.equal(fence.id, 'rolling');
  assert.equal(rolling.uses, 'softprops/action-gh-release@v2');
  assert.equal(rolling.with.tag_name, 'dev-v2-latest');
  for (const order of [[oldSha, tipSha], [tipSha, oldSha]]) {
    const published = [];
    for (const sha of order) {
      const event = context(sha);
      event.steps.rolling = { outputs: checkHead(sha, tipSha) };
      if (evaluate(rolling.if, event)) published.push(sha);
    }
    assert.deepEqual(published, [tipSha]);
  }
  // The remote may advance while this job waits; the check must use its new head.
  assert.equal(checkHead(oldSha, oldSha).current, 'true');
  assert.equal(checkHead(oldSha, tipSha).current, 'false');
});

test('rolling publication fails closed when the remote head cannot be read', () => {
  assert.throws(() => checkHead(tipSha, tipSha, true));
  assert.equal(checkHead(tipSha, '').current, 'false');
});

test('tag and other-branch builds cannot enter the rolling head check or upload', () => {
  for (const event of [context(tipSha, 'refs/tags/v1.2.3'), context(tipSha, 'refs/heads/dev-v2', 'valet/v1.2.3'), context(tipSha, 'refs/heads/main')]) {
    assert.equal(evaluate(fence.if, event), false);
    event.steps.rolling = { outputs: { current: 'true' } };
    assert.equal(evaluate(rolling.if, event), false);
  }
});
