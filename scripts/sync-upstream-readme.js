/**
 * sync-upstream-readme.js
 * Cross-platform (macOS / Linux / Windows).
 *
 * Fetches upstream/main and overwrites README.upstream.md with the
 * upstream README.md — keeping your fork's README.md untouched.
 *
 * Usage:
 *   npm run sync-upstream-readme
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'README.upstream.md');

const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
const opts = { cwd: root, encoding: 'utf8' };

// Verify upstream remote exists
const remotes = execFileSync(GIT, ['remote'], opts).trim().split(/\r?\n/);
if (!remotes.includes('upstream')) {
  console.error('❌  No "upstream" remote found.');
  console.error('   Add it with:');
  console.error('   git remote add upstream https://github.com/baguskto/threads-mcp.git');
  process.exit(1);
}

console.log('⬇️  Fetching upstream…');
execFileSync(GIT, ['fetch', 'upstream'], { cwd: root, stdio: 'inherit' });

// Pull README.md content from upstream/main (no checkout needed)
let content;
try {
  content = execFileSync(GIT, ['show', 'upstream/main:README.md'], opts);
} catch {
  console.error('❌  Could not read README.md from upstream/main.');
  process.exit(1);
}

fs.writeFileSync(dest, content, 'utf8');
console.log('✅  README.upstream.md updated from upstream/main');
