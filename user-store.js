// role: 'owner' for an install's first account, which administers the others; 'user' after.
// id doubles as the storage namespace (content/u/<id>/), so it is deliberately not the username.

const { db, tx, now, genId } = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    usernameLower TEXT NOT NULL,
    passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    externalDrives TEXT NOT NULL DEFAULT 'ro',
    createdAt TEXT,
    lastLoginAt TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower ON users (usernameLower);
`);

// Names that clash with the app's routes or imply authority the account may not have.
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'owner', 'system', 'velocity',
  'api', 'app', 'login', 'logout', 'signup', 'share', 'shares',
  'content', 'drive', 'drives', 'assets', 'public', 'cache', 'u',
]);

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/i;

// Returns null when valid, otherwise a short reason safe to show the user.
function validateUsername(name) {
  if (typeof name !== 'string') return 'Username is required.';
  const t = name.trim();
  if (t.length < 3) return 'Username must be at least 3 characters.';
  if (t.length > 32) return 'Username must be at most 32 characters.';
  if (!USERNAME_RE.test(t)) {
    return 'Use letters, numbers, dot, dash or underscore; start and end with a letter or number.';
  }
  if (RESERVED.has(t.toLowerCase())) return 'That username is reserved.';
  return null;
}

const ALL = `id,username,usernameLower,passwordHash,role,status,externalDrives,createdAt,lastLoginAt`;

const insertUser = db.prepare(`
  INSERT INTO users (${ALL})
  VALUES (@id,@username,@usernameLower,@passwordHash,@role,@status,@externalDrives,@createdAt,@lastLoginAt)
`);
const selById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const selByLower = db.prepare(`SELECT * FROM users WHERE usernameLower = ?`);
const selAll = db.prepare(`SELECT * FROM users ORDER BY createdAt ASC`);
const countAll = db.prepare(`SELECT COUNT(*) AS c FROM users`);

// Safe to hand to a client: deliberately omits passwordHash.
function publicShape(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    status: u.status,
    externalDrives: u.externalDrives,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

function count() {
  return countAll.get().c;
}

function getById(id) {
  if (typeof id !== 'string' || !id) return null;
  return selById.get(id) || null;
}

function getByUsername(username) {
  if (typeof username !== 'string' || !username) return null;
  return selByLower.get(username.trim().toLowerCase()) || null;
}

function list() {
  return selAll.all();
}

// The UNIQUE index is the arbiter, so two simultaneous signups for one name can't both win.
const createTxn = tx((row) => { insertUser.run(row); });

function create({ username, passwordHash, role = 'user', externalDrives = 'ro', id }) {
  const bad = validateUsername(username);
  if (bad) throw new Error(bad);
  const t = username.trim();
  const row = {
    id: id || genId(),
    username: t,
    usernameLower: t.toLowerCase(),
    passwordHash,
    role,
    status: 'active',
    externalDrives,
    createdAt: now(),
    lastLoginAt: null,
  };
  try {
    createTxn(row);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e.message)) throw new Error('username_taken');
    throw e;
  }
  logger.info(`[Users] Created account '${t}' (${row.id}) role=${role} externalDrives=${externalDrives}`);
  return getById(row.id);
}

// Used by both self-service change and owner reset: the caller must check the credential.
function setPassword(id, passwordHash) {
  const cur = getById(id);
  if (!cur) return null;
  db.prepare(`UPDATE users SET passwordHash = ? WHERE id = ?`).run(passwordHash, id);
  return getById(id);
}

function touchLogin(id) {
  db.prepare(`UPDATE users SET lastLoginAt = ? WHERE id = ?`).run(now(), id);
}

function setStatus(id, status) {
  db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, id);
  return getById(id);
}

function setExternalDrives(id, mode) {
  db.prepare(`UPDATE users SET externalDrives = ? WHERE id = ?`).run(mode, id);
  return getById(id);
}

function remove(id) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

module.exports = {
  validateUsername,
  publicShape,
  count,
  getById,
  getByUsername,
  list,
  create,
  setPassword,
  touchLogin,
  setStatus,
  setExternalDrives,
  remove,
};
