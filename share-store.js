// access: 'restricted' opens only for the owner's session; 'public' for anyone with the link.
// One share per (owner, drive, path, name). The owner is in the key so two accounts sharing
// the same relative path can't collapse onto one token and manage each other's link.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const STORE_FILE = path.join(__dirname, 'shares.json');

// token -> share record
const shares = new Map();

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      const list = Array.isArray(data) ? data : (data.shares || []);
      for (const rec of list) {
        if (rec && rec.token) shares.set(rec.token, rec);
      }
      const orphans = [...shares.values()].filter((r) => !r.ownerId).length;
      logger.info(`[Shares] Loaded ${shares.size} share link(s)${orphans ? ` (${orphans} without an owner)` : ''}.`);
    }
  } catch (err) {
    logger.error(`[Shares] Failed to load store, starting empty: ${err.message}`);
  }
}

// tmp + rename so a crash mid-write can't truncate the store.
function persist() {
  try {
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...shares.values()], null, 2));
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    logger.error(`[Shares] Failed to persist store: ${err.message}`);
  }
}

function targetKey(ownerId, drive, p, name) {
  const cleanPath = '/' + String(p == null ? '/' : p).replace(/^\/+|\/+$/g, '');
  return `${ownerId || '-'}::${drive || 'internal'}::${cleanPath}::${name}`;
}

function findByTarget(ownerId, drive, p, name) {
  const key = targetKey(ownerId, drive, p, name);
  for (const rec of shares.values()) {
    if (targetKey(rec.ownerId, rec.drive, rec.path, rec.name) === key) return rec;
  }
  return null;
}

function get(token) {
  return shares.get(token) || null;
}

// A record with no ownerId (pre-migration) is deliberately unmanageable rather than manageable-by-anyone.
function isOwner(rec, userId) {
  return !!(rec && userId && rec.ownerId === userId);
}

function listByOwner(ownerId) {
  return [...shares.values()].filter((r) => r.ownerId === ownerId);
}

function create({ ownerId, name, path: p, drive, type, access }) {
  const existing = findByTarget(ownerId, drive, p, name);
  if (existing) return existing;
  const token = crypto.randomBytes(16).toString('hex');
  const rec = {
    token,
    ownerId: ownerId || null,
    name,
    path: p == null ? '/' : p,
    drive: drive || 'internal',
    type: type === 'folder' ? 'folder' : 'file',
    access: access === 'public' ? 'public' : 'restricted',
    createdAt: new Date().toISOString(),
  };
  shares.set(token, rec);
  persist();
  return rec;
}

function setAccess(token, access) {
  const rec = shares.get(token);
  if (!rec) return null;
  rec.access = access === 'public' ? 'public' : 'restricted';
  persist();
  return rec;
}

function remove(token) {
  const ok = shares.delete(token);
  if (ok) persist();
  return ok;
}

load();

module.exports = {
  get, create, findByTarget, setAccess, remove,
  isOwner, listByOwner,
};
