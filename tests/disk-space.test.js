// disk-space.js reports a volume's space without a native addon.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, cleanup } = require('./support/harness');

const dataDir = isolate();
after(() => cleanup(dataDir));
const disk = require('../disk-space');

test('reports plausible totals for a folder and for a file on the same volume', async () => {
  const forDir = await disk.check(dataDir);
  for (const key of ['available', 'free', 'total']) {
    assert.ok(Number.isSafeInteger(forDir[key]) && forDir[key] >= 0, `${key}: ${forDir[key]}`);
  }
  assert.ok(forDir.total > 0);
  assert.ok(forDir.free <= forDir.total && forDir.available <= forDir.free);

  const file = path.join(dataDir, 'probe.txt');
  fs.writeFileSync(file, 'x');
  assert.strictEqual((await disk.check(file)).total, forDir.total);
});

test('a path that does not exist is an error, not zeros', async () => {
  await assert.rejects(disk.check(path.join(dataDir, 'no', 'such', 'place')), { code: 'ENOENT' });
});
