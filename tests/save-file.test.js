// Saving edited text never leaves a truncated file behind.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, cleanup, startServer, Client, signup, userRoot } = require('./support/harness');

const dataDir = isolate();
let server;
let client;
let root;

before(async () => {
  server = await startServer();
  client = new Client(server.base);
  root = userRoot(dataDir, (await signup(client, 'editor')).id);
});
after(async () => {
  await server.close();
  cleanup(dataDir);
});

const save = (name, content) => client.post('/api/save-file', { json: { name, path: '/', drive: 'internal', content } });
const leftovers = () => fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));

test('a save replaces the content, keeps the permissions, and leaves nothing behind', async () => {
  const file = path.join(root, 'notes.txt');
  fs.writeFileSync(file, 'old text');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
  const res = await save('notes.txt', 'new text');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new text');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepStrictEqual(leftovers(), []);
});

test('a save that fails part-way leaves the previous version intact', async () => {
  const file = path.join(root, 'precious.txt');
  fs.writeFileSync(file, 'the only copy');
  const realWrite = fs.promises.writeFile;
  fs.promises.writeFile = async (target, ...rest) => {
    if (String(target).endsWith('.tmp')) {
      await realWrite(target, 'partial'); // some bytes reach the disk before it fills up
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    }
    return realWrite(target, ...rest);
  };
  try {
    const res = await save('precious.txt', 'a much longer replacement text');
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.text, 'The drive is full.');
  } finally {
    fs.promises.writeFile = realWrite;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'the only copy');
  assert.deepStrictEqual(leftovers(), []);
});

test('a hard-linked file is updated in place, so every name sees the new text', async () => {
  const file = path.join(root, 'linked.txt');
  const other = path.join(root, 'linked-too.txt');
  fs.writeFileSync(file, 'v1');
  fs.linkSync(file, other);
  assert.strictEqual((await save('linked.txt', 'v2')).status, 200);
  assert.strictEqual(fs.readFileSync(other, 'utf8'), 'v2');
});

test('only existing files can be saved', async () => {
  assert.strictEqual((await save('missing.txt', 'x')).status, 404);
  assert.ok(!fs.existsSync(path.join(root, 'missing.txt')));
  assert.strictEqual((await save('.', 'x')).status, 400);
});
