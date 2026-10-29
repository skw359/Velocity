// Account isolation and external-drive access rules, exercised through the HTTP API.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  isolate, cleanup, startServer, Client, signup, addUser, sendChunk, userRoot, linkDir,
} = require('./support/harness');

const dataDir = isolate();
const drives = require('../drives');
const extDrive = path.join(dataDir, 'external-disk');
const beyond = path.join(dataDir, 'beyond-the-drive');

let server;
let alice; // owner
let aliceUser;
let bob;
let carol; // read-only external access
let dave;  // no external access

before(async () => {
  fs.mkdirSync(path.join(extDrive, 'media'), { recursive: true });
  fs.writeFileSync(path.join(extDrive, 'media', 'song.txt'), 'la la la');
  fs.writeFileSync(path.join(extDrive, 'page.html'), '<script>alert(1)</script>');
  fs.mkdirSync(beyond, { recursive: true });
  fs.writeFileSync(path.join(beyond, 'private.txt'), 'not part of the drive');
  linkDir(beyond, path.join(extDrive, 'escape-link'));
  drives.useFixedDrives([{ id: 'ext1', path: extDrive, label: 'Test Disk' }]);

  server = await startServer();
  alice = new Client(server.base);
  aliceUser = await signup(alice, 'alice');
  bob = await addUser(alice, server.base, 'bob', { externalDrives: 'rw' });
  carol = await addUser(alice, server.base, 'carol', { externalDrives: 'ro' });
  dave = await addUser(alice, server.base, 'dave', { externalDrives: 'none' });
  fs.writeFileSync(path.join(userRoot(dataDir, aliceUser.id), 'diary.txt'), 'alice private');
  fs.mkdirSync(path.join(userRoot(dataDir, aliceUser.id), 'photos'));
});

after(async () => {
  drives.useFixedDrives(null);
  await server.close();
  cleanup(dataDir);
});

const aliceFiles = () => fs.readdirSync(userRoot(dataDir, aliceUser.id)).sort();

describe("one account can't reach another's storage", () => {
  test('traversal toward the other account is refused by every read endpoint', async () => {
    const up = `/../${aliceUser.id}`;
    const q = (p) => encodeURIComponent(p);
    const reads = [
      `/api/list?path=${q(up)}&drive=internal`,
      `/api/download?name=diary.txt&path=${q(up)}&drive=internal`,
      `/api/info?name=diary.txt&path=${q(up)}&drive=internal`,
      `/api/get-size?name=photos&path=${q(up)}&drive=internal`,
      `/api/get-size?name=..&path=/&drive=internal`,
      `/api/thumbnail?path=${q(`${up}/diary.txt`)}&drive=internal`,
      `/api/download?name=..&path=/&drive=internal`,
    ];
    for (const url of reads) {
      const res = await bob.client.get(url);
      assert.ok([400, 404].includes(res.status), `${url}: ${res.status}`);
      assert.doesNotMatch(res.text, /alice private/);
    }
  });

  test('...and by every write endpoint, leaving the other account untouched', async () => {
    const before = aliceFiles();
    const up = `/../${aliceUser.id}`;
    const writes = [
      ['/api/delete', { name: 'diary.txt', path: up, drive: 'internal' }],
      ['/api/rename', { oldName: 'diary.txt', newName: 'x.txt', path: up, drive: 'internal' }],
      ['/api/create-folder', { folder: 'planted', path: up, drive: 'internal' }],
      ['/api/compress', { name: 'photos', type: 'folder', path: up, drive: 'internal' }],
      ['/api/copy', { name: 'diary.txt', path: up, drive: 'internal' }],
      ['/api/transfer', { name: 'diary.txt', sourcePath: up, sourceDrive: 'internal', destPath: '/', destDrive: 'internal', mode: 'move' }],
      ['/api/share', { name: 'diary.txt', path: up, drive: 'internal' }],
    ];
    // A leading '..' is clamped at the account root, so these address paths inside bob's own
    // storage (where nothing by those names exists): they fail or do nothing, but never
    // touch alice's files.
    for (const [url, form] of writes) {
      const res = await bob.client.post(url, { form });
      assert.ok(res.status < 500, `${url}: ${res.status} ${res.text}`);
    }
    const save = await bob.client.post('/api/save-file', { json: { name: 'diary.txt', path: up, drive: 'internal', content: 'pwned' } });
    assert.ok([400, 404].includes(save.status));
    const chunk = await sendChunk(bob.client, { name: 'p.txt', dir: up, index: 0, total: 1, size: 1, data: Buffer.from('x') });
    assert.ok(chunk.status < 500);
    assert.deepStrictEqual(aliceFiles(), before);
    assert.ok(!fs.existsSync(path.join(dataDir, 'content', 'u', 'p.txt')));
    assert.strictEqual(fs.readFileSync(path.join(userRoot(dataDir, aliceUser.id), 'diary.txt'), 'utf8'), 'alice private');
  });

  test("a link planted in one account's folder doesn't open the other's", async () => {
    linkDir(userRoot(dataDir, aliceUser.id), path.join(userRoot(dataDir, bob.user.id), 'shortcut'));
    assert.strictEqual((await bob.client.get('/api/list?path=/shortcut&drive=internal')).status, 400);
    assert.strictEqual((await bob.client.get('/api/download?name=diary.txt&path=/shortcut&drive=internal')).status, 400);
    assert.strictEqual((await bob.client.get('/content/shortcut/diary.txt')).status, 404);
    const chunk = await sendChunk(bob.client, { name: 'planted.txt', dir: '/shortcut', index: 0, total: 1, size: 1, data: Buffer.from('x') });
    assert.strictEqual(chunk.status, 400);
    const del = await bob.client.post('/api/delete', { form: { name: 'diary.txt', path: '/shortcut', drive: 'internal' } });
    assert.strictEqual(del.status, 400);
    assert.ok(fs.existsSync(path.join(userRoot(dataDir, aliceUser.id), 'diary.txt')));
    assert.ok(!fs.existsSync(path.join(userRoot(dataDir, aliceUser.id), 'planted.txt')));
  });

  test("a delete of '.' or '..' can't wipe the account's own root", async () => {
    for (const name of ['.', '..']) {
      const res = await bob.client.post('/api/delete', { form: { name, path: '/', drive: 'internal' } });
      assert.strictEqual(res.status, 400);
    }
    assert.ok(fs.existsSync(userRoot(dataDir, bob.user.id)));
    const queued = await bob.client.post('/api/operations', { json: { type: 'delete', items: [{ name: '.', sourcePath: '/', sourceDrive: 'internal' }] } });
    assert.strictEqual(queued.status, 400);
  });

  test("operation records and share links belong to their owner", async () => {
    const op = await alice.post('/api/operations', { json: { type: 'create-folder', items: [{ name: 'newdir', sourcePath: '/', sourceDrive: 'internal' }] } });
    const { id } = op.json();
    assert.strictEqual((await bob.client.get(`/api/operations/${id}`)).status, 404);
    assert.strictEqual((await bob.client.delete(`/api/operations/${id}`)).status, 404);
    assert.strictEqual((await bob.client.patch(`/api/operations/${id}`, { json: { status: 'canceled' } })).status, 404);
    const share = (await alice.post('/api/share', { form: { name: 'diary.txt', path: '/', drive: 'internal' } })).json().share;
    assert.strictEqual((await bob.client.put(`/api/share/${share.token}`, { json: { access: 'public' } })).status, 404);
    assert.strictEqual((await bob.client.delete(`/api/share/${share.token}`)).status, 404);
  });
});

describe('share links', () => {
  let token;
  before(async () => {
    const root = userRoot(dataDir, aliceUser.id);
    fs.mkdirSync(path.join(root, 'shared', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared', 'sub', 'ok.txt'), 'shared text');
    fs.writeFileSync(path.join(root, 'shared', '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(root, 'shared', 'cache'));
    fs.writeFileSync(path.join(root, 'shared', 'cache', 'thumb.jpg'), 'x');
    token = (await alice.post('/api/share', { form: { name: 'shared', path: '/', drive: 'internal' } })).json().share.token;
  });

  test('a restricted link opens only for its owner', async () => {
    assert.strictEqual((await new Client(server.base).get(`/api/public/share/${token}`)).status, 403);
    assert.strictEqual((await bob.client.get(`/api/public/share/${token}`)).status, 403);
    assert.strictEqual((await alice.get(`/api/public/share/${token}`)).status, 200);
  });

  test('a public link reaches only what it shares', async () => {
    await alice.put(`/api/share/${token}`, { json: { access: 'public' } });
    const anon = new Client(server.base);
    assert.strictEqual((await anon.get(`/api/public/share/${token}/raw?subpath=sub/ok.txt`)).text, 'shared text');
    for (const sub of ['..', '../diary.txt', 'sub/../../diary.txt', '.env', 'cache/thumb.jpg', 'sub/..\\..\\diary.txt']) {
      const res = await anon.get(`/api/public/share/${token}/raw?subpath=${encodeURIComponent(sub)}`);
      assert.ok([400, 404].includes(res.status), `${sub}: ${res.status}`);
      assert.doesNotMatch(res.text, /alice private|SECRET/);
    }
    const listing = (await anon.get(`/api/public/share/${token}/list`)).json().map((e) => e.name);
    assert.deepStrictEqual(listing, ['sub']);
  });

  test('a link stops working when its owner loses access', async () => {
    await alice.post(`/api/admin/users/${bob.user.id}/drives`, { json: { externalDrives: 'rw' } });
    fs.writeFileSync(path.join(extDrive, 'bobs.txt'), 'bob shared this');
    const shared = (await bob.client.post('/api/share', { form: { name: 'bobs.txt', path: '/', drive: 'ext1' } })).json().share;
    await bob.client.put(`/api/share/${shared.token}`, { json: { access: 'public' } });
    const anon = new Client(server.base);
    assert.strictEqual((await anon.get(`/api/public/share/${shared.token}/raw`)).text, 'bob shared this');
    await alice.post(`/api/admin/users/${bob.user.id}/drives`, { json: { externalDrives: 'none' } });
    assert.strictEqual((await anon.get(`/api/public/share/${shared.token}/raw`)).status, 404);
    await alice.post(`/api/admin/users/${bob.user.id}/drives`, { json: { externalDrives: 'rw' } });
  });
});

describe('external drives', () => {
  test("an account without access doesn't even see the drive", async () => {
    const list = (await dave.client.get('/api/drives')).json();
    assert.deepStrictEqual(list.map((d) => d.id), ['internal']);
    const res = await dave.client.get('/api/list?path=/&drive=ext1');
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await dave.client.get('/drive/ext1/media/song.txt')).status, 403);
  });

  test('read-only access reads but every write is refused', async () => {
    assert.strictEqual((await carol.client.get('/api/list?path=/media&drive=ext1')).status, 200);
    assert.strictEqual((await carol.client.get('/drive/ext1/media/song.txt')).text, 'la la la');
    const attempts = [
      carol.client.post('/api/create-folder', { form: { folder: 'x', path: '/', drive: 'ext1' } }),
      carol.client.post('/api/delete', { form: { name: 'media', path: '/', drive: 'ext1' } }),
      carol.client.post('/api/rename', { form: { oldName: 'media', newName: 'm2', path: '/', drive: 'ext1' } }),
      carol.client.post('/api/save-file', { json: { name: 'song.txt', path: '/media', drive: 'ext1', content: 'x' } }),
      sendChunk(carol.client, { name: 'up.txt', drive: 'ext1', index: 0, total: 1, size: 1, data: Buffer.from('x') }),
      carol.client.post('/api/operations', { json: { type: 'delete', items: [{ name: 'media', sourcePath: '/', sourceDrive: 'ext1' }] } }),
      carol.client.post('/api/operations', { json: { type: 'copy', destDrive: 'ext1', destPath: '/', items: [{ name: 'x', sourcePath: '/', sourceDrive: 'internal' }] } }),
    ];
    for (const res of await Promise.all(attempts)) {
      assert.strictEqual(res.status, 403, res.text);
      assert.strictEqual(res.json().error, 'read_only_drive');
    }
    assert.ok(fs.existsSync(path.join(extDrive, 'media', 'song.txt')));
  });

  test('read-write access can write', async () => {
    const res = await bob.client.post('/api/create-folder', { form: { folder: 'bobs-folder', path: '/', drive: 'ext1' } });
    assert.strictEqual(res.status, 201);
    assert.ok(fs.existsSync(path.join(extDrive, 'bobs-folder')));
  });

  test("a link on the drive that points outside it can't be followed", async () => {
    for (const url of ['/api/list?path=/escape-link&drive=ext1', '/api/download?name=private.txt&path=/escape-link&drive=ext1']) {
      const res = await carol.client.get(url);
      assert.strictEqual(res.status, 400, url);
    }
    const viaDrive = await carol.client.get('/drive/ext1/escape-link/private.txt');
    assert.strictEqual(viaDrive.status, 404);
    assert.doesNotMatch(viaDrive.text, /not part of the drive/);
  });

  test('HTML on a shared drive downloads rather than running as this site', async () => {
    const res = await carol.client.get('/drive/ext1/page.html');
    assert.strictEqual(res.status, 200);
    assert.match(String(res.headers['content-disposition']), /^attachment/);
    assert.match(String(res.headers['content-security-policy']), /sandbox/);
  });

  test("an unmounted drive's root is never created", async () => {
    const missing = path.join(dataDir, 'unmounted-disk');
    drives.useFixedDrives([{ id: 'ext1', path: extDrive, label: 'Test Disk' }, { id: 'gone', path: missing }]);
    try {
      const res = await bob.client.get('/api/storage?drive=gone');
      assert.strictEqual(res.status, 500);
      assert.ok(!fs.existsSync(missing), 'no directory appeared where the disk should be mounted');
    } finally {
      drives.useFixedDrives([{ id: 'ext1', path: extDrive, label: 'Test Disk' }]);
    }
  });

  test('the drive list never reveals server paths', async () => {
    const list = (await carol.client.get('/api/drives')).json();
    for (const d of list) assert.strictEqual(d.path, undefined);
  });
});
