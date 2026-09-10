import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function stableVersions(tags) {
  return tags.filter((tag) => /^valet\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    .map((tag) => tag.slice("valet/v".length).split('.').map(BigInt)).sort(compare);
}

export function nextVersion(tags, bump) {
  const index = ['major', 'minor', 'patch'].indexOf(bump);
  if (index < 0) throw new Error('Choose major, minor, or patch.');
  const latest = stableVersions(tags).at(-1) ?? [0n, 0n, 0n];
  latest[index] += 1n;
  for (let i = index + 1; i < 3; i++) latest[i] = 0n;
  return `valet/v${latest.join('.')}`;
}

export function previousVersion(tags, tag) {
  const target = stableVersions([tag])[0];
  if (!target) throw new Error('Use a stable valet/vX.Y.Z application tag.');
  const previous = stableVersions(tags).filter((version) => compare(version, target) < 0).at(-1);
  return previous ? `valet/v${previous.join('.')}` : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n');
  console.log(process.argv[2] === '--previous'
    ? previousVersion(tags, process.argv[3])
    : nextVersion(tags, process.argv[2]));
}
