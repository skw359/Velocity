// Settings that change authentication behaviour: open sign-up and an untrusted proxy chain.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { isolate, cleanup, startServer, Client, signup } = require('./support/harness');

const dataDir = isolate({ VELOCITY_SIGNUP: 'open', VELOCITY_TRUST_PROXY: 'false' });
let server;

before(async () => { server = await startServer(); });
after(async () => {
  await server.close();
  cleanup(dataDir);
});

test('config parses the proxy and cookie settings', () => {
  const config = require('../config');
  assert.strictEqual(config.TRUST_PROXY, false);
  assert.strictEqual(config.SECURE_COOKIES, 'auto');
  assert.strictEqual(config.SIGNUP_MODE, 'open');
});

test('with VELOCITY_SIGNUP=open, later visitors can create ordinary accounts', async () => {
  const owner = await signup(new Client(server.base), 'theowner');
  assert.strictEqual(owner.role, 'owner');
  const boot = (await new Client(server.base).get('/api/auth/bootstrap')).json();
  assert.deepStrictEqual(boot, { hasUsers: true, signupOpen: true });
  const second = await signup(new Client(server.base), 'visitor');
  assert.strictEqual(second.role, 'user');
  assert.strictEqual(second.externalDrives, 'ro');
});

test('an untrusted X-Forwarded-For cannot dodge the login throttle', async () => {
  let res;
  for (let i = 0; i < 10; i++) {
    res = await new Client(server.base).post('/login', {
      body: `username=theowner&password=wrong${i}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.113.${i}` },
    });
    assert.strictEqual(res.status, 401);
  }
  res = await new Client(server.base).post('/login', {
    body: 'username=theowner&password=password123',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7' },
  });
  assert.strictEqual(res.status, 429);
});

test('an untrusted X-Forwarded-Proto does not mark the cookie Secure', async () => {
  // Fresh process state would be needed for a successful login here (the throttle above
  // blocks this address), so check sign-up, which also opens a session.
  const res = await new Client(server.base).post('/api/signup', {
    json: { username: 'protocheck', password: 'password123' },
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.strictEqual(res.status, 200, res.text);
  const line = [].concat(res.headers['set-cookie']).find((l) => l.startsWith('velocity.sid='));
  assert.doesNotMatch(line, /; Secure/i);
});
