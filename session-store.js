// express-session store on the shared SQLite handle (either driver). Sessions survive a
// restart, idle ones expire, and memory no longer grows with every visitor. The account
// id is kept beside each session so a password change can sign that account out elsewhere.

const session = require('express-session');
const { db } = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    userId TEXT,
    data TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expiresAt);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (userId);
`);

const DAY_MS = 24 * 60 * 60 * 1000;
// The cookie itself lasts until the browser closes; on the server an unused session is
// forgotten after this long.
const IDLE_TTL_MS = 7 * DAY_MS;
// Every request touches its session; the stored expiry is rewritten at most this often.
const TOUCH_GRANULARITY_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const stmts = {
  get: db.prepare('SELECT data, expiresAt FROM sessions WHERE sid = ?'),
  upsert: db.prepare(`
    INSERT INTO sessions (sid, userId, data, expiresAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET userId = excluded.userId, data = excluded.data, expiresAt = excluded.expiresAt`),
  touch: db.prepare('UPDATE sessions SET expiresAt = ? WHERE sid = ? AND expiresAt < ?'),
  destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  destroyUser: db.prepare('DELETE FROM sessions WHERE userId = ? AND sid != ?'),
  sweep: db.prepare('DELETE FROM sessions WHERE expiresAt <= ?'),
  count: db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE expiresAt > ?'),
  clear: db.prepare('DELETE FROM sessions'),
};

class SqliteSessionStore extends session.Store {
  constructor({ idleTtlMs = IDLE_TTL_MS } = {}) {
    super();
    this.idleTtlMs = idleTtlMs;
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  expiryFor(sess) {
    const fromCookie = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : NaN;
    return Number.isFinite(fromCookie) ? fromCookie : Date.now() + this.idleTtlMs;
  }

  get(sid, cb) {
    let row;
    try {
      row = stmts.get.get(sid);
    } catch (e) {
      return cb(e);
    }
    if (!row || row.expiresAt <= Date.now()) return cb(null, null);
    try {
      return cb(null, JSON.parse(row.data));
    } catch {
      // A corrupt row is a lost session, not a server error.
      this.destroy(sid, () => {});
      return cb(null, null);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      stmts.upsert.run(sid, typeof sess.userId === 'string' ? sess.userId : null, JSON.stringify(sess), this.expiryFor(sess));
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  touch(sid, sess, cb = () => {}) {
    const expiresAt = this.expiryFor(sess);
    try {
      stmts.touch.run(expiresAt, sid, expiresAt - TOUCH_GRANULARITY_MS);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      stmts.destroy.run(sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  // Signs an account out everywhere except, optionally, the session making the change.
  destroyUserSessions(userId, exceptSid = '') {
    const r = stmts.destroyUser.run(userId, exceptSid || '');
    return r.changes || 0;
  }

  length(cb) {
    try { cb(null, stmts.count.get(Date.now()).c); } catch (e) { cb(e); }
  }

  clear(cb = () => {}) {
    try { stmts.clear.run(); cb(null); } catch (e) { cb(e); }
  }

  sweep() {
    try {
      const r = stmts.sweep.run(Date.now());
      if (r.changes) logger.info(`[Sessions] Removed ${r.changes} expired session(s).`);
    } catch (e) {
      logger.warn(`[Sessions] Sweep failed: ${e.message}`);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}

module.exports = SqliteSessionStore;
