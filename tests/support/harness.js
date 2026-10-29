// Test harness: every test file gets its own temporary data directory and a real server on
// an ephemeral port. isolate() must run before any app module is required, because
// config.js reads the environment once.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const SETTINGS = [
  'VELOCITY_DATA_DIR', 'VELOCITY_LOG_DIR', 'OPERATIONS_DB', 'VELOCITY_SESSION_SECRET',
  'VELOCITY_SIGNUP', 'VELOCITY_TRUST_PROXY', 'VELOCITY_SECURE_COOKIES', 'VELOCITY_HOST',
  'VELOCITY_EXTERNAL_DRIVES', 'VELOCITY_LOG_MAX_SIZE_MB', 'VELOCITY_LOG_MAX_FILES',
];

function isolate(env = {}) {
  const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'velocity-test-')));
  // Nothing inherited from the developer's shell may point a test at real data.
  for (const key of SETTINGS) delete process.env[key];
  Object.assign(process.env, {
    VELOCITY_DATA_DIR: dataDir,
    VELOCITY_LOG_LEVEL: process.env.VELOCITY_TEST_LOG_LEVEL || 'silent',
    NO_COLOR: '1',
    ...env,
  });
  const config = require('../../config');
  assert.ok(config.DATA_DIR.startsWith(fs.realpathSync.native(os.tmpdir())), `refusing to run outside the temp dir: ${config.DATA_DIR}`);
  assert.ok(config.DB_FILE.startsWith(dataDir), 'test database must live in the temp data dir');
  return dataDir;
}

function cleanup(dataDir) {
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort on Windows */ }
}

async function startServer() {
  const { createApp } = require('../../app');
  const instance = createApp();
  const { port } = await instance.listen(0, '127.0.0.1');
  return { instance, port, base: `http://127.0.0.1:${port}`, close: () => instance.close() };
}

function multipart(fields) {
  const boundary = `----velocitytest${Math.random().toString(16).slice(2)}`;
  const parts = Object.entries(fields).map(([k, v]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  return { body: Buffer.from(parts.join('') + `--${boundary}--\r\n`), contentType: `multipart/form-data; boundary=${boundary}` };
}

// A cookie-keeping HTTP client. Requests carry no Origin or Sec-Fetch-* headers unless a
// test adds them, like a non-browser client.
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // rawPath sends url exactly as written: the URL parser would resolve "%2e%2e" segments
  // before the server ever saw them.
  request(method, url, { json, form, body, headers = {}, rawHeaders = false, rawPath = false } = {}) {
    const parsed = new URL(url, this.base);
    const target = rawPath ? { hostname: parsed.hostname, port: parsed.port, path: url } : parsed;
    const h = { ...headers };
    let payload = body;
    if (json !== undefined) { payload = Buffer.from(JSON.stringify(json)); h['content-type'] = 'application/json'; }
    if (form !== undefined) { const mp = multipart(form); payload = mp.body; h['content-type'] = mp.contentType; }
    if (payload !== undefined && h['content-length'] === undefined && !rawHeaders) h['content-length'] = Buffer.byteLength(payload);
    const cookie = this.cookieHeader();
    if (cookie && h.cookie === undefined) h.cookie = cookie;
    return new Promise((resolve, reject) => {
      const onResponse = (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const line of [].concat(res.headers['set-cookie'] || [])) {
            const [pair] = line.split(';');
            const i = pair.indexOf('=');
            const name = pair.slice(0, i).trim();
            const value = pair.slice(i + 1).trim();
            if (/expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.cookies.delete(name);
            else this.cookies.set(name, value);
          }
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer,
            text,
            json: () => JSON.parse(text),
          });
        });
        res.on('error', reject);
      };
      // With an options object first, http.request takes the callback second.
      const req = rawPath
        ? http.request({ ...target, method, headers: h }, onResponse)
        : http.request(target, { method, headers: h }, onResponse);
      req.on('error', reject);
      if (payload !== undefined) req.end(payload);
      else req.end();
    });
  }

  get(url, opts) { return this.request('GET', url, opts); }
  post(url, opts) { return this.request('POST', url, opts); }
  put(url, opts) { return this.request('PUT', url, opts); }
  patch(url, opts) { return this.request('PATCH', url, opts); }
  delete(url, opts) { return this.request('DELETE', url, opts); }
}

async function signup(client, username, password = 'password123') {
  const res = await client.post('/api/signup', { json: { username, password } });
  assert.strictEqual(res.status, 200, `signup ${username}: ${res.status} ${res.text}`);
  return res.json().user;
}

async function login(client, username, password = 'password123') {
  const res = await client.post('/login', {
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.strictEqual(res.status, 200, `login ${username}: ${res.status} ${res.text}`);
  return res.json().user;
}

// The owner adds an account and a fresh client signs in as it.
async function addUser(ownerClient, base, username, { externalDrives = 'ro', password = 'password123' } = {}) {
  const res = await ownerClient.post('/api/admin/users', { json: { username, password, externalDrives } });
  assert.strictEqual(res.status, 201, `create ${username}: ${res.status} ${res.text}`);
  const client = new Client(base);
  const user = await login(client, username, password);
  return { client, user };
}

const CHUNK_SIZE = 10 * 1024 * 1024;

// Sends one chunk the way the browser client does.
function sendChunk(client, { name, relPath = name, dir = '/', drive = 'internal', index, total, size, data, opId = '', headers = {} }) {
  return client.post('/api/upload-chunk', {
    body: data,
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
      'x-relative-path': encodeURIComponent(relPath),
      'x-chunk-index': String(index),
      'x-total-chunks': String(total),
      'x-current-path': encodeURIComponent(dir),
      'x-total-file-size': String(size),
      'x-drive-id': encodeURIComponent(drive),
      'x-op-id': opId,
      ...headers,
    },
  });
}

// Uploads a whole buffer, chunk by chunk, and returns the last response.
async function uploadBuffer(client, { name, data, relPath = name, dir = '/', drive = 'internal', opId = '' }) {
  const total = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
  let res;
  for (let index = 0; index < total; index++) {
    const chunk = data.subarray(index * CHUNK_SIZE, Math.min(data.length, (index + 1) * CHUNK_SIZE));
    res = await sendChunk(client, { name, relPath, dir, drive, index, total, size: data.length, data: chunk, opId });
    if (res.status !== 200) return res;
  }
  return res;
}

function userRoot(dataDir, userId) {
  return path.join(dataDir, 'content', 'u', userId);
}

// Directory symlinks: a junction on Windows (no privilege needed), a symlink elsewhere.
function linkDir(target, linkPath) {
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

module.exports = {
  isolate, cleanup, startServer, Client, multipart,
  signup, login, addUser, sendChunk, uploadBuffer, userRoot, linkDir, CHUNK_SIZE,
};
