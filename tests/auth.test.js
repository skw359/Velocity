const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { isolate, cleanup, startServer, Client, signup, login, addUser } = require('./support/harness');

const dataDir = isolate();
let server;

before(async () => { server = await startServer(); });
after(async () => {
  await server.close();
  cleanup(dataDir);
});

function sessionRows() {
  return require('../db').db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
}

function cookieLine(res) {
  return [].concat(res.headers['set-cookie'] || []).find((l) => l.startsWith('velocity.sid=')) || null;
}

let owner;
let ownerUser;

// Runs first, against an empty server.
test('two simultaneous first sign-ups produce exactly one owner', async () => {
  const a = new Client(server.base);
  const b = new Client(server.base);
  const [ra, rb] = await Promise.all([
    a.post('/api/signup', { json: { username: 'firsta', password: 'password123' } }),
    b.post('/api/signup', { json: { username: 'firstb', password: 'password123' } }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepStrictEqual(statuses, [200, 403], `${ra.text} / ${rb.text}`);
  const winner = ra.status === 200 ? ra : rb;
  assert.strictEqual(winner.json().user.role, 'owner');
  assert.strictEqual(require('../user-store').count(), 1);
  owner = ra.status === 200 ? a : b;
  ownerUser = winner.json().user;
});

test('visitors who never sign in get no session and no cookie', async () => {
  const anon = new Client(server.base);
  const rows = sessionRows();
  for (const url of ['/', '/api/auth/bootstrap', '/api/auth-status', '/signup', '/share/whatever']) {
    const res = await anon.get(url);
    assert.strictEqual(cookieLine(res), null, url);
  }
  assert.strictEqual(sessionRows(), rows);
});

test('the session cookie is HttpOnly and SameSite=Lax, and Secure only over HTTPS', async () => {
  const c = new Client(server.base);
  const res = await c.post('/login', { body: `username=${ownerUser.username}&password=password123`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(res.status, 200);
  const line = cookieLine(res);
  assert.match(line, /; HttpOnly/i);
  assert.match(line, /; SameSite=Lax/i);
  assert.match(line, /; Path=\//i);
  assert.doesNotMatch(line, /; Secure/i);

  // Behind a proxy on this machine that terminated HTTPS.
  const viaProxy = await new Client(server.base).post('/login', {
    body: `username=${ownerUser.username}&password=password123`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
  });
  assert.match(cookieLine(viaProxy), /; Secure/i);
});

test('signing in replaces the session id (fixation)', async () => {
  const other = await addUser(owner, server.base, 'fixvictim');
  const planted = new Client(server.base);
  await login(planted, ownerUser.username);
  const plantedCookie = planted.cookies.get('velocity.sid');
  // Someone holding that cookie signs in as another account: the id must change.
  await login(planted, other.user.username);
  assert.notStrictEqual(planted.cookies.get('velocity.sid'), plantedCookie);
  const stale = new Client(server.base);
  stale.cookies.set('velocity.sid', plantedCookie);
  assert.strictEqual((await stale.get('/api/auth-status')).json().loggedIn, false);
});

test('sessions survive a server restart', async () => {
  const c = new Client(server.base);
  await login(c, ownerUser.username);
  const cookie = c.cookies.get('velocity.sid');
  await server.close();
  server = await startServer();
  const again = new Client(server.base);
  again.cookies.set('velocity.sid', cookie);
  const status = (await again.get('/api/auth-status')).json();
  assert.strictEqual(status.loggedIn, true);
  assert.strictEqual(status.user.username, ownerUser.username);
  // The owner client from the first test now talks to the restarted server too.
  owner.base = server.base;
});

test('logout ends the session on the server and clears the cookie', async () => {
  const c = new Client(server.base);
  await login(c, ownerUser.username);
  const cookie = c.cookies.get('velocity.sid');
  const res = await c.get('/logout');
  assert.strictEqual(res.status, 302);
  assert.match(cookieLine(res), /velocity\.sid=;.*Expires=Thu, 01 Jan 1970/i);
  const replay = new Client(server.base);
  replay.cookies.set('velocity.sid', cookie);
  assert.strictEqual((await replay.get('/api/auth-status')).json().loggedIn, false);
});

test('a logout link followed from another site does not sign the user out', async () => {
  const c = new Client(server.base);
  await login(c, ownerUser.username);
  await c.get('/logout', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.strictEqual((await c.get('/api/auth-status')).json().loggedIn, true);
});

test('changing the password signs out every other session of the account', async () => {
  const { client: mine, user } = await addUser(owner, server.base, 'pwchanger', { password: 'oldpassword1' });
  const elsewhere = new Client(server.base);
  await login(elsewhere, user.username, 'oldpassword1');
  const res = await mine.post('/api/account/password', { json: { currentPassword: 'oldpassword1', newPassword: 'newpassword1' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json().signedOutSessions, 1);
  assert.strictEqual((await mine.get('/api/auth-status')).json().loggedIn, true, 'the session that changed it stays');
  assert.strictEqual((await elsewhere.get('/api/auth-status')).json().loggedIn, false);
  await login(new Client(server.base), user.username, 'newpassword1');
});

test("an owner's password reset and a suspension both end the account's sessions", async () => {
  const { client: victim, user } = await addUser(owner, server.base, 'resetme');
  assert.strictEqual((await owner.post(`/api/admin/users/${user.id}/password`, { json: { newPassword: 'brandnew123' } })).status, 200);
  assert.strictEqual((await victim.get('/api/list?path=/')).status, 403);

  const fresh = new Client(server.base);
  await login(fresh, user.username, 'brandnew123');
  assert.strictEqual((await owner.post(`/api/admin/users/${user.id}/status`, { json: { status: 'suspended' } })).status, 200);
  assert.strictEqual((await fresh.get('/api/list?path=/')).status, 403);
  await owner.post(`/api/admin/users/${user.id}/status`, { json: { status: 'active' } });
  // Reinstating doesn't revive the old session: the account signs in again.
  assert.strictEqual((await fresh.get('/api/auth-status')).json().loggedIn, false);
});

test('after the owner exists, sign-up is closed and the owner adds accounts', async () => {
  const boot = (await new Client(server.base).get('/api/auth/bootstrap')).json();
  assert.deepStrictEqual(boot, { hasUsers: true, signupOpen: false });
  const res = await new Client(server.base).post('/api/signup', { json: { username: 'intruder', password: 'password123' } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json().error, 'signup_closed');
  assert.strictEqual(require('../user-store').getByUsername('intruder'), null);

  const created = await addUser(owner, server.base, 'invited', { externalDrives: 'none' });
  assert.strictEqual(created.user.role, 'user');
  assert.strictEqual(created.user.externalDrives, 'none');
  // Non-owners can't add accounts.
  const denied = await created.client.post('/api/admin/users', { json: { username: 'sneaky', password: 'password123' } });
  assert.strictEqual(denied.status, 403);
  const dup = await owner.post('/api/admin/users', { json: { username: 'INVITED', password: 'password123' } });
  assert.strictEqual(dup.status, 409);
});

test('unknown API paths are JSON 404s for signed-in users, and 403 otherwise', async () => {
  assert.strictEqual((await owner.get('/api/nope')).status, 404);
  assert.strictEqual((await new Client(server.base).get('/api/nope')).status, 403);
});

test('pre-authentication bodies are small: a large login body is refused', async () => {
  const res = await new Client(server.base).post('/login', {
    body: `username=x&password=${'a'.repeat(64 * 1024)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.strictEqual(res.status, 413);
});

// Last: it locks this address out of /login for the rest of the file.
test('repeated failed logins from one address are throttled', async () => {
  const c = new Client(server.base);
  let res;
  for (let i = 0; i < 10; i++) {
    res = await c.post('/login', { body: `username=${ownerUser.username}&password=wrong${i}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(res.status, 401);
  }
  res = await c.post('/login', { body: `username=${ownerUser.username}&password=password123`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(res.status, 429, 'even the right password waits out the window');
});
