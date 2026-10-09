// Every perform* is idempotent: ops left unfinished by a crash are requeued on startup and re-run here.
// Path helpers are injected from server.js via init() to avoid a circular require.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');
const archiver = require('archiver');
const logger = require('./logger');
const store = require('./operation-store');
const spaceCheck = require('./space-check');

const CONCURRENCY = 4;
const COMPRESS_EXCLUDED_EXTENSIONS = ['.zip', '.gz', '.tar', '.tar.gz', '.rar', '.7z', '.bz2', '.xz'];

// Carries an HTTP status so endpoints that call perform* directly keep their response codes.
class OpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let deps = {};
function init(d) { deps = d || {}; }

// opts.fixedName pins the resolved target name across resumes; opts.strictConflict
// reproduces the endpoint's 409 behavior.
async function performTransferItem(args, opts = {}) {
  const { userId, name, sourcePath = '/', sourceDrive = 'internal', destPath = '/', destDrive = 'internal', mode, conflict } = args;
  const strict = !!opts.strictConflict;
  if (!name) throw new OpError(400, 'Item name not provided.');
  if (mode !== 'copy' && mode !== 'move') throw new OpError(400, 'Invalid transfer mode.');

  const sourceFullPath = deps.getSafePath(path.join(sourcePath, name), sourceDrive, userId);
  const destDir = deps.getSafePath(destPath, destDrive, userId);
  if (!sourceFullPath || !destDir) throw new OpError(400, 'Invalid path detected.');
  if (!fs.existsSync(destDir)) throw new OpError(404, 'Destination folder not found.');

  let destName = opts.fixedName || name;
  let destFullPath = path.join(destDir, destName);

  // Resume guard: source gone and target present means already moved.
  if (mode === 'move' && !fs.existsSync(sourceFullPath) && fs.existsSync(destFullPath)) {
    return { destName };
  }
  if (!fs.existsSync(sourceFullPath)) throw new OpError(404, 'Source item not found.');

  const sourceStats = await fs.promises.stat(sourceFullPath);
  if (sourceStats.isDirectory() && deps.isPathInside(sourceFullPath, destDir)) {
    throw new OpError(400, 'Cannot move or copy a folder into itself.');
  }
  const sameLocation = path.resolve(path.dirname(sourceFullPath)) === path.resolve(destDir);
  if (mode === 'move' && sameLocation && destName === name) {
    throw new OpError(400, 'The item is already in this location.');
  }

  if (!opts.fixedName && fs.existsSync(destFullPath)) {
    if (conflict === 'rename') {
      destName = deps.findFreeTransferName(destDir, name, sourceStats.isDirectory());
      destFullPath = path.join(destDir, destName);
    } else if (conflict === 'replace') {
      if (path.resolve(destFullPath) === path.resolve(sourceFullPath)) {
        destName = deps.findFreeTransferName(destDir, name, sourceStats.isDirectory());
        destFullPath = path.join(destDir, destName);
      } else {
        await fs.promises.rm(destFullPath, { recursive: true, force: true });
      }
    } else if (strict) {
      throw new OpError(409, 'An item with the same name already exists here.');
    }
    // Non-strict with no decision: overwrite below.
  }

  if (mode === 'copy') {
    await fs.promises.cp(sourceFullPath, destFullPath, { recursive: true, force: true });
  } else {
    // Ensure the rename target is clear (overwrite semantics on resume/replace).
    if (fs.existsSync(destFullPath) && path.resolve(destFullPath) !== path.resolve(sourceFullPath)) {
      await fs.promises.rm(destFullPath, { recursive: true, force: true });
    }
    try {
      await fs.promises.rename(sourceFullPath, destFullPath);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV') {
        await fs.promises.cp(sourceFullPath, destFullPath, { recursive: true, force: true });
        await fs.promises.rm(sourceFullPath, { recursive: true, force: true });
      } else {
        throw renameErr;
      }
    }
  }
  return { destName };
}

// fixedName pins the target name across resumes.
async function performDuplicate({ userId, name, path: currentPath = '/', drive = 'internal', fixedName } = {}) {
  if (!name) throw new OpError(400, 'Item name not provided.');
  const sourcePath = deps.getSafePath(path.join(currentPath, name), drive, userId);
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new OpError(404, 'Source not found.');

  let copyName = fixedName;
  let destPath;
  if (copyName) {
    destPath = path.join(path.dirname(sourcePath), copyName);
  } else {
    const parsed = path.parse(sourcePath);
    let counter = 1;
    do {
      const suffix = counter === 1 ? ' (copy)' : ` (copy ${counter})`;
      copyName = `${parsed.name}${suffix}${parsed.ext}`;
      destPath = path.join(path.dirname(sourcePath), copyName);
      counter++;
    } while (fs.existsSync(destPath));
  }
  await fs.promises.cp(sourcePath, destPath, { recursive: true, force: true });
  return { copyName };
}

async function performDelete({ userId, name, path: currentPath = '/', drive = 'internal' } = {}) {
  if (!name) throw new OpError(400, 'Invalid target name.');
  const fullPath = deps.getSafePath(path.join(currentPath, name), drive, userId);
  if (!fullPath) throw new OpError(400, 'Invalid path.');
  await fs.promises.rm(fullPath, { recursive: true, force: true });
}

function extractZip(archivePath, destDir) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on('entry', (entry) => {
        if (entry.fileName.startsWith('__MACOSX/') || /\/$/.test(entry.fileName)) { zipfile.readEntry(); return; }
        const sanitized = entry.fileName.replace(/[:*?"<>|]/g, '_').replace(/\.\.\//g, '');
        const fullPath = path.join(destDir, sanitized);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2) { zipfile.readEntry(); return; }
          const ws = fs.createWriteStream(fullPath);
          ws.on('finish', () => zipfile.readEntry());
          ws.on('error', reject);
          readStream.pipe(ws);
        });
      });
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

// Extract into a .partial path then rename, so a crash never leaves a half-populated
// final folder. opts.strict gives the endpoint's 409 when that folder already exists.
async function performExtract({ userId, name, path: currentPath = '/', drive = 'internal', opId } = {}, opts = {}) {
  if (!name) throw new OpError(400, 'Archive name not provided.');
  const targetBasePath = deps.getSafePath(currentPath || '/', drive, userId);
  if (!targetBasePath) throw new OpError(400, 'Invalid base path.');
  if (!deps.getSafePath(path.join(currentPath || '/', name), drive, userId)) throw new OpError(400, 'Invalid file path.');

  const archivePath = path.join(targetBasePath, name);
  const extension = path.extname(name).toLowerCase();
  const dirName = name.endsWith('.tar.gz') ? name.replace(/\.tar\.gz$/, '') : path.basename(name, extension);
  const extractToPath = path.join(targetBasePath, dirName);

  if (!fs.existsSync(archivePath)) throw new OpError(404, 'Archive file not found.');
  if (fs.existsSync(extractToPath)) {
    if (opts.strict) throw new OpError(409, 'Folder already exists.');
    return; // resume: final folder present => already done
  }

  const partial = `${extractToPath}.partial-${opId || crypto.randomBytes(6).toString('hex')}`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  await fs.promises.mkdir(partial, { recursive: true });

  if (extension === '.zip') {
    await extractZip(archivePath, partial);
  } else if (extension === '.gz' || name.endsWith('.tar.gz')) {
    await tar.x({ file: archivePath, cwd: partial });
  } else {
    await fs.promises.rm(partial, { recursive: true, force: true });
    throw new OpError(400, 'Unsupported archive type.');
  }
  await fs.promises.rename(partial, extractToPath);
}

async function performCompress({ userId, name, path: currentPath = '/', type, drive = 'internal', opId } = {}, opts = {}) {
  if (!name || !type) throw new OpError(400, 'Item name or type not provided.');
  const sourcePath = deps.getSafePath(path.join(currentPath, name), drive, userId);
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new OpError(404, 'Source item not found.');
  if (type === 'file' && COMPRESS_EXCLUDED_EXTENSIONS.includes(path.extname(name).toLowerCase())) {
    throw new OpError(400, 'File already compressed.');
  }
  const outputPath = `${sourcePath}.tar.gz`;
  if (fs.existsSync(outputPath)) {
    if (opts.strict) throw new OpError(409, 'Archive already exists.');
    return; // resume: archive already present => done
  }
  const partial = `${outputPath}.partial-${opId || crypto.randomBytes(6).toString('hex')}`;
  await fs.promises.rm(partial, { force: true });
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(partial);
    const archive = archiver('tar', { gzip: true });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    if (type === 'folder') archive.directory(sourcePath, false);
    else archive.file(sourcePath, { name });
    archive.finalize();
  });
  await fs.promises.rename(partial, outputPath);
}

async function performRename({ userId, oldName, newName, path: currentPath = '/', drive = 'internal' } = {}) {
  if (!oldName || !newName) throw new OpError(400, 'Old and new names are required.');
  if (newName.includes('/') || newName.includes('\\')) throw new OpError(400, 'Invalid characters in the new name.');
  if (oldName === newName) return;
  const sourcePath = deps.getSafePath(path.join(currentPath, oldName), drive, userId);
  const destPath = deps.getSafePath(path.join(currentPath, newName), drive, userId);
  if (!sourcePath || !destPath) throw new OpError(400, 'Invalid path detected.');
  if (!fs.existsSync(sourcePath) && fs.existsSync(destPath)) return; // resume guard
  if (!fs.existsSync(sourcePath)) throw new OpError(404, 'Source item not found.');
  if (fs.existsSync(destPath)) throw new OpError(409, 'An item with the new name already exists.');
  await fs.promises.rename(sourcePath, destPath);
}

async function performCreateFolder({ userId, folder, path: currentPath = '/', drive = 'internal' } = {}) {
  if (!folder || /[\/\\]/.test(folder)) throw new OpError(400, 'Invalid folder name.');
  const fullPath = deps.getSafePath(path.join(currentPath, folder), drive, userId);
  if (!fullPath) throw new OpError(400, 'Invalid path.');
  await fs.promises.mkdir(fullPath, { recursive: true });
}

async function performCreateFile({ userId, filename, path: currentPath = '/', drive = 'internal' } = {}) {
  if (!filename || /[\/\\]/.test(filename)) throw new OpError(400, 'Invalid filename.');
  const fullPath = deps.getSafePath(path.join(currentPath, filename), drive, userId);
  if (!fullPath) throw new OpError(400, 'Invalid path.');
  if (!fs.existsSync(fullPath)) await fs.promises.writeFile(fullPath, '');
}

async function performItem(op, item) {
  switch (op.type) {
    case 'copy':
    case 'move': {
      const r = await performTransferItem(
        { userId: op.user, name: item.name, sourcePath: item.sourcePath, sourceDrive: item.sourceDrive, destPath: op.destPath, destDrive: op.destDrive, mode: op.type, conflict: item.conflict },
        { fixedName: item.targetName || undefined },
      );
      if (!item.targetName && r && r.destName) store.setItemTarget(op.id, item.id, r.destName);
      return;
    }
    case 'duplicate': {
      const r = await performDuplicate({ userId: op.user, name: item.name, path: item.sourcePath, drive: item.sourceDrive, fixedName: item.targetName || undefined });
      if (!item.targetName && r && r.copyName) store.setItemTarget(op.id, item.id, r.copyName);
      return;
    }
    case 'delete':
      return performDelete({ userId: op.user, name: item.name, path: item.sourcePath, drive: item.sourceDrive });
    case 'extract':
      return performExtract({ userId: op.user, name: item.name, path: item.sourcePath, drive: item.sourceDrive, opId: op.id });
    case 'compress':
      return performCompress({ userId: op.user, name: item.name, path: item.sourcePath, type: item.itemType, drive: item.sourceDrive, opId: op.id });
    case 'rename':
      return performRename({ userId: op.user, oldName: item.name, newName: item.targetName, path: item.sourcePath, drive: item.sourceDrive });
    case 'create-folder':
      return performCreateFolder({ userId: op.user, folder: item.name, path: item.sourcePath, drive: item.sourceDrive });
    case 'create-file':
      return performCreateFile({ userId: op.user, filename: item.name, path: item.sourcePath, drive: item.sourceDrive });
    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

let started = false;
let stopped = false;
let wakeResolve = null;

function wake() {
  if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r(); }
}
function idle(ms) {
  return new Promise((resolve) => {
    wakeResolve = resolve;
    setTimeout(() => { if (wakeResolve === resolve) { wakeResolve = null; resolve(); } }, ms);
  });
}

async function processOp(op) {
  try {
    const fresh = store.get(op.id);
    if (!fresh) return;

    // Space can go while an op waits in the queue: refuse it whole rather than fail half-way.
    try {
      await spaceCheck.guardStart(fresh);
    } catch (e) {
      if (e instanceof spaceCheck.InsufficientSpaceError) {
        store.finalize(op.id, 'failed', `${e.message}. ${e.detail}`);
        logger.warn(`[OpRunner] ${op.type} ${op.id} refused: ${e.detail}`);
        return;
      }
      logger.warn(`[OpRunner] Space check for ${op.id} failed, running anyway: ${e.message}`);
    }

    const pending = fresh.items.filter((it) => it.status !== 'completed');
    let firstError = null;
    const queue = pending.slice();

    const worker = async () => {
      while (queue.length) {
        if (stopped || store.isCanceled(op.id)) return;
        const item = queue.shift();
        store.markItem(op.id, item.id, 'running', null);
        try {
          await performItem(fresh, item);
          store.itemDone(op.id, item.id);
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          if (!firstError) firstError = msg;
          store.itemFail(op.id, item.id, msg);
        }
      }
    };

    const poolSize = Math.min(CONCURRENCY, pending.length || 1);
    await Promise.all(Array.from({ length: poolSize }, worker));

    if (stopped) return;                                   // shutdown mid-op -> resume next boot
    if (store.isCanceled(op.id)) { store.finalize(op.id, 'canceled'); return; }

    const after = store.get(op.id);
    const allDone = after && after.items.every((it) => it.status === 'completed');
    store.finalize(op.id, allDone ? 'completed' : 'failed', allDone ? null : firstError);
    logger.info(`[OpRunner] ${op.type} ${op.id} -> ${allDone ? 'completed' : 'failed'}`);
  } catch (e) {
    logger.error(`[OpRunner] Operation ${op.id} crashed: ${e && e.stack ? e.stack : e}`);
    try { store.finalize(op.id, 'failed', e && e.message ? e.message : String(e)); } catch { /* ignore */ }
  }
}

async function loop() {
  while (!stopped) {
    let op = null;
    try { op = store.nextPending(); } catch (e) { logger.error(`[OpRunner] nextPending failed: ${e.message}`); }
    if (!op) { await idle(2000); continue; }
    if (!store.claim(op.id)) continue;
    await processOp(op);
  }
}

function start() {
  if (started) return;
  started = true;
  stopped = false;
  loop();
}
function stop() {
  stopped = true;
  wake();
}

module.exports = {
  init,
  start,
  stop,
  wake,
  OpError,
  performItem,
  performTransferItem,
  performDuplicate,
  performDelete,
  performExtract,
  performCompress,
  performRename,
  performCreateFolder,
  performCreateFile,
};
