const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  isolate, cleanup, startServer, Client, signup, addUser, uploadBuffer, userRoot,
} = require('./support/harness');
const { buildZip, buildTar } = require('./support/archives');

const dataDir = isolate();
const { extractArchive, ArchiveError, ExtractLimitError } = require('../archive-extract');

const work = path.join(dataDir, 'work');
fs.mkdirSync(work, { recursive: true });
let seq = 0;

// Writes the archive, extracts it into a fresh folder, and reports what happened.
async function extract(buffer, ext, limits = {}) {
  const n = ++seq;
  const archive = path.join(work, `a${n}${ext}`);
  const dest = path.join(work, `dest${n}`, 'inner');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(archive, buffer);
  let error = null;
  let result = null;
  try { result = await extractArchive(archive, dest, limits); } catch (e) { error = e; }
  return { dest, parent: path.dirname(dest), error, result };
}

function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((p) => p.split(path.sep).join('/')).sort();
}

after(() => cleanup(dataDir));

describe('zip extraction', () => {
  test("the review's exploit name ('....//....//<id>/x') stays inside the destination", async () => {
    const { dest, parent, error } = await extract(buildZip([{ name: '....//....//victim/VELOCITY-ZIPTEST.txt', data: 'x' }]), '.zip');
    assert.strictEqual(error, null);
    // Written as data under sanitized folder names, nowhere else.
    assert.deepStrictEqual(listTree(parent), ['inner', 'inner/_', 'inner/_/_', 'inner/_/_/victim', 'inner/_/_/victim/VELOCITY-ZIPTEST.txt']);
    assert.ok(fs.existsSync(path.join(dest, '_', '_', 'victim', 'VELOCITY-ZIPTEST.txt')));
  });

  for (const [label, name] of [
    ['parent segment', '../escaped.txt'],
    ['nested parent segments', 'a/../../escaped.txt'],
    ['backslash traversal', '..\\..\\escaped.txt'],
    ['absolute path', '/escaped.txt'],
    ['drive-letter path', 'C:/escaped.txt'],
  ]) {
    test(`refuses an entry with a ${label} and writes nothing`, async () => {
      const zip = buildZip([{ name: 'fine.txt', data: 'ok' }, { name, data: 'evil' }, { name: 'later.txt', data: 'ok' }]);
      const { parent, error } = await extract(zip, '.zip');
      assert.ok(error instanceof ArchiveError, `expected ArchiveError, got ${error}`);
      assert.strictEqual(error.status, 400);
      // Validation happens before the first byte: even the safe entries weren't written.
      assert.deepStrictEqual(listTree(parent), ['inner']);
    });
  }

  test('symlink and special entries are skipped, never created', async () => {
    const zip = buildZip([
      { name: 'link', data: '../../victim', mode: 0o120777 },
      { name: 'fifo', data: '', mode: 0o010644 },
      { name: 'ok.txt', data: 'fine' },
    ]);
    const { dest, error, result } = await extract(zip, '.zip');
    assert.strictEqual(error, null);
    assert.deepStrictEqual(listTree(dest), ['ok.txt']);
    assert.strictEqual(result.skipped, 2);
  });

  test('names Windows cannot hold are sanitized like uploads', async () => {
    const zip = buildZip([{ name: 'dir:x/a<b>.txt', data: '1' }, { name: 'con.txt', data: '2' }, { name: 'trail. ', data: '3' }]);
    const { dest, error } = await extract(zip, '.zip');
    assert.strictEqual(error, null);
    assert.deepStrictEqual(listTree(dest), ['_con.txt', 'dir-x', 'dir-x/a_b_.txt', 'trail']);
  });

  test('deflated content round-trips and folders are created', async () => {
    const big = Buffer.alloc(300000, 'velocity ');
    const zip = buildZip([{ name: 'docs/', mode: 0o040755 }, { name: 'docs/big.txt', data: big, deflate: true }, { name: 'empty/', mode: 0o040755 }]);
    const { dest, error } = await extract(zip, '.zip');
    assert.strictEqual(error, null);
    assert.ok(fs.readFileSync(path.join(dest, 'docs', 'big.txt')).equals(big));
    assert.ok(fs.statSync(path.join(dest, 'empty')).isDirectory());
  });

  test('encrypted entries are refused rather than silently dropped', async () => {
    const { error, parent } = await extract(buildZip([{ name: 'secret.txt', data: 'x', encrypted: true }]), '.zip');
    assert.ok(error instanceof ArchiveError);
    assert.match(error.message, /Encrypted/);
    assert.deepStrictEqual(listTree(parent), ['inner']);
  });

  test('an archive larger than the space budget is refused before writing (zip bomb)', async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const zip = buildZip([{ name: 'bomb.bin', data: zeros, deflate: true }]);
    assert.ok(zip.length < 64 * 1024, 'the archive itself is small');
    const { error, parent } = await extract(zip, '.zip', { maxBytes: 1024 * 1024, blockSize: 4096 });
    assert.ok(error instanceof ExtractLimitError);
    assert.strictEqual(error.status, 507);
    assert.ok(error.required >= zeros.length);
    assert.deepStrictEqual(listTree(parent), ['inner']);
  });

  test('many empty entries are charged a block each', async () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}`, data: '' }));
    const { error } = await extract(buildZip(entries), '.zip', { maxBytes: 100 * 4096, blockSize: 4096 });
    assert.ok(error instanceof ExtractLimitError);
  });

  test('a truncated archive is reported as unreadable', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hello world' }]);
    const { error } = await extract(zip.subarray(0, zip.length - 30), '.zip');
    assert.ok(error instanceof ArchiveError);
  });
});

describe('tar.gz extraction', () => {
  test('extracts files and folders', async () => {
    const tgz = buildTar([{ name: 'dir', type: 'dir' }, { name: 'dir/a.txt', data: 'hello' }, { name: 'b.txt', data: 'world' }], { gzip: true });
    const { dest, error, result } = await extract(tgz, '.tar.gz');
    assert.strictEqual(error, null);
    assert.deepStrictEqual(listTree(dest), ['b.txt', 'dir', 'dir/a.txt']);
    assert.strictEqual(fs.readFileSync(path.join(dest, 'dir', 'a.txt'), 'utf8'), 'hello');
    assert.strictEqual(result.files, 2);
  });

  test('refuses parent segments, including ones hidden in a PAX header', async () => {
    for (const entries of [
      [{ name: '../../victim/t.txt', data: 'x' }],
      [{ name: 'innocent.txt', paxPath: '../../victim/pax.txt', data: 'x' }],
    ]) {
      const { error, parent } = await extract(buildTar(entries, { gzip: true }), '.tar.gz');
      assert.ok(error instanceof ArchiveError, String(error));
      assert.deepStrictEqual(listTree(parent), ['inner']);
    }
  });

  test('absolute names are kept inside the destination', async () => {
    const { dest, error } = await extract(buildTar([{ name: '/etc/x.txt', data: 'x' }], { gzip: true }), '.tar.gz');
    assert.strictEqual(error, null);
    assert.deepStrictEqual(listTree(dest), ['etc', 'etc/x.txt']);
  });

  test('symlinks, hard links and devices are skipped, so nothing can be written through them', async () => {
    const tgz = buildTar([
      { name: 'esc', type: 'symlink', linkname: '../../victim' },
      { name: 'esc/through.txt', data: 'x' },
      { name: 'hl', type: 'hardlink', linkname: '../../victim/secret' },
      { name: 'dev', type: 'chardev' },
      { name: 'pipe', type: 'fifo' },
    ], { gzip: true });
    const { dest, error, result } = await extract(tgz, '.tar.gz');
    assert.strictEqual(error, null);
    assert.strictEqual(result.skipped, 4);
    // 'esc' is an ordinary folder created for the file, not a link.
    assert.ok(fs.lstatSync(path.join(dest, 'esc')).isDirectory());
    assert.deepStrictEqual(listTree(dest), ['esc', 'esc/through.txt']);
  });

  test('permission bits from the archive (setuid) are not applied', { skip: process.platform === 'win32' }, async () => {
    const { dest, error } = await extract(buildTar([{ name: 'tool', data: 'x', mode: 0o4755 }], { gzip: true }), '.tar.gz');
    assert.strictEqual(error, null);
    assert.strictEqual(fs.statSync(path.join(dest, 'tool')).mode & 0o7000, 0);
  });

  test('a gzip bomb is stopped by the budget', async () => {
    const tgz = buildTar([{ name: 'big.bin', data: Buffer.alloc(6 * 1024 * 1024) }], { gzip: true });
    const { error } = await extract(tgz, '.tar.gz', { maxBytes: 1024 * 1024 });
    assert.ok(error instanceof ExtractLimitError);
  });

  test('non-tar and corrupt input fail cleanly instead of hanging', async () => {
    const notTar = zlib.gzipSync(Buffer.from('just some text, not a tarball'));
    const good = buildTar([{ name: 'a.bin', data: require('crypto').randomBytes(200000) }], { gzip: true });
    const corrupt = Buffer.from(good);
    corrupt.fill(0x55, 1000, 1400); // damage the deflate stream mid-entry
    for (const buf of [notTar, corrupt]) {
      const { error } = await extract(buf, '.tar.gz');
      assert.ok(error instanceof ArchiveError, String(error));
    }
  });

  test('a truncated tar.gz fails cleanly', async () => {
    const good = buildTar([{ name: 'a.bin', data: Buffer.alloc(100000, 2) }], { gzip: true });
    const { error } = await extract(good.subarray(0, Math.floor(good.length / 2)), '.tar.gz');
    assert.ok(error instanceof ArchiveError, String(error));
  });
});

describe('extraction through the API (cross-account containment)', () => {
  let server;
  let owner;
  let mallory;
  let ownerUser;

  before(async () => {
    server = await startServer();
    owner = new Client(server.base);
    ownerUser = await signup(owner, 'alice');
    mallory = await addUser(owner, server.base, 'mallory');
    require('../app').startBackgroundWork();
  });

  after(async () => {
    await require('../app').stopBackgroundWork();
    await server.close();
  });

  function ownerVault() {
    return listTree(userRoot(dataDir, ownerUser.id));
  }

  test("replays the review's reproduction: a non-owner's zip cannot write into the owner's vault", async () => {
    const before = ownerVault();
    const zip = buildZip([{ name: `....//....//${ownerUser.id}/VELOCITY-ZIPTEST.txt`, data: 'written-across-tenant-boundary' }]);
    const up = await uploadBuffer(mallory.client, { name: 'evil.zip', data: zip });
    assert.strictEqual(up.status, 200);
    const res = await mallory.client.post('/api/extract', { form: { name: 'evil.zip', path: '/', drive: 'internal' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(ownerVault(), before);
    // Everything the archive held is inside mallory's own new folder.
    const malloryRoot = userRoot(dataDir, mallory.user.id);
    assert.ok(fs.existsSync(path.join(malloryRoot, 'evil', '_', '_', ownerUser.id, 'VELOCITY-ZIPTEST.txt')));
    for (const target of ['VELOCITY-ZIPTEST.txt', path.join('..', 'VELOCITY-ZIPTEST.txt')]) {
      assert.ok(!fs.existsSync(path.join(path.dirname(malloryRoot), target)));
    }
  });

  test('a traversal archive is refused through the API and leaves no partial folder', async () => {
    const zip = buildZip([{ name: '../../escape.txt', data: 'x' }]);
    await uploadBuffer(mallory.client, { name: 'bad.zip', data: zip });
    const res = await mallory.client.post('/api/extract', { form: { name: 'bad.zip', path: '/', drive: 'internal' } });
    assert.strictEqual(res.status, 400);
    const names = fs.readdirSync(userRoot(dataDir, mallory.user.id));
    assert.ok(!names.some((n) => n.includes('.partial-')), names.join(','));
    assert.ok(!names.includes('bad'));
  });

  test('the queued operation path (the runner) is contained the same way', async () => {
    const tgz = buildTar([{ name: 'link', type: 'symlink', linkname: `../../${ownerUser.id}` }, { name: 'link/planted.txt', data: 'x' }], { gzip: true });
    await uploadBuffer(mallory.client, { name: 'queued.tar.gz', data: tgz });
    const op = await mallory.client.post('/api/operations', {
      json: { type: 'extract', items: [{ name: 'queued.tar.gz', sourcePath: '/', sourceDrive: 'internal' }] },
    });
    assert.strictEqual(op.status, 200, op.text);
    const { id } = op.json();
    let rec;
    for (let i = 0; i < 100; i++) {
      rec = (await mallory.client.get(`/api/operations/${id}`)).json();
      if (!['pending', 'running'].includes(rec.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(rec.status, 'completed', JSON.stringify(rec));
    assert.ok(!fs.existsSync(path.join(userRoot(dataDir, ownerUser.id), 'planted.txt')));
    assert.ok(fs.lstatSync(path.join(userRoot(dataDir, mallory.user.id), 'queued', 'link')).isDirectory());
  });

  test("extracting with a name that targets the folder itself is refused", async () => {
    for (const name of ['.', '..', '../x.zip']) {
      const res = await mallory.client.post('/api/extract', { form: { name, path: '/', drive: 'internal' } });
      assert.strictEqual(res.status, 400, `${name}: ${res.status}`);
    }
  });
});
