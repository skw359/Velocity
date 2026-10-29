const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, cleanup, startServer, Client, signup, uploadBuffer, userRoot, linkDir } = require('./support/harness');

const dataDir = isolate();
const dirSize = require('../dir-size');
const tree = path.join(dataDir, 'tree');

before(() => {
  fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'one.bin'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(tree, 'a', 'two.bin'), Buffer.alloc(2000));
  fs.writeFileSync(path.join(tree, 'a', 'b', 'three.bin'), Buffer.alloc(3000));
  const outside = path.join(dataDir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'big.bin'), Buffer.alloc(50000));
  linkDir(outside, path.join(tree, 'link'));
});

after(async () => {
  await dirSize.shutdown();
  cleanup(dataDir);
});

test('no size workers exist until a size is asked for', () => {
  assert.strictEqual(dirSize.stats().workers, 0);
});

test('sums regular files and does not follow links', async () => {
  assert.deepStrictEqual(await dirSize.measure(tree), { size: 6000, files: 3 });
  assert.deepStrictEqual(await dirSize.measure(path.join(tree, 'one.bin')), { size: 1000, files: 1 });
  assert.ok(dirSize.stats().workers >= 1);
});

test('results are cached until something under them changes', async () => {
  fs.writeFileSync(path.join(tree, 'a', 'b', 'late.bin'), Buffer.alloc(500));
  assert.strictEqual((await dirSize.measure(tree)).size, 6000, 'served from cache');
  // A change deep inside invalidates every folder above it...
  dirSize.invalidate(path.join(tree, 'a', 'b', 'late.bin'));
  assert.strictEqual((await dirSize.measure(tree)).size, 6500);
  assert.strictEqual((await dirSize.measure(path.join(tree, 'a'))).size, 5500);
  // ...and removing a folder invalidates what was cached below it.
  fs.rmSync(path.join(tree, 'a', 'b'), { recursive: true });
  dirSize.invalidate(path.join(tree, 'a'));
  assert.strictEqual((await dirSize.measure(path.join(tree, 'a'))).size, 2000);
});

test('concurrent requests for one folder share a single walk, and the pool is capped', async () => {
  dirSize.invalidate(tree);
  const same = Array.from({ length: 5 }, () => dirSize.measure(tree));
  const s = dirSize.stats();
  assert.strictEqual(s.busy + s.queued, 1);
  await Promise.all(same);

  const dirs = Array.from({ length: dirSize.MAX_WORKERS + 6 }, (_, i) => {
    const d = path.join(dataDir, `many-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'f'), 'x');
    return d;
  });
  const all = dirs.map((d) => dirSize.measure(d));
  assert.ok(dirSize.stats().workers <= dirSize.MAX_WORKERS);
  assert.ok(dirSize.stats().queued > 0);
  for (const r of await Promise.all(all)) assert.deepStrictEqual(r, { size: 1, files: 1 });
});

test('a worker that dies mid-walk fails its request instead of hanging it', async () => {
  const big = path.join(dataDir, 'big-tree');
  for (let d = 0; d < 40; d++) {
    fs.mkdirSync(path.join(big, `d${d}`), { recursive: true });
    for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(big, `d${d}`, `f${f}`), '');
  }
  const failed = assert.rejects(dirSize.measure(big), /stopped/);
  await dirSize.shutdown();
  await failed;
  // The pool recovers on the next request.
  assert.deepStrictEqual(await dirSize.measure(path.join(tree, 'one.bin')), { size: 1000, files: 1 });
});

test('the API reflects an upload immediately', async () => {
  const server = await startServer();
  try {
    const client = new Client(server.base);
    const user = await signup(client, 'sizer');
    fs.mkdirSync(path.join(userRoot(dataDir, user.id), 'album'));
    const size = async () => (await client.get('/api/get-size?name=album&path=/&drive=internal')).json().size;
    assert.strictEqual(await size(), 0);
    await uploadBuffer(client, { name: 'pic.bin', relPath: 'album/pic.bin', data: Buffer.alloc(4321) });
    assert.strictEqual(await size(), 4321);
    const info = (await client.get('/api/info?name=album&path=/&drive=internal')).json();
    assert.strictEqual(info.size, 4321);
    assert.strictEqual(info.count, 1);
  } finally {
    await server.close();
  }
});
