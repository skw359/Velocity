// Sessions, the login throttle and the guards every authenticated route goes through.

const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');
const config = require('./config');
const logger = require('./logger');
const userStore = require('./user-store');

const BCRYPT_COST = 12;
const SESSION_COOKIE = 'velocity.sid';

// SameSite=Lax keeps the cookie off cross-site subrequests and POSTs (stated explicitly,
// which also ends Chrome's two-minute Lax+POST allowance for cookies without the attribute).
// Secure follows config: 'auto' sets it whenever the request came in over HTTPS.
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', secure: config.SECURE_COOKIES, path: '/' };

// VELOCITY_SESSION_SECRET, else a random secret persisted next to the data so restarts
// (with sessions kept in the database) don't log everyone out.
function getSessionSecret() {
  if (config.SESSION_SECRET) return config.SESSION_SECRET;
  try {
    const existing = fs.readFileSync(config.SESSION_SECRET_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(config.SESSION_SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

// saveUninitialized: false, so a visitor who never signs in costs no stored session and
// gets no cookie.
function createSessionMiddleware(store) {
  return session({
    name: SESSION_COOKIE,
    secret: getSessionSecret(),
    store,
    resave: false,
    saveUninitialized: false,
    cookie: COOKIE_OPTIONS,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: COOKIE_OPTIONS.path, httpOnly: true, sameSite: COOKIE_OPTIONS.sameSite });
}

// Per-IP failure throttle for the unauthenticated /login and /api/signup. req.ip honours
// X-Forwarded-For only from proxies 'trust proxy' allows, so it can't be spoofed around.
const authAttempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 10;

function throttleKey(req, scope) {
  return `${scope}:${req.ip}`;
}

function isThrottled(req, scope) {
  const key = throttleKey(req, scope);
  const rec = authAttempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) { authAttempts.delete(key); return false; }
  return rec.count >= ATTEMPT_LIMIT;
}

function noteAuthFailure(req, scope) {
  const key = throttleKey(req, scope);
  const rec = authAttempts.get(key);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    authAttempts.set(key, { first: Date.now(), count: 1 });
  } else {
    rec.count++;
  }
  // Bound the map so a spray across many addresses cannot grow it without limit.
  if (authAttempts.size > 5000) {
    const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
    for (const [k, v] of authAttempts) if (v.first < cutoff) authAttempts.delete(k);
  }
}

function clearAuthFailures(req, scope) {
  authAttempts.delete(throttleKey(req, scope));
}

// A hash nobody holds, compared against for unknown usernames so timing doesn't reveal them.
const DUMMY_HASH = bcrypt.hashSync('velocity-nonexistent-account', BCRYPT_COST);

// Regenerates the session id to defeat fixation: an id planted before sign-in never
// becomes the signed-in session.
function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.loggedIn = true;
      req.session.userId = user.id;
      req.session.user = user.username;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

// The signed-in, active account for a request, or null. Re-read each time so deleting or
// suspending an account takes effect immediately.
function sessionUser(sess) {
  if (!sess || !sess.loggedIn || !sess.userId) return null;
  const user = userStore.getById(sess.userId);
  return user && user.status === 'active' ? user : null;
}

const requireLogin = (req, res, next) => {
  const user = sessionUser(req.session);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.session && req.session.loggedIn) req.session.destroy(() => {});
  logger.warn(`Unauthorized access attempt to ${req.originalUrl} from IP: ${req.ip}`);
  if (req.originalUrl.startsWith('/api/')) res.sendStatus(403);
  else res.redirect('/');
};

const requireOwner = (req, res, next) => {
  if (req.user && req.user.role === 'owner') return next();
  logger.warn(`[Admin] '${req.user && req.user.username}' denied owner action ${req.originalUrl} [IP: ${req.ip}]`);
  return res.status(403).json({ error: 'owner_only' });
};

module.exports = {
  BCRYPT_COST,
  SESSION_COOKIE,
  DUMMY_HASH,
  createSessionMiddleware,
  clearSessionCookie,
  isThrottled,
  noteAuthFailure,
  clearAuthFailures,
  establishSession,
  sessionUser,
  requireLogin,
  requireOwner,
};
