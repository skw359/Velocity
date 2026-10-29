// Long-running operations. The client derives progress from GET /operations, so it
// survives reloads and new tabs; the runner performs non-upload work and resumes it after
// a crash.

const fs = require('fs');
const path = require('path');
const express = require('express');
const logger = require('../logger');
const drives = require('../drives');
const operationStore = require('../operation-store');
const runner = require('../operation-runner');
const spaceCheck = require('../space-check');
const { isValidItemName } = require('../paths');
const { str, sendInsufficientSpace } = require('./helpers');

const VALID_OP_TYPES = ['copy', 'move', 'duplicate', 'upload', 'extract', 'compress', 'delete', 'rename', 'create-folder', 'create-file'];
const FINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'interrupted']);
const MAX_ITEMS = 100000;

// The runner resolves paths with the account id alone, so this is the only place the
// external-drive grant is enforced for queued work. Returns null when allowed, else the 403 body.
function operationAccessError(type, destDrive, rows, user) {
  const needWrite = new Set();
  const needRead = new Set();
  // A multi-item compress writes its one archive to destDrive.
  if (type === 'copy' || type === 'move' || type === 'upload' || type === 'compress') needWrite.add(destDrive);
  if (type === 'copy') rows.forEach((row) => needRead.add(row.sourceDrive));
  else if (type !== 'upload') rows.forEach((row) => needWrite.add(row.sourceDrive));

  for (const driveId of [...needRead, ...needWrite]) {
    if (!drives.canReadDrive(driveId, user)) {
      return { error: 'drive_unavailable', message: 'Your account does not have access to this drive.' };
    }
  }
  for (const driveId of needWrite) {
    if (!drives.canWriteDrive(driveId, user)) {
      return { error: 'read_only_drive', message: 'This drive is read-only for your account.' };
    }
  }
  return null;
}

// Item names are checked up front, so a bad one is a 400 now rather than a failed op later.
// Uploads name files by relPath (checked per chunk), so only their names' shape is checked.
function invalidItem(type, rows) {
  return rows.find((row) => {
    if (type === 'upload') return typeof row.name !== 'string' || !row.name;
    if (!isValidItemName(row.name)) return true;
    if (type === 'rename') return !isValidItemName(row.targetName) || /[\\/]/.test(row.targetName);
    if (type === 'create-folder' || type === 'create-file') return /[\\/]/.test(row.name);
    return false;
  });
}

function parseItems(body) {
  let items = body.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  return Array.isArray(items) ? items : [];
}

module.exports = function operationRoutes() {
  const router = express.Router();
  const currentUser = (req) => req.user.id;

  router.post('/operations', async (req, res) => {
    try {
      const body = req.body || {};
      const type = str(body.type);
      const destDrive = str(body.destDrive, 'internal') || 'internal';
      const destPath = str(body.destPath, '/') || '/';
      const message = typeof body.message === 'string' ? body.message.slice(0, 500) : undefined;
      const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100) : undefined;
      const items = parseItems(body);
      if (!VALID_OP_TYPES.includes(type)) return res.status(400).send('Invalid operation type.');
      if (items.length === 0) return res.status(400).send('No items provided.');
      if (items.length > MAX_ITEMS) return res.status(400).send('Too many items.');

      const rows = items.map((it) => ({
        name: str(it && it.name),
        sourceDrive: str(it && it.sourceDrive, 'internal') || 'internal',
        sourcePath: str(it && it.sourcePath, '/') || '/',
        targetName: str(it && it.targetName) || null,
        itemType: str(it && it.itemType) || null,
        conflict: str(it && it.conflict) || null,
        relPath: str(it && it.relPath) || null,       // upload: per-file key (matches /upload-chunk + /upload-offset)
        size: Number.isSafeInteger(it && it.size) && it.size > 0 ? it.size : 0, // upload: total bytes, for byte-based progress
      }));

      if (invalidItem(type, rows)) return res.status(400).send('Invalid item name.');

      // Before touching the disk: even a 409 would reveal what exists on a drive the account can't see.
      const denied = operationAccessError(type, destDrive, rows, req.user);
      if (denied) {
        logger.warn(`[Access] ${req.user.username} denied ${type} (${denied.error}) [IP: ${req.ip}]`);
        return res.status(403).json(denied);
      }

      // The runner treats a pre-existing target as "already done" (resume), so a fresh
      // clash must be rejected here.
      if (type === 'extract') {
        for (const it of rows) {
          const base = drives.getSafePath(it.sourcePath, it.sourceDrive, req.user);
          const ext = path.extname(it.name).toLowerCase();
          const dirName = it.name.endsWith('.tar.gz') ? it.name.replace(/\.tar\.gz$/, '') : path.basename(it.name, ext);
          if (base && dirName && fs.existsSync(path.join(base, dirName))) {
            return res.status(409).send(rows.length === 1 ? 'Folder already exists.' : `A folder named '${dirName}' already exists next to '${it.name}'.`);
          }
        }
      } else if (type === 'compress' && rows.length === 1) {
        // Only a lone item has a fixed archive name; several items get one the runner picks free.
        const it = rows[0];
        const src = drives.getSafePath(path.join(it.sourcePath, it.name), it.sourceDrive, req.user);
        if (src && fs.existsSync(`${src}.tar.gz`)) return res.status(409).send('Archive already exists.');
      }

      // Refused with 507 before anything is recorded if the destination can't hold it.
      const rec = await spaceCheck.guardEnqueue(
        { userId: currentUser(req), type, destDrive, destPath, items: rows },
        (sizes) => operationStore.create(
          { user: currentUser(req), type, destDrive, destPath, message, clientId },
          // Stored sizes let the runner re-check before starting and later checks reserve them.
          sizes && type !== 'upload' ? rows.map((row, i) => ({ ...row, size: sizes[i] })) : rows,
        ),
      );
      if (type !== 'upload') runner.wake();
      res.json(rec);
    } catch (e) {
      if (e instanceof spaceCheck.InsufficientSpaceError) return sendInsufficientSpace(req, res, e, req.body && req.body.type);
      logger.error('[Operations] create failed:', e);
      res.status(500).send('Failed to create operation.');
    }
  });

  // Dry run of the enqueue space check, for files joining an upload already in flight.
  // Same body as POST /operations.
  router.post('/check-space', async (req, res) => {
    const body = req.body || {};
    const type = str(body.type);
    const destDrive = str(body.destDrive, 'internal') || 'internal';
    const destPath = str(body.destPath, '/') || '/';
    const items = parseItems(body).slice(0, MAX_ITEMS);
    // Same access rule as POST /operations; no free-space figures without it.
    const denied = operationAccessError(type, destDrive, items.map((it) => ({ sourceDrive: str(it && it.sourceDrive, 'internal') || 'internal' })), req.user);
    if (denied) return res.status(403).json(denied);
    try {
      await spaceCheck.check({ userId: currentUser(req), type, destDrive, destPath, items });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof spaceCheck.InsufficientSpaceError) return sendInsufficientSpace(req, res, e, type);
      logger.error('[CheckSpace] Error:', e);
      res.status(500).send('Failed to check storage space.');
    }
  });

  router.get('/operations', (req, res) => {
    const user = currentUser(req);
    if (req.query.all) return res.json(operationStore.listAll(user, Number(req.query.limit) || 50));
    res.json(operationStore.listActive(user));
  });

  // Ownership is always checked: a record carries paths and filenames from its owner's storage.
  function ownedOp(req) {
    const rec = operationStore.getMeta(str(req.params.id));
    if (!rec || rec.user !== currentUser(req)) return null;
    return rec;
  }

  router.get('/operations/:id', (req, res) => {
    if (!ownedOp(req)) return res.status(404).send('Operation not found.');
    res.json(operationStore.get(req.params.id));
  });

  // Uploads push progress and finalize here; any PATCH also counts as a heartbeat. Only
  // final states can be set: moving an op back to 'pending' would make the runner redo it.
  router.patch('/operations/:id', (req, res) => {
    const rec = ownedOp(req);
    if (!rec) return res.status(404).send('Operation not found.');
    const { progress, message, status, error } = req.body || {};
    if (status !== undefined && !FINAL_STATUSES.has(status)) return res.status(400).send('Invalid status.');
    if (progress !== undefined && !(typeof progress === 'number' && progress >= 0 && progress <= 100)) {
      return res.status(400).send('Invalid progress.');
    }
    if (progress !== undefined || message !== undefined) {
      operationStore.setProgress(req.params.id, progress !== undefined ? progress : rec.progress,
        typeof message === 'string' ? message.slice(0, 500) : undefined);
    }
    if (status) operationStore.finalize(req.params.id, status, typeof error === 'string' ? error.slice(0, 2000) : null);
    else operationStore.heartbeat(req.params.id);
    res.json(operationStore.get(req.params.id));
  });

  // The runner stops between items once an op is marked canceled.
  router.delete('/operations/:id', (req, res) => {
    if (!ownedOp(req)) return res.status(404).send('Operation not found.');
    operationStore.finalize(req.params.id, 'canceled');
    res.json({ ok: true });
  });

  router.post('/operations/:id/heartbeat', (req, res) => {
    if (!ownedOp(req)) return res.status(404).send('Operation not found.');
    operationStore.heartbeat(req.params.id);
    res.json({ ok: true });
  });

  return router;
};
