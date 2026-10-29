const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { isolate, cleanup, startServer, Client, signup, userRoot } = require('./support/harness');
const { buildZip } = require('./support/archives');

const dataDir = isolate();
const store = require('../operation-store');
const spaceCheck = require('../space-check');
const drives = require('../drives');
const app = require('../app');

let server;
let client;
let user;
let root;

before(async () => {
  server = await startServer();
  client = new Client(server.base);
  user = await signup(client, 'opsuser');
  root = userRoot(dataDir, user.id);
});
after(async () => {
  await app.stopBackgroundWork();
  await server.close();
  cleanup(dataDir);
});

function useFreeSpace(bytes) {
  spaceCheck.init({ getSafePath: drives.getSafePathForUser, driveName: drives.driveName, formatBytes: (n) => `${n} B`, freeBytes: async () => bytes });
}
function useRealFreeSpace() {
  spaceCheck.init({ getSafePath: drives.getSafePathForUser, driveName: drives.driveName, formatBytes: (n) => `${n} B` });
}

async function waitFor(id, statuses = ['completed', 'failed', 'canceled']) {
  for (let i = 0; i < 200; i++) {
    const rec = store.get(id);
    if (statuses.includes(rec.status)) return rec;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`operation ${id} stuck in ${store.get(id).status}`);
}

describe('progress totals', () => {
  test('incremental updates always agree with a full recount', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, relPath: `f${i}`, size: 1000 + i }));
    const op = store.create({ user: user.id, type: 'upload', destDrive: 'internal', destPath: '/' }, items);
    const ids = op.items.map((it) => it.id);
    const expected = () => {
      const all = store.get(op.id).items;
      const done = all.filter((it) => it.status === 'completed').length;
      const bytes = all.reduce((s, it) => s + it.bytesReceived, 0);
      const size = all.reduce((s, it) => s + it.size, 0);
      return { completedCount: done, bytesDone: bytes, progress: Math.min(100, (bytes * 100) / size) };
    };
    const check = () => {
      const meta = store.getMeta(op.id);
      const want = expected();
      assert.strictEqual(meta.completedCount, want.completedCount);
      assert.strictEqual(meta.bytesDone, want.bytesDone);
      assert.ok(Math.abs(meta.progress - want.progress) < 1e-9);
    };
    ids.slice(0, 10).forEach((id, i) => store.setItemBytes(op.id, id, 500 + i));
    check();
    ids.slice(0, 5).forEach((id) => store.itemDone(op.id, id));
    store.itemDone(op.id, ids[0]); // completing twice counts once
    check();
    store.itemFail(op.id, ids[1], 'boom'); // completed -> failed lowers the count
    store.setItemBytes(op.id, ids[2], 0); // a rewind lowers the bytes
    check();
    store.markItem(op.id, 'not-an-item-of-this-op', 'completed');
    check();
    // A full recount (what startup does) lands on the same numbers.
    const before = store.getMeta(op.id);
    store.recomputeParent(op.id);
    const after = store.getMeta(op.id);
    assert.deepStrictEqual([after.completedCount, after.bytesDone, after.itemCount], [before.completedCount, before.bytesDone, before.itemCount]);
  });

  test('polled lists carry a capped item summary; the single-op view has every item', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ name: `p${i}.bin`, relPath: `dir/p${i}.bin`, size: 10, sourcePath: '/', sourceDrive: 'internal' }));
    const created = await client.post('/api/operations', { json: { type: 'upload', destPath: '/', destDrive: 'internal', items } });
    assert.strictEqual(created.status, 200, created.text);
    const { id } = created.json();
    const listed = (await client.get('/api/operations')).json().find((o) => o.id === id);
    assert.strictEqual(listed.itemCount, 200);
    assert.ok(listed.items.length <= 21, `summary has ${listed.items.length} items`);
    assert.strictEqual(listed.itemsTruncated, true);
    assert.strictEqual(listed.items[0].name, 'p0.bin', 'the first item names the operation');
    const full = (await client.get(`/api/operations/${id}`)).json();
    assert.strictEqual(full.items.length, 200);
    await client.delete(`/api/operations/${id}`);
  });
});

describe('the operations API validates what it records', () => {
  test('names that would address a folder itself are refused up front', async () => {
    for (const body of [
      { type: 'delete', items: [{ name: '..', sourcePath: '/' }] },
      { type: 'rename', items: [{ name: 'a', targetName: '../b', sourcePath: '/' }] },
      { type: 'create-folder', items: [{ name: 'a/b', sourcePath: '/' }] },
      { type: 'nonsense', items: [{ name: 'a' }] },
      { type: 'delete', items: [] },
    ]) {
      assert.strictEqual((await client.post('/api/operations', { json: body })).status, 400, JSON.stringify(body));
    }
  });

  test('PATCH may only finish an operation, never send it back to the queue', async () => {
    const { id } = (await client.post('/api/operations', { json: { type: 'upload', items: [{ name: 'a', relPath: 'a', size: 1 }] } })).json();
    assert.strictEqual((await client.patch(`/api/operations/${id}`, { json: { status: 'pending' } })).status, 400);
    assert.strictEqual((await client.patch(`/api/operations/${id}`, { json: { progress: 250 } })).status, 400);
    assert.strictEqual((await client.patch(`/api/operations/${id}`, { json: { status: 'canceled' } })).status, 200);
    assert.strictEqual(store.getMeta(id).status, 'canceled');
  });
});

describe('crash recovery', () => {
  test('an operation interrupted mid-run is resumed and finishes once', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dest'), { recursive: true });
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, 'src', `${n}.txt`), n.repeat(100));
    const op = store.create({ user: user.id, type: 'copy', destDrive: 'internal', destPath: '/dest' },
      ['a.txt', 'b.txt', 'c.txt'].map((name) => ({ name, sourcePath: '/src', sourceDrive: 'internal', size: 100 })));
    // State a crash leaves: the op running, one item done, one in progress, one untouched.
    store.claim(op.id);
    fs.copyFileSync(path.join(root, 'src', 'a.txt'), path.join(root, 'dest', 'a.txt'));
    store.itemDone(op.id, op.items[0].id);
    store.markItem(op.id, op.items[1].id, 'running');
    fs.writeFileSync(path.join(root, 'dest', 'b.txt'), 'bb'); // half-written
    const marker = fs.statSync(path.join(root, 'dest', 'a.txt')).mtimeMs;

    app.startBackgroundWork(); // requeues unfinished work, then runs it
    const done = await waitFor(op.id);
    assert.strictEqual(done.status, 'completed', done.error);
    for (const n of ['a', 'b', 'c']) assert.strictEqual(fs.readFileSync(path.join(root, 'dest', `${n}.txt`), 'utf8'), n.repeat(100));
    assert.strictEqual(fs.statSync(path.join(root, 'dest', 'a.txt')).mtimeMs, marker, 'the finished item was not redone');
  });

  test('an extraction cut off by a crash restarts cleanly from its partial folder', async () => {
    fs.writeFileSync(path.join(root, 'bundle.zip'), buildZip([{ name: 'inside/one.txt', data: '1' }, { name: 'two.txt', data: '2' }]));
    const op = store.create({ user: user.id, type: 'extract', destDrive: 'internal', destPath: '/' }, [{ name: 'bundle.zip', sourcePath: '/', sourceDrive: 'internal' }]);
    store.claim(op.id);
    store.markItem(op.id, op.items[0].id, 'running');
    const partial = path.join(root, `bundle.partial-${op.id}`);
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'leftover-from-crash.txt'), 'junk');
    store.requeueUnfinished();
    require('../operation-runner').wake();
    const done = await waitFor(op.id);
    assert.strictEqual(done.status, 'completed', done.error);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'bundle')).sort(), ['inside', 'two.txt']);
    assert.ok(!fs.existsSync(partial));
  });

  test('a failed extraction leaves no partial folder behind', async () => {
    fs.writeFileSync(path.join(root, 'broken.zip'), Buffer.from('PK\x03\x04 definitely not a zip'));
    const { id } = (await client.post('/api/operations', { json: { type: 'extract', items: [{ name: 'broken.zip', sourcePath: '/', sourceDrive: 'internal' }] } })).json();
    const done = await waitFor(id);
    assert.strictEqual(done.status, 'failed');
    assert.ok(!fs.readdirSync(root).some((n) => n.startsWith('broken')  && n !== 'broken.zip'));
  });

  test('a canceled operation is never started', async () => {
    const op = store.create({ user: user.id, type: 'create-folder', destDrive: 'internal', destPath: '/' }, [{ name: 'never-made', sourcePath: '/', sourceDrive: 'internal' }]);
    store.finalize(op.id, 'canceled');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!fs.existsSync(path.join(root, 'never-made')));
  });

  test('uploads whose client stopped sending are marked interrupted', () => {
    const op = store.create({ user: user.id, type: 'upload', destDrive: 'internal', destPath: '/' }, [{ name: 'x', relPath: 'x', size: 1 }]);
    require('../db').db.prepare('UPDATE operations SET updatedAt = ? WHERE id = ?').run(new Date(Date.now() - 120000).toISOString(), op.id);
    assert.ok(store.reapStaleUploads(60000) >= 1);
    assert.strictEqual(store.getMeta(op.id).status, 'interrupted');
  });
});

describe('space reservations', () => {
  after(useRealFreeSpace);

  test('footprint rounds every file up to whole blocks and charges each folder a block', async () => {
    const dir = path.join(root, 'footprint');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'one-byte'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'exact'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(dir, 'sub', 'empty'), '');
    // dir + sub (2 blocks) + 1 byte (1 block) + 4096 bytes (1 block) + empty (0)
    assert.strictEqual(await spaceCheck.footprint(dir, 4096), 4 * 4096);
  });

  test('two uploads racing for the last free space cannot both be accepted', async () => {
    useFreeSpace(10 * 1024 * 1024);
    const body = (name) => ({ json: { type: 'upload', destDrive: 'internal', destPath: '/', items: [{ name, relPath: name, size: 6 * 1024 * 1024 }] } });
    const [a, b] = await Promise.all([client.post('/api/operations', body('r1.bin')), client.post('/api/operations', body('r2.bin'))]);
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 507]);
    const refused = a.status === 507 ? a : b;
    assert.strictEqual(refused.json().error, 'insufficient_storage');
    assert.ok(refused.json().reserved > 0, 'the refusal counts the other upload');
    for (const res of [a, b]) if (res.status === 200) await client.delete(`/api/operations/${res.json().id}`);
  });

  test('bytes already received no longer count as reserved', async () => {
    useFreeSpace(1e12);
    const op = store.create({ user: user.id, type: 'upload', destDrive: 'internal', destPath: '/' }, [{ name: 'rv.bin', relPath: 'rv.bin', size: 8192 }]);
    const { dev } = fs.statSync(root);
    const before = await spaceCheck.reservedOn(dev);
    store.setItemBytes(op.id, op.items[0].id, 4096);
    assert.strictEqual(await spaceCheck.reservedOn(dev), before - 4096);
    store.itemDone(op.id, op.items[0].id);
    assert.strictEqual(await spaceCheck.reservedOn(dev), before - 8192);
    store.finalize(op.id, 'completed');
  });

  test('a queued copy that no longer fits fails whole, before copying anything', async () => {
    await app.stopBackgroundWork();
    fs.mkdirSync(path.join(root, 'bigsrc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bigsrc', 'data.bin'), Buffer.alloc(64 * 1024));
    useFreeSpace(1e12);
    const { id } = (await client.post('/api/operations', { json: { type: 'copy', destDrive: 'internal', destPath: '/', items: [{ name: 'bigsrc', sourcePath: '/', sourceDrive: 'internal' }] } })).json();
    useFreeSpace(1024); // the disk filled up while it waited in the queue
    require('../operation-runner').init({ getSafePath: drives.getSafePathForUser, isPathInside: require('../paths').isPathInside, findFreeTransferName: require('../paths').findFreeTransferName, uniqueEntryNames: require('../paths').uniqueEntryNames });
    require('../operation-runner').start();
    const done = await waitFor(id);
    assert.strictEqual(done.status, 'failed');
    assert.match(done.error, /^Insufficient storage space\./);
    assert.ok(!fs.existsSync(path.join(root, 'bigsrc-1')));
    await require('../operation-runner').stop();
  });

  test('an extraction is budgeted against free space less reservations', async () => {
    useFreeSpace(100 * 1024);
    const budget = await spaceCheck.extractBudget(root);
    assert.ok(budget.maxBytes <= 100 * 1024);
    fs.writeFileSync(path.join(root, 'roomy.zip'), buildZip([{ name: 'big.bin', data: Buffer.alloc(1024 * 1024), deflate: true }]));
    const res = await client.post('/api/extract', { form: { name: 'roomy.zip', path: '/', drive: 'internal' } });
    assert.strictEqual(res.status, 507);
    assert.strictEqual(res.json().error, 'insufficient_storage');
    assert.ok(!fs.existsSync(path.join(root, 'roomy')));
  });
});
