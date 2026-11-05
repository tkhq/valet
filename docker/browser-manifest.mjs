import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire('/opt/valet/browser/package.json');
const { chromium } = require('playwright-core');
const Database = require('better-sqlite3');
const database = new Database(':memory:');
const sqlite = database.prepare('select sqlite_version() as version').get();
database.close();
const executable = chromium.executablePath();
const browsers = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
const manifest = {
  schemaVersion: 1,
  protocolVersion: '1.0',
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  baseImage: 'node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c',
  playwright: require('playwright-core/package.json').version,
  chromium: {
    revision: browsers.browsers.find(browser => browser.name === 'chromium').revision,
    version: execFileSync(executable, ['--version'], {encoding:'utf8'}).trim(),
    executable,
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  },
  betterSqlite3: require('better-sqlite3/package.json').version,
  sqlite: sqlite.version,
  bubblewrap: execFileSync('/usr/bin/bwrap', ['--version'], {encoding:'utf8'}).trim(),
  seccompSha256: createHash('sha256').update(readFileSync('/opt/valet/browser/config/container-seccomp.json')).digest('hex'),
};
writeFileSync('/opt/valet/browser/runtime-manifest.json', JSON.stringify(manifest, null, 2)+'\n');
writeFileSync('/opt/valet/browser/os-packages.txt', execFileSync('dpkg-query', ['-W','-f=${Package}\t${Version}\t${Architecture}\n']));
