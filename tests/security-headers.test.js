const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { isolate, cleanup, startServer, Client, signup, userRoot } = require('./support/harness');

const dataDir = isolate();
let server;
let client;
let user;

before(async () => {
  server = await startServer();
  client = new Client(server.base);
  user = await signup(client, 'headeruser');
  const root = userRoot(dataDir, user.id);
  fs.writeFileSync(path.join(root, 'page.html'), '<script>fetch("/api/admin/users")</script>');
  fs.writeFileSync(path.join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(root, 'feed.xml'), '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'plain words');
  fs.writeFileSync(path.join(root, 'doc.pdf'), '%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(root, 'noext'), 'mystery');
  fs.writeFileSync(path.join(root, '.hidden'), 'dot');
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'folder', 'index.html'), '<h1>index</h1>');
  await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toFile(path.join(root, 'photo.png'));
});

after(async () => {
  await server.close();
  cleanup(dataDir);
});

function csp(res) {
  return String(res.headers['content-security-policy'] || '');
}

describe('application responses', () => {
  test('carry a restrictive CSP and the standard protective headers', async () => {
    const res = await client.get('/api/auth/bootstrap');
    const policy = csp(res);
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.match(policy, /base-uri 'self'/);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(res.headers['x-powered-by'], undefined);
  });

  test('HSTS and upgrade-insecure-requests are sent only over HTTPS', async () => {
    const plain = await client.get('/api/auth/bootstrap');
    assert.strictEqual(plain.headers['strict-transport-security'], undefined);
    assert.doesNotMatch(csp(plain), /upgrade-insecure-requests/);
    const tls = await client.get('/api/auth/bootstrap', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(String(tls.headers['strict-transport-security']), /max-age=\d+/);
    assert.match(csp(tls), /upgrade-insecure-requests/);
  });

  test('server errors are generic JSON, never a stack trace', async () => {
    const res = await client.post('/api/operations', { body: '{"type":', headers: { 'content-type': 'application/json' } });
    assert.strictEqual(res.status, 400);
    assert.doesNotMatch(res.text, /at .*\.js:\d+/);
  });
});

describe('user files on this origin', () => {
  for (const name of ['page.html', 'image.svg', 'feed.xml', 'noext']) {
    test(`${name} downloads instead of rendering, and could not run script anyway`, async () => {
      const res = await client.get(`/content/${name}`);
      assert.strictEqual(res.status, 200);
      assert.match(String(res.headers['content-disposition']), /^attachment/);
      assert.match(csp(res), /(^|; )sandbox($|;)/);
      assert.match(csp(res), /default-src 'none'/);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    });
  }

  test('images and plain text display inline, still sandboxed', async () => {
    for (const [name, type] of [['photo.png', /^image\/png/], ['notes.txt', /^text\/plain/]]) {
      const res = await client.get(`/content/${name}`);
      assert.strictEqual(res.status, 200);
      assert.match(String(res.headers['content-type']), type);
      assert.strictEqual(res.headers['content-disposition'], undefined, name);
      assert.match(csp(res), /sandbox/);
    }
  });

  test('a PDF displays inline without a sandbox policy (the browser viewer is already isolated)', async () => {
    const res = await client.get('/content/doc.pdf');
    assert.strictEqual(res.status, 200);
    assert.match(String(res.headers['content-type']), /^application\/pdf/);
    assert.strictEqual(res.headers['content-disposition'], undefined);
    assert.strictEqual(res.headers['content-security-policy'], undefined);
  });

  test('ranges work, so media can be scrubbed', async () => {
    const res = await client.get('/content/notes.txt', { headers: { range: 'bytes=0-4' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.text, 'plain');
    assert.match(String(res.headers['content-range']), /^bytes 0-4\/11/);
  });

  test('folders, dotfiles, traversal and bad encodings are not served', async () => {
    assert.strictEqual((await client.get('/content/folder/')).status, 404);
    assert.strictEqual((await client.get('/content/folder')).status, 404);
    assert.strictEqual((await client.get('/content/.hidden')).status, 404);
    for (const attempt of ['/content/..%2f..%2f..%2foperations.db', '/content/%2e%2e/%2e%2e/%2e%2e/operations.db', '/content/../../../operations.db', '/content/..%5c..%5c..%5coperations.db']) {
      const res = await client.get(attempt, { rawPath: true });
      assert.strictEqual(res.status, 404, attempt);
      assert.doesNotMatch(res.text, /SQLite/);
    }
    assert.strictEqual((await client.get('/content/%E0%A4%A')).status, 400);
    assert.strictEqual((await client.post('/content/notes.txt')).status, 405);
    assert.strictEqual((await new Client(server.base).get('/content/notes.txt')).status, 302, 'login required');
  });

  test('a public share serves HTML as a download too', async () => {
    const created = await client.post('/api/share', { form: { name: 'page.html', path: '/', drive: 'internal' } });
    const { token } = created.json().share;
    await client.put(`/api/share/${token}`, { json: { access: 'public' } });
    const anon = new Client(server.base);
    const raw = await anon.get(`/api/public/share/${token}/raw`);
    assert.strictEqual(raw.status, 200);
    assert.match(String(raw.headers['content-disposition']), /^attachment/);
    assert.match(csp(raw), /sandbox/);
    // Public links may be embedded elsewhere; everything else stays same-origin.
    assert.strictEqual(raw.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.strictEqual((await client.get('/content/notes.txt')).headers['cross-origin-resource-policy'], 'same-origin');
  });
});

describe('requests made by other sites', () => {
  const folder = (name) => ({ form: { folder: name, path: '/', drive: 'internal' } });
  const exists = (name) => fs.existsSync(path.join(userRoot(dataDir, user.id), name));

  test('a cross-site state change is refused, whichever header reveals it', async () => {
    const cases = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' }, // another port on this host is the "same site"
      { origin: 'http://evil.example' },
      { origin: 'null' },
      { origin: `http://127.0.0.1:${server.port + 1}` },
    ];
    for (const [i, headers] of cases.entries()) {
      const res = await client.post('/api/create-folder', { ...folder(`csrf${i}`), headers });
      assert.strictEqual(res.status, 403, JSON.stringify(headers));
      assert.strictEqual(res.json().error, 'cross_site_request');
      assert.ok(!exists(`csrf${i}`));
    }
  });

  test('same-origin browser requests, proxied hosts and non-browser clients pass', async () => {
    const ok = [
      { 'sec-fetch-site': 'same-origin' },
      { origin: server.base },
      { origin: 'https://files.example.com', 'x-forwarded-host': 'files.example.com' },
      {},
    ];
    for (const [i, headers] of ok.entries()) {
      const res = await client.post('/api/create-folder', { ...folder(`ok${i}`), headers });
      assert.strictEqual(res.status, 201, `${JSON.stringify(headers)}: ${res.text}`);
      assert.ok(exists(`ok${i}`));
    }
  });

  test('sign-in from another site is refused (login CSRF)', async () => {
    const res = await new Client(server.base).post('/login', {
      body: 'username=headeruser&password=password123',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
    });
    assert.strictEqual(res.status, 403);
  });

  test('reads are not affected', async () => {
    const res = await client.get('/api/list?path=/', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.strictEqual(res.status, 200);
  });
});
