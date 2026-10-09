// "Volume" is the filesystem that receives the bytes (stat().dev), not the drive id.
// Infrastructure errors (failed statfs, unreadable source) fail OPEN: this guards against doomed work, it isn't a permission.

const fs = require('fs');
const path = require('path');
const disk = require('diskusage');
const logger = require('./logger');
const store = require('./operation-store');

const TYPES = new Set(['copy', 'move', 'duplicate', 'upload']);
const WALK_BATCH = 32;       // concurrent lstat calls while sizing a folder
const DEFAULT_BLOCK = 4096;
const MAX_BLOCK = 1024 * 1024;

// deps: { getSafePath(subpath, driveId, userId), driveName(driveId), formatBytes(n) }
let deps = {};
function init(d) { deps = d || {}; }

class InsufficientSpaceError extends Error {
  constructor({ required, available, reserved, driveId }) {
    super('Insufficient storage space');
    this.status = 507;
    this.required = required;
    this.available = available; // free bytes on the volume right now
    this.reserved = reserved;   // bytes other operations still have to write there
    this.driveId = driveId;
    const fmt = deps.formatBytes || String;
    const name = deps.driveName ? deps.driveName(driveId) : driveId;
    const left = fmt(Math.max(0, available - reserved));
    this.detail = reserved > 0
      ? `This needs ${fmt(required)}, but ${name} will only have ${left} free once the transfers already in progress finish.`
      : `This needs ${fmt(required)}, but ${name} only has ${left} free.`;
  }

  toJSON() {
    return {
      error: 'insufficient_storage',
      message: this.message,
      detail: this.detail,
      required: this.required,
      available: this.available,
      reserved: this.reserved,
      drive: this.driveId,
    };
  }
}

function appliesTo(type) { return TYPES.has(type); }

function roundUp(bytes, block) {
  return bytes > 0 ? Math.ceil(bytes / block) * block : 0;
}

function topLevel(relPath) {
  return String(relPath || '').split(/[\\/]/)[0];
}

// Nearest existing directory at or above p: upload targets may not exist yet.
async function existingDir(p) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      const st = await fs.promises.stat(cur);
      return st.isDirectory() ? cur : path.dirname(cur);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
}

// block is the allocation unit: every file occupies whole blocks, which matters
// for many small files on a large-cluster exFAT drive.
async function volumeOf(dir) {
  const at = await existingDir(dir);
  if (!at) return null;
  const st = await fs.promises.stat(at);
  let block = DEFAULT_BLOCK;
  try {
    const sfs = await fs.promises.statfs(at);
    if (sfs.bsize > 0 && sfs.bsize <= MAX_BLOCK) block = sfs.bsize;
  } catch { /* keep the default */ }
  return { dev: st.dev, block, at };
}

async function freeBytes(at) {
  const { available } = await disk.check(at);
  return available;
}

// lstat: symlinks are copied as links, never followed. Iterative with a fixed
// batch so a deep tree can't fan out without bound.
async function footprint(root, block) {
  let total = 0;
  const dirs = [];
  const visit = async (p) => {
    let st;
    try { st = await fs.promises.lstat(p); } catch { return; }
    if (st.isFile()) total += roundUp(st.size, block);
    else if (st.isDirectory()) { total += block; dirs.push(p); }
  };
  await visit(root);
  while (dirs.length) {
    const dir = dirs.pop();
    let names;
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (let i = 0; i < names.length; i += WALK_BATCH) {
      await Promise.all(names.slice(i, i + WALK_BATCH).map((n) => visit(path.join(dir, n))));
    }
  }
  return total;
}

function targetDir(userId, type, destDrive, destPath, item) {
  if (type === 'duplicate') {
    const driveId = item.sourceDrive || 'internal';
    return { dir: deps.getSafePath(item.sourcePath || '/', driveId, userId), driveId };
  }
  const driveId = destDrive || 'internal';
  return { dir: deps.getSafePath(destPath || '/', driveId, userId), driveId };
}

async function transferItemBytes(userId, type, dir, vol, item) {
  if (!item.name) return 0;
  const src = deps.getSafePath(path.join(item.sourcePath || '/', item.name), item.sourceDrive || 'internal', userId);
  if (!src) return 0;
  let srcStat;
  try { srcStat = await fs.promises.lstat(src); } catch { return 0; } // missing: the runner reports it
  // A move within one volume is a rename: nothing new is written.
  if (type === 'move' && srcStat.dev === vol.dev) return 0;
  let bytes = await footprint(src, vol.block);
  // 'replace' deletes the existing target right before this item is written.
  // Only this item may count that space: items run concurrently, in no set order.
  if (type !== 'duplicate' && item.conflict === 'replace') {
    const target = path.join(dir, item.name);
    if (path.resolve(target) !== path.resolve(src)) {
      bytes = Math.max(0, bytes - await footprint(target, vol.block));
    }
  }
  return bytes;
}

// Walks source folders, so it can be slow: callers do this outside the lock.
async function measure({ userId, type, destDrive, destPath, items }) {
  const volumes = new Map(); // dev -> volume entry
  const byDir = new Map();   // dir -> volume entry
  const volumeFor = async (dir, driveId) => {
    if (byDir.has(dir)) return byDir.get(dir);
    const v = await volumeOf(dir);
    let entry = null;
    if (v) {
      entry = volumes.get(v.dev) || { ...v, driveId, bytes: 0 };
      volumes.set(v.dev, entry);
    }
    byDir.set(dir, entry);
    return entry;
  };

  const perItem = [];
  const replaced = new Set(); // upload: top-level names the user chose to replace
  let uploadDir = null;
  let uploadVol = null;
  for (const item of items) {
    const { dir, driveId } = targetDir(userId, type, destDrive, destPath, item);
    const vol = dir ? await volumeFor(dir, driveId) : null;
    if (!vol) { perItem.push(0); continue; }
    let bytes;
    if (type === 'upload') {
      bytes = roundUp(Number(item.size) || 0, vol.block);
      if (item.conflict === 'replace') replaced.add(topLevel(item.relPath || item.name));
      uploadDir = dir;
      uploadVol = vol;
    } else {
      bytes = await transferItemBytes(userId, type, dir, vol, item);
    }
    vol.bytes += bytes;
    perItem.push(bytes);
  }

  // Replaced upload targets are deleted before the first byte goes up, so their
  // space is this upload's to use.
  if (uploadVol) {
    for (const name of replaced) {
      const p = deps.getSafePath(path.join(destPath || '/', name), destDrive || 'internal', userId);
      if (p && path.dirname(p) === uploadDir) uploadVol.bytes -= await footprint(p, uploadVol.block);
    }
    uploadVol.bytes = Math.max(0, uploadVol.bytes);
  }

  return { volumes: [...volumes.values()], perItem };
}

// Bytes other active ops (every account's: the disk is shared) still have to write onto `dev`.
// Runner items already started are skipped: what they wrote is already off the free figure.
// uploadsOnly is for the runner's own check: runner ops queued behind it run after it.
async function reservedOn(dev, { excludeOpId = null, uploadsOnly = false } = {}) {
  let total = 0;
  const devByDir = new Map();
  for (const op of store.listActiveAll()) {
    if (op.id === excludeOpId || !TYPES.has(op.type)) continue;
    if (uploadsOnly && op.type !== 'upload') continue;
    if (!op.items.length) continue;
    const { dir } = targetDir(op.user, op.type, op.destDrive, op.destPath, op.items[0]);
    if (!dir) continue;
    if (!devByDir.has(dir)) {
      const v = await volumeOf(dir).catch(() => null);
      devByDir.set(dir, v ? v.dev : null);
    }
    if (devByDir.get(dir) !== dev) continue;
    for (const it of op.items) {
      if (op.type === 'upload') {
        if (it.status !== 'completed') total += Math.max(0, (it.size || 0) - (it.bytesReceived || 0));
      } else if (it.status === 'pending') {
        total += it.size || 0;
      }
    }
  }
  return total;
}

// Reads free space fresh: run under the lock, immediately before the work is recorded or started.
async function assertFits(volumes, opts) {
  for (const vol of volumes) {
    if (!(vol.bytes > 0)) continue;
    let available;
    try {
      available = await freeBytes(vol.at);
    } catch (e) {
      logger.warn(`[Space] Free-space lookup failed for ${vol.at}: ${e.message}`);
      continue;
    }
    const reserved = await reservedOn(vol.dev, opts);
    if (vol.bytes > available - reserved) {
      throw new InsufficientSpaceError({ required: vol.bytes, available, reserved, driveId: vol.driveId });
    }
  }
}

// Checks and the records they approve are serialized, so two requests racing
// for the last 300 GB can't both see it free.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function measureOrNull(spec) {
  try {
    return await measure(spec);
  } catch (e) {
    logger.warn(`[Space] Could not size ${spec.type}: ${e.message}`);
    return null;
  }
}

// create(perItemBytes | null) runs only once space is confirmed. The per-item sizes let
// the runner re-check without a second walk and let later checks reserve this op's share.
async function guardEnqueue(spec, create) {
  if (!appliesTo(spec.type)) return create(null);
  const measured = await measureOrNull(spec);
  return withLock(async () => {
    if (measured) await assertFits(measured.volumes);
    return create(measured ? measured.perItem : null);
  });
}

// Same check with nothing recorded.
async function check(spec) {
  if (!appliesTo(spec.type)) return;
  const measured = await measureOrNull(spec);
  if (measured) await withLock(() => assertFits(measured.volumes));
}

// Reuses the sizes measured at enqueue (re-walking a huge tree would double the
// wait); free space and competing uploads are read fresh.
async function guardStart(op) {
  if (!appliesTo(op.type) || op.type === 'upload' || !op.items.length) return;
  const bytes = op.items
    .filter((it) => it.status !== 'completed')
    .reduce((sum, it) => sum + (it.size || 0), 0);
  if (bytes <= 0) return;
  const { dir, driveId } = targetDir(op.user, op.type, op.destDrive, op.destPath, op.items[0]);
  if (!dir) return;
  let vol;
  try { vol = await volumeOf(dir); } catch { return; }
  if (!vol) return;
  await withLock(() => assertFits([{ ...vol, driveId, bytes }], { excludeOpId: op.id, uploadsOnly: true }));
}

// The batch already reserved this file's share, so compare with free space alone
// (catches a disk filled from elsewhere). An existing file is truncated first, so its blocks count as free.
async function guardUploadFile(destFile, size, driveId) {
  if (!(size > 0)) return;
  let vol;
  try { vol = await volumeOf(path.dirname(destFile)); } catch { return; }
  if (!vol) return;
  let bytes = roundUp(size, vol.block);
  try {
    const st = await fs.promises.stat(destFile);
    if (st.isFile()) bytes = Math.max(0, bytes - roundUp(st.size, vol.block));
  } catch { /* new file */ }
  if (bytes <= 0) return;
  let available;
  try { available = await freeBytes(vol.at); } catch { return; }
  if (bytes > available) {
    throw new InsufficientSpaceError({ required: bytes, available, reserved: 0, driveId });
  }
}

module.exports = {
  init,
  appliesTo,
  InsufficientSpaceError,
  guardEnqueue,
  guardStart,
  guardUploadFile,
  check,
  // exposed for tests
  measure,
  footprint,
  reservedOn,
};
