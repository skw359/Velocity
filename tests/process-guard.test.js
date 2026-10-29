// What an error that escapes everything does to the process (review finding L1).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { isOperationalError } = require('../process-guard');

const GUARD = JSON.stringify(path.join(__dirname, '..', 'process-guard.js'));

// Runs `body` in a child that has the guards installed; onFatal exits with code 70.
function runGuarded(body) {
  const script = `
    const { installProcessGuards } = require(${GUARD});
    const logger = { error: (m) => console.log('LOG ' + m.split('\\n')[0]) };
    installProcessGuards({ logger, onFatal: (kind) => { console.log('FATAL ' + kind); process.exit(70); } });
    ${body}
  `;
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
}

test('a stray I/O error event is logged and the process carries on', () => {
  const r = runGuarded(`
    const { EventEmitter } = require('events');
    const err = Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY', syscall: 'open' });
    setTimeout(() => new EventEmitter().emit('error', err), 10);
    setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 200);
  `);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Operational error, continuing/);
  assert.match(r.stdout, /ALIVE/);
});

test('a programming error shuts the process down with a failure code', () => {
  const r = runGuarded(`
    setTimeout(() => { null.boom(); }, 10);
    setTimeout(() => { console.log('STILL RUNNING'); process.exit(0); }, 2000);
  `);
  assert.strictEqual(r.status, 70, r.stdout + r.stderr);
  assert.match(r.stdout, /FATAL UncaughtException/);
  assert.doesNotMatch(r.stdout, /STILL RUNNING/);
});

test('an unhandled rejection is fatal unless it is an operational I/O failure', () => {
  const tolerated = runGuarded(`
    require('fs').promises.readFile('/definitely/not/here-${process.pid}');
    setTimeout(() => { console.log('ALIVE'); process.exit(0); }, 300);
  `);
  assert.strictEqual(tolerated.status, 0, tolerated.stdout + tolerated.stderr);
  const fatal = runGuarded(`Promise.reject(new RangeError('invariant broken'));`);
  assert.strictEqual(fatal.status, 70, fatal.stdout + fatal.stderr);
  assert.match(fatal.stdout, /FATAL UnhandledRejection/);
});

test('only system-call failures count as operational', () => {
  assert.strictEqual(isOperationalError(Object.assign(new Error('x'), { code: 'ECONNRESET', syscall: 'read' })), true);
  assert.strictEqual(isOperationalError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), false);
  assert.strictEqual(isOperationalError(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE', syscall: 'open' })), false);
  assert.strictEqual(isOperationalError(new TypeError('x')), false);
  assert.strictEqual(isOperationalError(null), false);
});

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Windows can't deliver SIGTERM to a child (kill() terminates it outright).
test('server.js shuts down cleanly on SIGTERM', { skip: process.platform === 'win32' && 'no POSIX signals on Windows' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velocity-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, VELOCITY_DATA_DIR: dataDir, PORT: String(port), VELOCITY_HOST: '127.0.0.1', VELOCITY_LOG_LEVEL: 'info', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 200 && !/Ready, serving/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /Ready, serving/);
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    assert.strictEqual(await exited, 0, out);
    assert.match(out, /closed operation store/);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
