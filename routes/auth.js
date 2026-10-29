// Sign-in, sign-out and sign-up: the routes that work without a session.

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const logger = require('../logger');
const userStore = require('../user-store');
const drives = require('../drives');
const auth = require('../auth');
const { isCrossSite } = require('../security');

const smallForm = express.urlencoded({ extended: false, limit: '16kb' });
const smallJson = express.json({ limit: '16kb' });

function signupOpen() {
  return userStore.count() === 0 || config.SIGNUP_MODE === 'open';
}

module.exports = function authRoutes({ spaIndex }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    if (req.session.loggedIn) return res.redirect('/app');
    res.sendFile(spaIndex);
  });

  router.post('/login', smallForm, async (req, res) => {
    const { username, password } = req.body || {};
    if (auth.isThrottled(req, 'login')) {
      logger.warn(`Throttled login attempt for '${username}' from IP: ${req.ip}`);
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
    }
    const user = typeof username === 'string' ? userStore.getByUsername(username) : null;
    // Always compare once, so a wrong username is not faster than a wrong password.
    const hash = user ? user.passwordHash : auth.DUMMY_HASH;
    const matches = typeof password === 'string' && await bcrypt.compare(password, hash);
    const valid = !!user && matches && user.status === 'active';
    if (valid) {
      try {
        await auth.establishSession(req, user);
      } catch (e) {
        logger.error(`[Auth] Session establishment failed for '${user.username}': ${e.message}`);
        return res.status(500).json({ error: 'session_failed' });
      }
      userStore.touchLogin(user.id);
      auth.clearAuthFailures(req, 'login');
      logger.info(`Successful login for user: '${user.username}' from IP: ${req.ip}`);
      res.json({ success: true, user: userStore.publicShape(user) });
    } else {
      auth.noteAuthFailure(req, 'login');
      logger.warn(`Failed login attempt for user: '${username}' from IP: ${req.ip}`);
      await new Promise(r => setTimeout(r, 300));
      res.status(401).json({ error: 'Login failed with provided credentials.' });
    }
  });

  router.get('/mainpage.html', auth.requireLogin, (req, res) => {
    res.redirect('/app');
  });

  router.get('/app', auth.requireLogin, (req, res) => {
    res.sendFile(spaIndex);
  });

  // A link, so it stays a GET; a navigation started by another site doesn't sign anyone out.
  router.get('/logout', (req, res) => {
    if (isCrossSite(req.headers)) return res.redirect('/');
    const user = req.session.user;
    if (!req.session.loggedIn) {
      auth.clearSessionCookie(res);
      return res.redirect('/');
    }
    req.session.destroy(err => {
      if (err) {
        logger.error(`Error during session destruction for user '${user}': ${err.message}`);
        return res.status(500).send('Could not log out.');
      }
      logger.info(`User '${user}' logged out successfully.`);
      auth.clearSessionCookie(res);
      res.redirect('/');
    });
  });

  router.get('/api/auth-status', (req, res) => {
    const u = auth.sessionUser(req.session);
    if (!u) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user: userStore.publicShape(u) });
  });

  // Lets the login page send a fresh install's first visitor straight to signup, and hide
  // the sign-up link when only the owner can add accounts.
  router.get('/api/auth/bootstrap', (req, res) => {
    res.json({ hasUsers: userStore.count() > 0, signupOpen: signupOpen() });
  });

  // The first account becomes the owner. After that, sign-up is open only with
  // VELOCITY_SIGNUP=open; otherwise the owner adds accounts from Settings.
  router.post('/api/signup', smallJson, async (req, res) => {
    if (auth.isThrottled(req, 'signup')) {
      return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
    }
    // Every attempt counts, successful or not, so one address can't mass-create accounts.
    auth.noteAuthFailure(req, 'signup');

    const closed = { error: 'signup_closed', message: 'Sign-up is turned off on this server. Ask its owner to create an account for you.' };
    if (!signupOpen()) return res.status(403).json(closed);

    const { username, password } = req.body || {};
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
    }
    if (password.length > 1024) {
      return res.status(400).json({ error: 'weak_password', message: 'Password is too long.' });
    }
    const nameErr = userStore.validateUsername(username);
    if (nameErr) return res.status(400).json({ error: 'invalid_username', message: nameErr });

    const passwordHash = await bcrypt.hash(password, auth.BCRYPT_COST);

    // Decided after the hash, with no await before the insert: two simultaneous first
    // sign-ups can't both become the owner, and a closed server can't gain a second account.
    const firstAccount = userStore.count() === 0;
    if (!firstAccount && config.SIGNUP_MODE !== 'open') return res.status(403).json(closed);

    let user;
    try {
      user = userStore.create({
        username,
        passwordHash,
        role: firstAccount ? 'owner' : 'user',
        // Later accounts get read-only external drives until the owner changes it.
        externalDrives: firstAccount ? 'rw' : 'ro',
      });
    } catch (e) {
      if (e.message === 'username_taken') return res.status(409).json({ error: 'username_taken' });
      logger.error(`[Signup] Account creation failed: ${e.message}`);
      return res.status(500).json({ error: 'create_failed' });
    }

    // Created up front so the first listing is an empty folder, not a 404.
    try {
      fs.mkdirSync(drives.userRootById(user.id), { recursive: true });
    } catch (e) {
      userStore.remove(user.id);
      logger.error(`[Signup] Could not create storage root for '${user.username}': ${e.message}`);
      return res.status(500).json({ error: 'storage_init_failed' });
    }

    try {
      await auth.establishSession(req, user);
    } catch (e) {
      logger.error(`[Signup] Session establishment failed for '${user.username}': ${e.message}`);
      return res.status(500).json({ error: 'session_failed' });
    }
    userStore.touchLogin(user.id);
    logger.info(`[Signup] Account '${user.username}' created (${user.role}) [IP: ${req.ip}]`);
    res.json({ ok: true, user: userStore.publicShape(user) });
  });

  return router;
};
