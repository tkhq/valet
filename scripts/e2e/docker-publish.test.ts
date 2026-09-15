import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

const ci = parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'));
const docker = parseDocument(readFileSync('.github/workflows/docker-publish.yml', 'utf8'));

describe('Docker publish gate', () => {
  it('has no direct publishing trigger that bypasses CI', () => {
    expect(docker.hasIn(['on', 'workflow_call'])).toBe(true);
    expect(docker.hasIn(['on', 'push'])).toBe(false);
    expect(docker.hasIn(['on', 'workflow_dispatch'])).toBe(false);
    expect(ci.hasIn(['on', 'workflow_dispatch'])).toBe(true);
    expect(ci.getIn(['on', 'push', 'tags', 0])).toBe('v*');
    expect(ci.getIn(['on', 'push', 'tags', 1])).toBe('valet/v*');
    const release = parseDocument(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(release.getIn(['jobs', 'docker', 'uses'])).toBe('./.github/workflows/ci.yml');
    expect(ci.getIn(['jobs', 'publish', 'with', 'release_tag'])).toBe("${{ inputs.release_tag || '' }}");
  });

  it('requires the aggregate CI result before calling the publisher', () => {
    expect(ci.getIn(['jobs', 'publish', 'needs'])).toBe('ci');
    expect(ci.getIn(['jobs', 'publish', 'uses'])).toBe('./.github/workflows/docker-publish.yml');
    // No always() override: GitHub must skip publishing on failure or cancellation.
    expect(ci.getIn(['jobs', 'publish', 'if'])).toBe(
      "github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && (github.ref == 'refs/heads/dev-v2' || startsWith(github.ref, 'refs/tags/v') || startsWith(github.ref, 'refs/tags/valet/v')))"
    );
    for (const job of ['typecheck', 'test', 'cgroup_test', 'docs-lint']) {
      expect(ci.getIn(['jobs', 'ci', 'steps', 0, 'run'])).toContain(`test "\${{ needs.${job}.result }}" = "success"`);
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
    expect(docker.toString()).not.toContain('workflow_run');
    expect(docker.toString()).not.toContain('DOCKER_METADATA_PR_HEAD_SHA');
    expect(docker.getIn(['jobs', 'build', 'steps', 0, 'with', 'ref'])).toBe('${{ inputs.release_tag || github.sha }}');
    expect(docker.getIn(['jobs', 'build', 'steps', 1, 'run'])).toBe('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  });
});
