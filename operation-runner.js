// Every perform* is idempotent: ops left unfinished by a crash are requeued on startup and re-run here.
// Path helpers are injected via init() so the runner can be driven with test fixtures.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const logger = require('./logger');
const store = require('./operation-store');
const spaceCheck = require('./space-check');
const { isValidItemName } = require('./paths');
const { extractArchive, archiveKind, ExtractLimitError } = require('./archive-extract');

const CONCURRENCY = 4;
const COMPRESS_EXCLUDED_EXTENSIONS = ['.zip', '.gz', '.tar', '.tar.gz', '.rar', '.7z', '.bz2', '.xz'];

// Carries an HTTP status so endpoints that call perform* directly keep their response codes.
class OpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// deps: { getSafePath(subpath, driveId, userId), isPathInside, findFreeTransferName,
//         uniqueEntryNames, changed?(absPath) }. changed() is told about every path a
// perform* added, removed or rewrote (cached folder sizes are dropped with it).
let deps = {};
function init(d) { deps = d || {}; }

function changed(...paths) {
  if (typeof deps.changed !== 'function') return;
  for (const p of paths) if (p) deps.changed(p);
}

function requireItemName(name, what = 'item') {
  if (!isValidItemName(name)) throw new OpError(400, `Invalid ${what} name.`);
}

// A name about to be created: never nested, on any platform.
function requireNewName(name, what) {
  if (!isValidItemName(name) || /[\\/]/.test(name)) throw new OpError(400, `Invalid ${what}.`);
}

// opts.fixedName pins the resolved target name across resumes; opts.strictConflict
// reproduces the endpoint's 409 behavior.
async function performTransferItem(args, opts = {}) {
  const { userId, name, sourcePath = '/', sourceDrive = 'internal', destPath = '/', destDrive = 'internal', mode, conflict } = args;
  const strict = !!opts.strictConflict;
  if (!name) throw new OpError(400, 'Item name not provided.');
  requireItemName(name);
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
    changed(sourceFullPath);
  }
  changed(destFullPath);
  return { destName };
}

// fixedName pins the target name across resumes.
async function performDuplicate({ userId, name, path: currentPath = '/', drive = 'internal', fixedName } = {}) {
  if (!name) throw new OpError(400, 'Item name not provided.');
  requireItemName(name);
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
  changed(destPath);
  return { copyName };
}

async function performDelete({ userId, name, path: currentPath = '/', drive = 'internal' } = {}) {
  if (!name) throw new OpError(400, 'Invalid target name.');
  requireItemName(name, 'target');
  const fullPath = deps.getSafePath(path.join(currentPath, name), drive, userId);
  if (!fullPath) throw new OpError(400, 'Invalid path.');
  await fs.promises.rm(fullPath, { recursive: true, force: true });
  changed(fullPath);
}

// Writes `build(partial)` into a .partial sibling of finalPath, then renames it into place,
// so a crash never leaves a half-written result under the real name. A failed build removes
// its partial output instead of leaving it in the user's folder.
async function buildThenRename(finalPath, opId, build) {
  const partial = `${finalPath}.partial-${opId || crypto.randomBytes(6).toString('hex')}`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  try {
    await build(partial);
    await fs.promises.rename(partial, finalPath);
  } catch (err) {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  changed(finalPath);
}

// opts.strict gives the endpoint's 409 when the target folder already exists.
async function performExtract({ userId, name, path: currentPath = '/', drive = 'internal', opId } = {}, opts = {}) {
  if (!name) throw new OpError(400, 'Archive name not provided.');
  requireItemName(name, 'archive');
  const targetBasePath = deps.getSafePath(currentPath || '/', drive, userId);
  if (!targetBasePath) throw new OpError(400, 'Invalid base path.');
  const archivePath = deps.getSafePath(path.join(currentPath || '/', name), drive, userId);
  if (!archivePath) throw new OpError(400, 'Invalid file path.');
  if (!archiveKind(name)) throw new OpError(400, 'Unsupported archive type.');

  const extension = path.extname(name).toLowerCase();
  const dirName = name.endsWith('.tar.gz') ? name.replace(/\.tar\.gz$/, '') : path.basename(name, extension);
  if (!isValidItemName(dirName)) throw new OpError(400, 'Invalid archive name.');
  const extractToPath = path.join(targetBasePath, dirName);

  if (!fs.existsSync(archivePath)) throw new OpError(404, 'Archive file not found.');
  if (fs.existsSync(extractToPath)) {
    if (opts.strict) throw new OpError(409, 'Folder already exists.');
    return; // resume: final folder present => already done
  }

  // The archive may not use more than is free (less what other operations have reserved);
  // unknown free space fails open, like the other space checks.
  const budget = await spaceCheck.extractBudget(targetBasePath);
  try {
    await buildThenRename(extractToPath, opId, async (partial) => {
      await fs.promises.mkdir(partial, { recursive: true });
      const result = await extractArchive(archivePath, partial, budget || {});
      if (result.skipped > 0) {
        logger.info(`[Extract] Skipped ${result.skipped} link/special entr${result.skipped === 1 ? 'y' : 'ies'} in '${name}'`);
      }
    });
  } catch (err) {
    if (err instanceof ExtractLimitError) {
      throw new spaceCheck.InsufficientSpaceError({
        required: err.required,
        available: budget ? budget.available : 0,
        reserved: budget ? budget.reserved : 0,
        driveId: drive,
      });
    }
    throw err;
  }
}

function writeTarGz(partial, fill) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(partial);
    const archive = archiver('tar', { gzip: true });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    fill(archive);
    archive.finalize().catch(reject);
  });
}

async function performCompress({ userId, name, path: currentPath = '/', type, drive = 'internal', opId } = {}, opts = {}) {
  if (!name || !type) throw new OpError(400, 'Item name or type not provided.');
  requireItemName(name);
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
  await buildThenRename(outputPath, opId, (partial) => writeTarGz(partial, (archive) => {
    if (type === 'folder') archive.directory(sourcePath, false);
    else archive.file(sourcePath, { name });
  }));
}

// A compress op with several items builds one archive in op.destPath. Its name is picked
// free on the first run and pinned on the items, so a resume rebuilds the same file.
async function performCompressMany(op) {
  const destDir = deps.getSafePath(op.destPath || '/', op.destDrive, op.user);
  if (!destDir) throw new OpError(400, 'Invalid destination path.');
  const sources = op.items.map((it) => {
    requireItemName(it.name);
    const src = deps.getSafePath(path.join(it.sourcePath || '/', it.name), it.sourceDrive, op.user);
    if (!src || !fs.existsSync(src)) throw new OpError(404, `'${it.name}' not found.`);
    return { name: it.name, src, isDirectory: fs.statSync(src).isDirectory() };
  });

  let archiveName = op.items[0].targetName;
  if (archiveName && fs.existsSync(path.join(destDir, archiveName))) return; // resume: already built
  if (!archiveName) {
    archiveName = 'Archive.tar.gz';
    for (let n = 1; fs.existsSync(path.join(destDir, archiveName)); n++) archiveName = `Archive-${n}.tar.gz`;
    op.items.forEach((it) => store.setItemTarget(op.id, it.id, archiveName));
  }

  const entryNames = deps.uniqueEntryNames(sources);
  await buildThenRename(path.join(destDir, archiveName), op.id, (partial) => writeTarGz(partial, (archive) => {
    sources.forEach(({ src, isDirectory }, i) => {
      if (isDirectory) archive.directory(src, entryNames[i]);
      else archive.file(src, { name: entryNames[i] });
    });
  }));
}

async function performRename({ userId, oldName, newName, path: currentPath = '/', drive = 'internal' } = {}) {
  if (!oldName || !newName) throw new OpError(400, 'Old and new names are required.');
  requireItemName(oldName);
  if (/[\\/]/.test(newName)) throw new OpError(400, 'Invalid characters in the new name.');
  requireNewName(newName, 'new name');
  if (oldName === newName) return;
  const sourcePath = deps.getSafePath(path.join(currentPath, oldName), drive, userId);
  const destPath = deps.getSafePath(path.join(currentPath, newName), drive, userId);
  if (!sourcePath || !destPath) throw new OpError(400, 'Invalid path detected.');
  if (!fs.existsSync(sourcePath) && fs.existsSync(destPath)) return; // resume guard
  if (!fs.existsSync(sourcePath)) throw new OpError(404, 'Source item not found.');
  if (fs.existsSync(destPath)) throw new OpError(409, 'An item with the new name already exists.');
  await fs.promises.rename(sourcePath, destPath);
  changed(sourcePath, destPath);
}

async function performCreateFolder({ userId, folder, path: currentPath = '/', drive = 'internal' } = {}) {
  requireNewName(folder, 'folder name');
  const fullPath = deps.getSafePath(path.join(currentPath, folder), drive, userId);
  if (!fullPath) throw new OpError(400, 'Invalid path.');
  await fs.promises.mkdir(fullPath, { recursive: true });
  changed(fullPath);
}

async function performCreateFile({ userId, filename, path: currentPath = '/', drive = 'internal' } = {}) {
  requireNewName(filename, 'filename');
  const fullPath = deps.getSafePath(path.join(currentPath, filename), drive, userId);
  if (!fullPath) throw new OpError(400, 'Invalid path.');
  if (!fs.existsSync(fullPath)) await fs.promises.writeFile(fullPath, '');
  changed(fullPath);
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
    // Each queue entry is a group of items that succeed or fail together: one item normally,
    // or every item of a multi-item compress, which all go into one archive.
    const combined = fresh.type === 'compress' && fresh.items.length > 1;
    const queue = combined ? (pending.length ? [pending] : []) : pending.map((item) => [item]);

    const worker = async () => {
      while (queue.length) {
        if (stopped || store.isCanceled(op.id)) return;
        const group = queue.shift();
        group.forEach((item) => store.markItem(op.id, item.id, 'running', null));
        try {
          await (combined ? performCompressMany(fresh) : performItem(fresh, group[0]));
          group.forEach((item) => store.itemDone(op.id, item.id));
        } catch (e) {
          // Same shape as guardStart's refusal, which the client shows as a storage banner.
          const msg = e instanceof spaceCheck.InsufficientSpaceError
            ? `${e.message}. ${e.detail}`
            : (e && e.message ? e.message : String(e));
          if (!firstError) firstError = msg;
          group.forEach((item) => store.itemFail(op.id, item.id, msg));
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

// processOp handles its own failures; a store error here (a busy or closed database) must
// not end the loop for good, so it waits and tries again.
async function loop() {
  while (!stopped) {
    let op = null;
    try {
      op = store.nextPending();
      if (op && !store.claim(op.id)) continue;
    } catch (e) {
      if (stopped) break;
      logger.error(`[OpRunner] Could not fetch the next operation: ${e.message}`);
      op = null;
    }
    if (!op) { await idle(2000); continue; }
    await processOp(op);
  }
}

let running = null; // the loop's promise while it runs

function start() {
  if (running) return;
  stopped = false;
  running = loop()
    .catch((e) => logger.error(`[OpRunner] Loop stopped unexpectedly: ${e && e.stack ? e.stack : e}`))
    .finally(() => { running = null; });
}

// Resolves when the loop has exited; an item already in progress finishes first and is
// left for the next start to resume if it couldn't be recorded.
function stop() {
  stopped = true;
  wake();
  return running || Promise.resolve();
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
