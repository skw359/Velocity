// One connection shared by every store on purpose: a second handle on the same WAL database
// just trades SQLITE_BUSY retries for no benefit. The node:sqlite fallback takes the same `?`/`@x` params.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

const DB_FILE = config.DB_FILE;
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

let db;
let driver;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  driver = 'better-sqlite3';
} catch (errBetter) {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  driver = 'node:sqlite';
  logger.warn(`[DB] better-sqlite3 unavailable (${errBetter.message}); using built-in node:sqlite.`);
}

// better-sqlite3 supports db.transaction; node:sqlite does not, so emulate.
function tx(fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn);
  return (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
}

// A repeated ADD COLUMN throws "duplicate column name"; ignoring it is the only portable
// way to do additive migrations across both drivers.
function migrate(statements) {
  for (const ddl of statements) {
    try { db.exec(ddl); } catch { /* already applied */ }
  }
}

const now = () => new Date().toISOString();
const genId = () => crypto.randomBytes(16).toString('hex');

function close() {
  try { db.close(); } catch { /* ignore */ }
}

module.exports = { db, driver, DB_FILE, tx, migrate, now, genId, close };
