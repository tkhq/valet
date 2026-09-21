import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const ci = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'));
const docker = parseDocument(readFileSync('.github/workflows/docker-publish.yml', 'utf8'));

describe('Artifact publish gate', () => {
  it('has no direct publishing trigger that bypasses CI', () => {
    expect(docker.hasIn(['on', 'workflow_call'])).toBe(true);
    expect(docker.hasIn(['on', 'push'])).toBe(false);
    expect(docker.hasIn(['on', 'workflow_dispatch'])).toBe(false);
    expect(ci.hasIn(['on', 'workflow_dispatch'])).toBe(true);
    expect(ci.getIn(['on', 'push', 'tags', 0])).toBe('v*');
    expect(ci.getIn(['on', 'push', 'tags', 1])).toBe('valet/v*');
    const release = parseDocument(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(release.getIn(['jobs', 'docker', 'uses'])).toBe('./.github/workflows/docker-publish.yml');
  });

  it('requires the aggregate CI result before calling the publisher', () => {
    expect(ci.getIn(['jobs', 'publish', 'needs'])).toBe('ci');
    expect(ci.getIn(['jobs', 'publish', 'uses'])).toBe('./.github/workflows/docker-publish.yml');
    // No always() override: GitHub must skip publishing on failure or cancellation.
    expect(ci.getIn(['jobs', 'publish', 'if'])).toBe(
      "github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && (github.ref == 'refs/heads/dev-v2' || startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref, 'refs/tags/valet/v')))"
    );
    const checks = parseDocument(readFileSync('.github/workflows/ci-checks.yml', 'utf8'));
    expect(ci.getIn(['jobs', 'checks', 'uses'])).toBe('./.github/workflows/ci-checks.yml');
    expect(ci.getIn(['jobs', 'ci', 'needs'])).toBe('checks');
    expect(ci.getIn(['jobs', 'ci', 'steps', 0, 'run'])).toContain('test "${{ needs.checks.result }}" = "success"');
    for (const job of ['typecheck', 'test', 'cgroup_test', 'docs-lint']) {
      expect(checks.getIn(['jobs', 'ci', 'steps', 0, 'run'])).toContain(`test "\${{ needs.${job}.result }}" = "success"`);
    }
  });

  it('grants GHCR permissions to the reusable workflow', () => {
    expect(ci.getIn(['jobs', 'publish', 'permissions', 'contents'])).toBe('read');
    expect(ci.getIn(['jobs', 'publish', 'permissions', 'packages'])).toBe('write');
    expect(ci.getIn(['jobs', 'publish', 'secrets'])).toBe('inherit');
  });

  it('joins all image and architecture builds before tagging', () => {
    expect(docker.getIn(['jobs', 'merge', 'needs'])).toBe('build');
    expect(docker.hasIn(['jobs', 'merge', 'if'])).toBe(false);
    for (const [index, name] of ['valet-api', 'valet-sandbox'].entries()) {
      expect(docker.getIn(['jobs', 'build', 'strategy', 'matrix', 'image', index, 'name'])).toBe(name);
    }
    for (const [index, arch] of ['amd64', 'arm64'].entries()) {
      expect(docker.getIn(['jobs', 'build', 'strategy', 'matrix', 'platform', index, 'arch'])).toBe(arch);
    }
    expect(docker.toString()).toContain('type=sha,prefix=sha-');
    expect(docker.getIn(['jobs', 'merge', 'steps', 4, 'with', 'flavor'])).toBe('latest=false');
    expect(docker.toString()).not.toContain('type=ref,event=tag');
    expect(docker.toString()).not.toContain('workflow_run');
    expect(docker.toString()).not.toContain('DOCKER_METADATA_PR_HEAD_SHA');
    expect(docker.getIn(['jobs', 'build', 'steps', 0, 'with', 'ref'])).toBe('${{ inputs.release_tag || github.sha }}');
    expect(docker.getIn(['jobs', 'build', 'steps', 1, 'run'])).toBe('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  });
});


describe('All release paths require CI', () => {
  const cli = parseDocument(readFileSync('.github/workflows/release-cli.yml', 'utf8'));
  const chart = parseDocument(readFileSync('.github/workflows/release-chart.yml', 'utf8'));
  const release = parseDocument(readFileSync('.github/workflows/release.yml', 'utf8'));

  it('gates rolling and versioned CLI releases behind CI', () => {
    expect(cli.hasIn(['on', 'push'])).toBe(false);
    expect(cli.hasIn(['on', 'workflow_dispatch'])).toBe(false);
    expect(ci.getIn(['jobs', 'publish-cli', 'uses'])).toBe('./.github/workflows/release-cli.yml');
    expect(ci.getIn(['jobs', 'publish-cli', 'needs'])).toBe('ci');
    expect(ci.getIn(['jobs', 'publish-cli', 'if'])).toBe(ci.getIn(['jobs', 'publish', 'if']));
    expect(ci.getIn(['jobs', 'publish-cli', 'permissions', 'contents'])).toBe('write');
    expect(cli.getIn(['jobs', 'publish', 'needs'])).toBe('binaries');
    expect(cli.hasIn(['jobs', 'publish', 'if'])).toBe(false);
    const builds = cli.getIn(['jobs', 'binaries']);
    expect(String(builds)).not.toContain('gh release upload');
    expect(String(builds)).not.toContain('softprops/action-gh-release');
    expect(cli.getIn(['jobs', 'binaries', 'steps', 1, 'run'])).toBe('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  });

  it('requires shared checks before creating an application release or tag', () => {
    expect(release.getIn(['jobs', 'checks', 'uses'])).toBe('./.github/workflows/ci-checks.yml');
    expect(release.getIn(['jobs', 'release', 'needs'])).toBe('checks');
    expect(release.hasIn(['jobs', 'release', 'if'])).toBe(false);
    for (const publisher of ['cli', 'docker']) {
      expect(release.getIn(['jobs', publisher, 'needs'])).toBe('release');
      expect(release.hasIn(['jobs', publisher, 'if'])).toBe(false);
    }
  });

  it('requires shared checks and chart validation before publishing an OCI chart', () => {
    expect(chart.getIn(['jobs', 'checks', 'uses'])).toBe('./.github/workflows/ci-checks.yml');
    expect(chart.getIn(['jobs', 'release', 'needs', 0])).toBe('validate');
    expect(chart.getIn(['jobs', 'release', 'needs', 1])).toBe('checks');
    expect(chart.getIn(['jobs', 'release', 'if'])).toBe("${{ github.event_name != 'pull_request' }}");
    expect(chart.hasIn(['on', 'workflow_dispatch', 'inputs', 'force'])).toBe(true);
    for (const event of ['push', 'pull_request']) {
      expect(chart.getIn(['on', event, 'paths', 0])).toBe('deploy/chart/valet/**');
      expect(chart.getIn(['on', event, 'paths', 1])).toBeUndefined();
    }
    // Force changes the collision check only; it cannot bypass the CI dependency.
    expect(chart.getIn(['jobs', 'checks', 'if'])).toBe("github.event_name != 'pull_request'");
  });
});
