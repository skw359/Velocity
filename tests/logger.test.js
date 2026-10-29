// Log files live in the data directory and roll over at a size limit (review finding L2).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, cleanup } = require('./support/harness');

const dataDir = isolate({ VELOCITY_LOG_LEVEL: 'info', VELOCITY_LOG_MAX_SIZE_MB: '1', VELOCITY_LOG_MAX_FILES: '2' });
after(() => cleanup(dataDir));

const logger = require('../logger');
for (const t of logger.transports) if (t.name === 'console') t.silent = true;
const logDir = path.join(dataDir, 'logs');

test('every file transport has a size limit and a file count', () => {
  const files = logger.transports.filter((t) => t.name === 'file');
  assert.strictEqual(files.length, 2);
  for (const t of files) {
    assert.strictEqual(t.maxsize, 1024 * 1024);
    assert.strictEqual(t.maxFiles, 2);
    assert.strictEqual(t.tailable, true);
    assert.strictEqual(path.dirname(t.filename ? path.join(t.dirname, t.filename) : ''), logDir);
  }
});

test('writing past the limit rolls the log over and keeps only the newest files', async () => {
  const line = `[Test] ${'x'.repeat(500)}`;
  for (let i = 0; i < 9000; i++) logger.info(`${line} ${i}`); // ~4.5 MB through a 1 MB limit
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const names = fs.readdirSync(logDir).filter((n) => n.startsWith('combined'));
    if (names.includes('combined1.log')) break;
  }
  await new Promise((r) => setTimeout(r, 500));
  const names = fs.readdirSync(logDir).filter((n) => n.startsWith('combined')).sort();
  assert.ok(names.includes('combined.log') && names.includes('combined1.log'), names.join(','));
  assert.ok(names.length <= 2, `only maxFiles files remain: ${names.join(',')}`);
  for (const n of names) assert.ok(fs.statSync(path.join(logDir, n)).size <= 1.1 * 1024 * 1024, `${n} stays near the limit`);
  // tailable: the newest lines are in the unnumbered file.
  assert.match(fs.readFileSync(path.join(logDir, 'combined.log'), 'utf8'), /x 8999/);
});
