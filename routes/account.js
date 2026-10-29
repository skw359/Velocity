// The signed-in account's own settings, and the owner's account administration.

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const logger = require('../logger');
const userStore = require('../user-store');
const shareStore = require('../share-store');
const drives = require('../drives');
const auth = require('../auth');

const DRIVE_MODES = ['none', 'ro', 'rw'];

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 1024) return 'Password is too long.';
  return null;
}

module.exports = function accountRoutes({ sessionStore }) {
  const router = express.Router();

  // Requires the current password, so a borrowed session can't lock the real owner out.
  // Every other session of the account is signed out; this one stays.
  router.post('/account/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: 'weak_password', message: `New ${problem.charAt(0).toLowerCase()}${problem.slice(1)}` });
    const ok = typeof currentPassword === 'string'
      && await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!ok) {
      await new Promise(r => setTimeout(r, 300));
      return res.status(401).json({ error: 'wrong_password', message: 'Current password is incorrect.' });
    }
    userStore.setPassword(req.user.id, await bcrypt.hash(newPassword, auth.BCRYPT_COST));
    const ended = sessionStore.destroyUserSessions(req.user.id, req.sessionID);
    logger.info(`[Account] '${req.user.username}' changed their password; ${ended} other session(s) signed out [IP: ${req.ip}]`);
    res.json({ ok: true, signedOutSessions: ended });
  });

  router.get('/admin/users', auth.requireOwner, (req, res) => {
    res.json({ accounts: userStore.list().map(userStore.publicShape), signupOpen: config.SIGNUP_MODE === 'open' });
  });

  // How the owner adds people while sign-up is closed (the default).
  router.post('/admin/users', auth.requireOwner, async (req, res) => {
    const { username, password, externalDrives } = req.body || {};
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
    const nameErr = userStore.validateUsername(username);
    if (nameErr) return res.status(400).json({ error: 'invalid_username', message: nameErr });
    const mode = DRIVE_MODES.includes(externalDrives) ? externalDrives : 'ro';

    let user;
    try {
      user = userStore.create({ username, passwordHash: await bcrypt.hash(password, auth.BCRYPT_COST), role: 'user', externalDrives: mode });
    } catch (e) {
      if (e.message === 'username_taken') return res.status(409).json({ error: 'username_taken', message: 'That username is already taken.' });
      logger.error(`[Admin] Account creation failed: ${e.message}`);
      return res.status(500).json({ error: 'create_failed', message: 'Could not create the account.' });
    }
    try {
      fs.mkdirSync(drives.userRootById(user.id), { recursive: true });
    } catch (e) {
      userStore.remove(user.id);
      logger.error(`[Admin] Could not create storage root for '${user.username}': ${e.message}`);
      return res.status(500).json({ error: 'storage_init_failed', message: 'Could not create storage for the account.' });
    }
    logger.info(`[Admin] '${req.user.username}' created account '${user.username}' (externalDrives=${mode}) [IP: ${req.ip}]`);
    res.status(201).json({ account: userStore.publicShape(user) });
  });

  // Needs no old password, which is why it is owner-only. Signs the account out everywhere
  // (except the owner's own session when resetting their own password).
  router.post('/admin/users/:id/password', auth.requireOwner, async (req, res) => {
    const { newPassword } = req.body || {};
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: 'weak_password', message: problem });
    const target = userStore.getById(req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    userStore.setPassword(target.id, await bcrypt.hash(newPassword, auth.BCRYPT_COST));
    const ended = sessionStore.destroyUserSessions(target.id, target.id === req.user.id ? req.sessionID : '');
    logger.info(`[Admin] '${req.user.username}' reset the password for '${target.username}'; ${ended} session(s) signed out [IP: ${req.ip}]`);
    res.json({ ok: true });
  });

  // requireLogin re-reads the account per request, so suspension ends open sessions immediately.
  router.post('/admin/users/:id/status', auth.requireOwner, (req, res) => {
    const status = req.body && req.body.status === 'active' ? 'active' : 'suspended';
    const target = userStore.getById(req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role === 'owner') return res.status(400).json({ error: 'cannot_suspend_owner' });
    const updated = userStore.setStatus(target.id, status);
    if (status === 'suspended') sessionStore.destroyUserSessions(target.id);
    logger.info(`[Admin] '${req.user.username}' set status=${status} for '${target.username}' [IP: ${req.ip}]`);
    res.json({ account: userStore.publicShape(updated) });
  });

  router.post('/admin/users/:id/drives', auth.requireOwner, (req, res) => {
    const mode = DRIVE_MODES.includes(req.body && req.body.externalDrives) ? req.body.externalDrives : 'ro';
    const target = userStore.getById(req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    const updated = userStore.setExternalDrives(target.id, mode);
    logger.info(`[Admin] '${req.user.username}' set externalDrives=${mode} for '${target.username}' [IP: ${req.ip}]`);
    res.json({ account: userStore.publicShape(updated) });
  });

  // Removing the files is irreversible, so it is opt-in (?deleteFiles=1).
  router.delete('/admin/users/:id', auth.requireOwner, async (req, res) => {
    const target = userStore.getById(req.params.id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role === 'owner') return res.status(400).json({ error: 'cannot_delete_owner' });

    const deleteFiles = req.query.deleteFiles === '1' || req.query.deleteFiles === 'true';
    for (const rec of shareStore.listByOwner(target.id)) shareStore.remove(rec.token);
    userStore.remove(target.id);
    sessionStore.destroyUserSessions(target.id);
    if (deleteFiles) {
      const root = drives.userRootById(target.id);
      if (root) {
        await fs.promises.rm(root, { recursive: true, force: true }).catch((e) => {
          logger.error(`[Admin] Could not remove storage for '${target.username}': ${e.message}`);
        });
      }
    }
    logger.info(`[Admin] '${req.user.username}' deleted account '${target.username}'${deleteFiles ? ' and its files' : ' (files kept)'} [IP: ${req.ip}]`);
    res.json({ ok: true, filesDeleted: deleteFiles });
  });

  return router;
};
