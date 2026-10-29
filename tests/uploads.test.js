const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const {
  isolate, cleanup, startServer, Client, signup, addUser, sendChunk, uploadBuffer, userRoot, CHUNK_SIZE,
} = require('./support/harness');

const dataDir = isolate();
let server;
let client;
let user;

before(async () => {
  server = await startServer();
  client = new Client(server.base);
  user = await signup(client, 'uploader');
});
after(async () => {
  await server.close();
  cleanup(dataDir);
});

const root = () => userRoot(dataDir, user.id);

async function newUploadOp(c, files, dir = '/') {
  const res = await c.post('/api/operations', {
    json: { type: 'upload', destDrive: 'internal', destPath: dir, items: files.map((f) => ({ name: path.basename(f.relPath), relPath: f.relPath, size: f.size, sourceDrive: 'internal', sourcePath: dir })) },
  });
  assert.strictEqual(res.status, 200, res.text);
  return res.json();
}

async function op(c, id) {
  return (await c.get(`/api/operations/${id}`)).json();
}

test('a multi-chunk upload is written exactly and completes its operation', async () => {
  const data = crypto.randomBytes(2 * CHUNK_SIZE + 12345);
  const rec = await newUploadOp(client, [{ relPath: 'big/file.bin', size: data.length }]);
  const res = await uploadBuffer(client, { name: 'file.bin', relPath: 'big/file.bin', data, opId: rec.id });
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(fs.readFileSync(path.join(root(), 'big', 'file.bin')).equals(data));
  const done = await op(client, rec.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.progress, 100);
  assert.strictEqual(done.items[0].bytesReceived, data.length);
});

test('chunk headers that disagree with each other are refused', async () => {
  const base = { name: 'h.bin', data: Buffer.alloc(10), size: 10, total: 1, index: 0 };
  const cases = [
    { ...base, index: 1 },                         // index past the last chunk
    { ...base, total: 2 },                         // 10 bytes can't be two chunks
    { ...base, size: CHUNK_SIZE + 1, total: 1 },   // too big for one chunk
    { ...base, index: -1 },
    { ...base, size: 'ten' },
    { ...base, headers: { 'x-file-name': '' } },
    { ...base, headers: { 'x-relative-path': '%E0%A4%A' } }, // malformed URI encoding
  ];
  for (const c of cases) {
    const res = await sendChunk(client, c);
    assert.strictEqual(res.status, 400, `${JSON.stringify({ ...c, data: undefined })}: ${res.status} ${res.text}`);
  }
  assert.ok(!fs.existsSync(path.join(root(), 'h.bin')));
});

test('a chunk must carry exactly its share of bytes', async () => {
  // A non-final chunk shorter than CHUNK_SIZE.
  const short = await sendChunk(client, { name: 's.bin', index: 0, total: 2, size: CHUNK_SIZE + 5, data: Buffer.alloc(100) });
  assert.strictEqual(short.status, 400);
  // A final chunk declaring more bytes than the file has left.
  const long = await sendChunk(client, { name: 'l.bin', index: 0, total: 1, size: 10, data: Buffer.alloc(20) });
  assert.strictEqual(long.status, 400);
});

test('a streamed chunk that overruns its declared size never extends the file', async () => {
  const name = 'overrun.bin';
  const status = await new Promise((resolve) => {
    const req = http.request(`${server.base}/api/upload-chunk`, {
      method: 'POST',
      headers: {
        cookie: client.cookieHeader(),
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked',
        'x-file-name': name, 'x-relative-path': name, 'x-current-path': '/', 'x-drive-id': 'internal',
        'x-chunk-index': '0', 'x-total-chunks': '1', 'x-total-file-size': '1000',
      },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve('reset'));
    req.write(Buffer.alloc(800, 1));
    req.end(Buffer.alloc(800, 2));
  });
  assert.ok(status === 400 || status === 'reset', String(status));
  const file = path.join(root(), name);
  assert.ok(!fs.existsSync(file) || fs.statSync(file).size <= 1000);
});

test('a chunk that would leave a hole is refused with the offset to resume from', async () => {
  const size = 2 * CHUNK_SIZE + 10;
  const res = await sendChunk(client, { name: 'hole.bin', index: 1, total: 3, size, data: Buffer.alloc(CHUNK_SIZE) });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.json().error, 'upload_out_of_order');
  assert.strictEqual(res.json().offset, 0);
  assert.ok(!fs.existsSync(path.join(root(), 'hole.bin')));
});

test('an interrupted upload resumes from what the server recorded, and finishes intact', async () => {
  const data = crypto.randomBytes(2 * CHUNK_SIZE + 777);
  const rec = await newUploadOp(client, [{ relPath: 'resume.bin', size: data.length }]);
  for (const index of [0, 1]) {
    const res = await sendChunk(client, { name: 'resume.bin', index, total: 3, size: data.length, data: data.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), opId: rec.id });
    assert.strictEqual(res.status, 200);
  }
  const mid = await op(client, rec.id);
  assert.strictEqual(mid.status, 'pending');
  const offset = (await client.get(`/api/upload-offset?opId=${rec.id}&file=resume.bin`)).json().offset;
  assert.strictEqual(offset, 2 * CHUNK_SIZE);
  const last = await sendChunk(client, { name: 'resume.bin', index: 2, total: 3, size: data.length, data: data.subarray(2 * CHUNK_SIZE), opId: rec.id });
  assert.strictEqual(last.status, 200);
  assert.ok(fs.readFileSync(path.join(root(), 'resume.bin')).equals(data));
  assert.strictEqual((await op(client, rec.id)).status, 'completed');
});

test('a stale file at the destination is never mistaken for uploaded bytes', async () => {
  const stalePath = path.join(root(), 'stale.bin');
  fs.writeFileSync(stalePath, crypto.randomBytes(3 * CHUNK_SIZE)); // bigger than the new file
  const data = crypto.randomBytes(CHUNK_SIZE + 50);
  const rec = await newUploadOp(client, [{ relPath: 'stale.bin', size: data.length }]);
  // The old code reported the stale file's size here, and the client skipped "uploaded" chunks.
  assert.strictEqual((await client.get(`/api/upload-offset?opId=${rec.id}&file=stale.bin`)).json().offset, 0);
  assert.strictEqual((await uploadBuffer(client, { name: 'stale.bin', data, opId: rec.id })).status, 200);
  assert.ok(fs.readFileSync(stalePath).equals(data));
});

test('the last chunk trims a stale tail so the file ends at the declared size', async () => {
  const data = crypto.randomBytes(CHUNK_SIZE + 99);
  const dest = path.join(root(), 'tail.bin');
  assert.strictEqual((await sendChunk(client, { name: 'tail.bin', index: 0, total: 2, size: data.length, data: data.subarray(0, CHUNK_SIZE) })).status, 200);
  fs.appendFileSync(dest, Buffer.alloc(5 * 1024 * 1024, 0xee)); // junk past the end, from elsewhere
  assert.strictEqual((await sendChunk(client, { name: 'tail.bin', index: 1, total: 2, size: data.length, data: data.subarray(CHUNK_SIZE) })).status, 200);
  assert.ok(fs.readFileSync(dest).equals(data));
});

test('a file cut short between chunks is caught instead of completed', async () => {
  const data = crypto.randomBytes(2 * CHUNK_SIZE + 5);
  const rec = await newUploadOp(client, [{ relPath: 'cut.bin', size: data.length }]);
  for (const index of [0, 1]) {
    await sendChunk(client, { name: 'cut.bin', index, total: 3, size: data.length, data: data.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), opId: rec.id });
  }
  fs.truncateSync(path.join(root(), 'cut.bin'), 1000);
  const res = await sendChunk(client, { name: 'cut.bin', index: 2, total: 3, size: data.length, data: data.subarray(2 * CHUNK_SIZE), opId: rec.id });
  assert.strictEqual(res.status, 409);
  // The resume point never exceeds what is actually on disk.
  assert.strictEqual(res.json().offset, 1000);
  assert.notStrictEqual((await op(client, rec.id)).status, 'completed');
});

test('an empty file uploads as one empty chunk', async () => {
  const rec = await newUploadOp(client, [{ relPath: 'empty.txt', size: 0 }]);
  const res = await sendChunk(client, { name: 'empty.txt', index: 0, total: 1, size: 0, data: Buffer.alloc(0), opId: rec.id });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.statSync(path.join(root(), 'empty.txt')).size, 0);
  assert.strictEqual((await op(client, rec.id)).status, 'completed');
});

test("another account's operation id is neither advanced nor readable", async () => {
  const other = await addUser(client, server.base, 'otheruser');
  const theirs = await newUploadOp(other.client, [{ relPath: 'x.bin', size: 5 }]);
  // Our chunk lands in our own storage; their record is untouched.
  const res = await sendChunk(client, { name: 'x.bin', index: 0, total: 1, size: 5, data: Buffer.from('hello'), opId: theirs.id });
  assert.strictEqual(res.status, 200);
  const after = await op(other.client, theirs.id);
  assert.strictEqual(after.items[0].bytesReceived, 0);
  assert.strictEqual(after.status, 'pending');
  assert.strictEqual((await client.get(`/api/upload-offset?opId=${theirs.id}&file=x.bin`)).json().offset, 0);
  assert.strictEqual((await client.get(`/api/operations/${theirs.id}`)).status, 404);
});

test('upload paths cannot leave the account, whatever the headers say', async () => {
  const escape = await sendChunk(client, { name: 'e.txt', relPath: '../../../escape.txt', index: 0, total: 1, size: 3, data: Buffer.from('abc') });
  assert.strictEqual(escape.status, 200);
  assert.ok(fs.existsSync(path.join(root(), 'escape.txt')), 'stored inside the account, traversal stripped');
  assert.ok(!fs.existsSync(path.join(dataDir, 'escape.txt')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'content', 'escape.txt')));
  const badDir = await sendChunk(client, { name: 'f.txt', dir: '/../..', index: 0, total: 1, size: 3, data: Buffer.from('abc') });
  assert.strictEqual(badDir.status, 400);
});

test('a chunk aborted mid-transfer releases its file for the retry', async () => {
  const data = crypto.randomBytes(CHUNK_SIZE);
  const total = 1;
  await new Promise((resolve) => {
    const req = http.request(`${server.base}/api/upload-chunk`, {
      method: 'POST',
      headers: {
        cookie: client.cookieHeader(), 'content-type': 'application/octet-stream', 'content-length': String(data.length),
        'x-file-name': 'abort.bin', 'x-relative-path': 'abort.bin', 'x-current-path': '/', 'x-drive-id': 'internal',
        'x-chunk-index': '0', 'x-total-chunks': String(total), 'x-total-file-size': String(data.length),
      },
    });
    req.on('error', () => resolve());
    req.write(data.subarray(0, 1024 * 1024), () => setTimeout(() => { req.destroy(); resolve(); }, 100));
  });
  const started = Date.now();
  const retry = await sendChunk(client, { name: 'abort.bin', index: 0, total, size: data.length, data });
  assert.strictEqual(retry.status, 200);
  assert.ok(Date.now() - started < 10000, 'the retry was not blocked behind the dead request');
  assert.ok(fs.readFileSync(path.join(root(), 'abort.bin')).equals(data));
});

test('the first chunk is refused with 507 when the disk cannot hold the file', async () => {
  const spaceCheck = require('../space-check');
  const drives = require('../drives');
  spaceCheck.init({ getSafePath: drives.getSafePathForUser, driveName: drives.driveName, formatBytes: String, freeBytes: async () => 1024 });
  try {
    const res = await sendChunk(client, { name: 'huge.bin', index: 0, total: 1, size: 5000, data: Buffer.alloc(5000) });
    assert.strictEqual(res.status, 507);
    assert.strictEqual(res.json().error, 'insufficient_storage');
    assert.ok(!fs.existsSync(path.join(root(), 'huge.bin')));
  } finally {
    spaceCheck.init({ getSafePath: drives.getSafePathForUser, driveName: drives.driveName, formatBytes: String });
  }
});
