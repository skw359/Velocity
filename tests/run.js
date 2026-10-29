// Runs tests/*.test.js with Node's built-in runner (each file in its own process).
// The files are listed explicitly rather than left to `node --test` discovery, which would
// also pick up any *.test.js stored under content/ by a user of this checkout.
//   node tests/run.js            all tests
//   node tests/run.js upload     only files whose name contains "upload"

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(__dirname, f));
const filters = process.argv.slice(2);
const selected = filters.length ? files.filter((f) => filters.some((x) => path.basename(f).includes(x))) : files;

if (selected.length === 0) {
  console.error(`No test files match: ${filters.join(', ')}`);
  process.exit(1);
}

// A hung test fails instead of stalling CI (--test-timeout needs Node 20.11+).
const [major, minor] = process.versions.node.split('.').map(Number);
const timeout = major > 20 || (major === 20 && minor >= 11) ? ['--test-timeout=120000'] : [];

const result = spawnSync(process.execPath, ['--test', ...timeout, ...selected], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
