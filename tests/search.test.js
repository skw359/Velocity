const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { isolate, cleanup, startServer, Client, signup, addUser, userRoot, linkDir } = require('./support/harness');

const dataDir = isolate();
const { LIMITS } = require('../search');
let server;
let client;
let user;

before(async () => {
  server = await startServer();
  client = new Client(server.base);
  user = await signup(client, 'searcher');
  const root = userRoot(dataDir, user.id);
  fs.mkdirSync(path.join(root, 'docs', 'deep', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'Report-Alpha.txt'), 'nothing to see');
  fs.writeFileSync(path.join(root, 'docs', 'deep', 'deeper', 'notes.md'), 'the secret word is pineapple');
  // A match that straddles the 64 KB read boundary.
  fs.writeFileSync(path.join(root, 'docs', 'boundary.txt'), Buffer.concat([Buffer.alloc(64 * 1024 - 3, 'x'), Buffer.from('kiwifruit')]));
  // Too large to read: matched by name only.
  fs.writeFileSync(path.join(root, 'docs', 'huge.log'), Buffer.concat([Buffer.alloc(LIMITS.contentBytes + 10, 'y'), Buffer.from('mango')]));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'pineapple-config'), '');
  fs.mkdirSync(path.join(root, 'many'));
  for (let i = 0; i < LIMITS.results + 50; i++) fs.writeFileSync(path.join(root, 'many', `banana-${i}.dat`), '');
});

after(async () => {
  await server.close();
  cleanup(dataDir);
});

function connect(c = client, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.base.replace('http', 'ws'), { headers: { cookie: c.cookieHeader(), origin: server.base, ...headers } });
    ws.messages = [];
    ws.on('message', (data) => ws.messages.push(JSON.parse(data)));
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error(`upgrade refused: ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

function search(ws, query, drive = 'internal') {
  const start = ws.messages.length;
  ws.send(JSON.stringify({ type: 'start_search', query, drive }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('search did not complete')), 30000);
    const check = () => {
      const fresh = ws.messages.slice(start);
      const done = fresh.find((m) => m.type === 'search_complete' || m.type === 'search_error');
      if (!done) return;
      clearTimeout(timer);
      ws.off('message', check);
      resolve({ results: fresh.filter((m) => m.type === 'search_result').map((m) => m.data), done });
    };
    ws.on('message', check);
  });
}

test('finds names and file contents, but not hidden entries', async () => {
  const ws = await connect();
  const byName = await search(ws, 'report-alpha');
  assert.deepStrictEqual(byName.results.map((r) => `${r.path}/${r.name}`), ['/docs/Report-Alpha.txt']);
  const byContent = await search(ws, 'PINEAPPLE');
  assert.deepStrictEqual(byContent.results.map((r) => `${r.path}/${r.name}`), ['/docs/deep/deeper/notes.md']);
  const split = await search(ws, 'kiwifruit');
  assert.deepStrictEqual(split.results.map((r) => r.name), ['boundary.txt']);
  ws.close();
});

test('large files are matched by name only', async () => {
  const ws = await connect();
  assert.deepStrictEqual((await search(ws, 'mango')).results, []);
  assert.deepStrictEqual((await search(ws, 'huge.log')).results.map((r) => r.name), ['huge.log']);
  ws.close();
});

test('results stop at the cap and the completion says so', async () => {
  const ws = await connect();
  const { results, done } = await search(ws, 'banana');
  assert.strictEqual(results.length, LIMITS.results);
  assert.strictEqual(done.truncated, true);
  ws.close();
});

test('a new query cancels the one still running', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'start_search', query: 'banana' }));
  const second = await search(ws, 'report-alpha');
  assert.deepStrictEqual(second.results.map((r) => r.name), ['Report-Alpha.txt']);
  await new Promise((r) => setTimeout(r, 300));
  const completes = ws.messages.filter((m) => m.type === 'search_complete');
  assert.strictEqual(completes.length, 1, 'the canceled search never reports completion');
  const afterSecond = ws.messages.slice(ws.messages.indexOf(completes[0]));
  assert.ok(!afterSecond.some((m) => m.type === 'search_result' && m.data.name.startsWith('banana')));
  ws.close();
});

test("links aren't followed into another account's storage", async () => {
  const other = await addUser(client, server.base, 'neighbour');
  fs.writeFileSync(path.join(userRoot(dataDir, other.user.id), 'neighbour-secret-papaya.txt'), 'papaya');
  linkDir(userRoot(dataDir, other.user.id), path.join(userRoot(dataDir, user.id), 'link-to-neighbour'));
  const ws = await connect();
  assert.deepStrictEqual((await search(ws, 'papaya')).results, []);
  ws.close();
});

test('a drive the account cannot read yields nothing', async () => {
  const ws = await connect();
  const { results } = await search(ws, 'a', 'not-a-drive');
  assert.deepStrictEqual(results, []);
  ws.close();
});

test('only signed-in, same-origin pages can open the socket', async () => {
  await assert.rejects(connect(new Client(server.base)), (e) => e.status === 401);
  await assert.rejects(connect(client, { origin: 'http://evil.example' }), (e) => e.status === 403);
  await assert.rejects(connect(client, { origin: `http://127.0.0.1:${server.port + 1}` }), (e) => e.status === 403);
});

test('an oversized or malformed message closes that socket and nothing else', async () => {
  const ws = await connect();
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send('x'.repeat(64 * 1024));
  assert.strictEqual(await closed, 1009);

  const ws2 = await connect();
  ws2.send('not json');
  ws2.send(JSON.stringify({ type: 'start_search', query: { $gt: '' } }));
  ws2.send(JSON.stringify(null));
  const ok = await search(ws2, 'report-alpha');
  assert.strictEqual(ok.results.length, 1);
  ws2.close();
  assert.strictEqual((await client.get('/api/auth-status')).json().loggedIn, true, 'server still healthy');
});
