// Extraction that never trusts an entry name. Each name is split into segments, a '..'
// anywhere refuses the whole archive, every segment is sanitized like an upload's, and the
// result must resolve strictly inside the destination. Only directories and regular files
// are written: symlinks, hard links and devices are skipped, so nothing extracted can point
// outside the folder, and nothing keeps the archive's owner or permission bits.

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const tar = require('tar');
const { sanitizePathSegment, isPathInside } = require('./paths');

const DEFAULT_BLOCK = 4096;

class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Thrown when the archive would not fit; `required` is the space claimed so far.
class ExtractLimitError extends Error {
  constructor(required) {
    super('Not enough free space to extract this archive.');
    this.status = 507;
    this.required = required;
  }
}

function archiveKind(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.gz')) return 'tar';
  return null;
}

function unsafe(name) {
  return new ArchiveError(`This archive contains an unsafe path (${String(name).slice(0, 200)}) and was not extracted.`);
}

// Absolute target for an entry name, or null for a name that is only separators and dots.
function entryTarget(destDir, rawName) {
  const segments = String(rawName).split(/[\\/]+/).filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) throw unsafe(rawName);
  if (segments.length === 0) return null;
  const base = path.resolve(destDir);
  const target = path.resolve(base, ...segments.map((s) => sanitizePathSegment(s, '_')));
  if (target === base || !isPathInside(base, target)) throw unsafe(rawName);
  return target;
}

// Every file occupies whole blocks and every folder at least one, as in space-check, so
// an archive of millions of empty files is charged for the space they really take.
function createBudget({ maxBytes = null, blockSize = DEFAULT_BLOCK } = {}) {
  const block = blockSize > 0 ? blockSize : DEFAULT_BLOCK;
  let used = 0;
  return {
    add(bytes, isDirectory) {
      used += isDirectory ? block : Math.max(block, Math.ceil(bytes / block) * block);
    },
    check() {
      if (maxBytes != null && used > maxBytes) throw new ExtractLimitError(used);
    },
  };
}

// Resolves once the file is closed. Destroying `out` with an error rejects it.
function writeStreamTo(source, out) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      if (typeof source.resume === 'function') source.resume();
      reject(err);
    };
    out.on('error', fail);
    source.on('error', fail);
    out.on('close', () => { if (!failed) resolve(); });
    source.pipe(out);
  });
}

// ---- zip ------------------------------------------------------------------------------

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Unix creators store st_mode in the high 16 bits of the external attributes; DOS/Windows
// creators leave them 0 and mark folders with attribute 0x10.
function zipEntryKind(entry) {
  const unixType = (entry.externalFileAttributes >>> 16) & S_IFMT;
  if (unixType === S_IFLNK) return 'link';
  if (unixType === S_IFDIR || /[\\/]$/.test(entry.fileName)) return 'dir';
  if (unixType === S_IFREG) return 'file';
  if (unixType === 0) return (entry.externalFileAttributes & 0x10) ? 'dir' : 'file';
  return 'other'; // device, fifo, socket
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    // yauzl validates names (no absolute paths or '..' segments) and checks that each entry
    // inflates to exactly its declared size, which is what makes the size budget trustworthy.
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

// Walks the central directory one entry at a time, awaiting visit() for each, so memory
// stays flat however many entries the archive holds.
async function forEachZipEntry(archivePath, visit) {
  let zip;
  try {
    zip = await openZip(archivePath);
  } catch (err) {
    throw zipReadError(err);
  }
  try {
    await new Promise((resolve, reject) => {
      zip.on('entry', (entry) => {
        Promise.resolve()
          .then(() => visit(entry, zip))
          .then(() => zip.readEntry(), reject);
      });
      zip.once('end', resolve);
      zip.once('error', (err) => reject(zipReadError(err)));
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function openZipEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

function zipReadError(err) {
  if (err instanceof ArchiveError) return err;
  if (/invalid relative path|absolute path|invalid characters in fileName/i.test(err.message)) {
    return new ArchiveError('This archive contains an unsafe path and was not extracted.');
  }
  return new ArchiveError(`This archive could not be read (${err.message}).`);
}

// Returns { kind, target } for an entry worth extracting, or null for one to leave out.
function planZipEntry(entry, destDir, stats) {
  if (/^__MACOSX[\\/]/.test(entry.fileName)) return null;
  const kind = zipEntryKind(entry);
  if (kind === 'link' || kind === 'other') { stats.skipped++; return null; }
  if (kind === 'file' && entry.isEncrypted()) throw new ArchiveError('Encrypted archives are not supported.');
  const target = entryTarget(destDir, entry.fileName);
  return target ? { kind, target } : null;
}

async function extractZip(archivePath, destDir, budget, stats) {
  // First pass, before a byte is written: every name, type and the total size against
  // the space available. A bad entry anywhere refuses the whole archive.
  const counted = { skipped: 0 };
  await forEachZipEntry(archivePath, (entry) => {
    const plan = planZipEntry(entry, destDir, counted);
    if (plan) budget.add(plan.kind === 'file' ? entry.uncompressedSize : 0, plan.kind === 'dir');
  });
  budget.check();

  await forEachZipEntry(archivePath, async (entry, zip) => {
    const plan = planZipEntry(entry, destDir, stats);
    if (!plan) return;
    if (plan.kind === 'dir') {
      await fs.promises.mkdir(plan.target, { recursive: true });
      return;
    }
    await fs.promises.mkdir(path.dirname(plan.target), { recursive: true });
    let stream;
    try {
      stream = await openZipEntry(zip, entry);
    } catch (err) {
      throw zipReadError(err);
    }
    try {
      await writeStreamTo(stream, fs.createWriteStream(plan.target));
    } catch (err) {
      // Disk errors pass through; a size mismatch or bad deflate data is the archive's fault.
      throw err.syscall ? err : zipReadError(err);
    }
    stats.files++;
  });
}

// ---- tar / tar.gz ----------------------------------------------------------------------

const TAR_KINDS = { File: 'file', OldFile: 'file', ContiguousFile: 'file', Directory: 'dir' };

// node-tar's Parser (gzip is detected from the bytes) rather than tar.x: tar.x would create
// the archive's symlinks and hard links, and a link inside an account's folder is a way out.
function extractTar(archivePath, destDir, budget, stats) {
  return new Promise((resolve, reject) => {
    const source = fs.createReadStream(archivePath);
    // strict: a checksum failure, truncation or non-tar input is an error, not a warning.
    const parser = new tar.Parser({ strict: true });
    // Entries arrive one at a time; `pending` holds the work for the current one, and
    // `active` the file it is writing, if any.
    const pending = new Set();
    let active = null;
    let firstError = null;
    let ended = false;
    let settled = false;

    // Reports back only once nothing is still writing into the destination.
    const settle = () => {
      if (settled || pending.size > 0 || !(ended || firstError)) return;
      settled = true;
      if (firstError) reject(firstError);
      else resolve();
    };
    const fail = (err) => {
      if (!firstError) {
        firstError = err;
        source.destroy();
        // A corrupt gzip stream aborts the parser without ending the entry being read,
        // so its file would otherwise wait for data forever.
        if (active) active.destroy(err);
      }
      settle();
    };

    const onEntry = async (entry) => {
      const kind = TAR_KINDS[entry.type];
      if (!kind) { stats.skipped++; entry.resume(); return; }
      let target;
      try {
        target = entryTarget(destDir, entry.path);
        if (target) {
          // tar headers carry exact sizes, so the budget can stop an oversized archive
          // (a gzip bomb, say) before its entry is written.
          budget.add(entry.size, kind === 'dir');
          budget.check();
        }
      } catch (err) {
        entry.resume();
        throw err;
      }
      if (!target) { entry.resume(); return; }
      if (kind === 'dir') {
        entry.resume();
        await fs.promises.mkdir(target, { recursive: true });
        return;
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (firstError) { entry.resume(); return; }
      active = fs.createWriteStream(target);
      try {
        await writeStreamTo(entry, active);
      } finally {
        active = null;
      }
      stats.files++;
    };

    parser.on('entry', (entry) => {
      if (firstError) { entry.resume(); return; }
      const work = onEntry(entry);
      pending.add(work);
      work.then(
        () => { pending.delete(work); settle(); },
        (err) => { pending.delete(work); fail(err); },
      );
    });
    parser.on('error', (err) => fail(new ArchiveError(`This archive could not be read (${err.message}).`)));
    parser.on('end', () => { ended = true; settle(); });
    source.on('error', fail);
    source.pipe(parser);
  });
}

// Extracts archivePath into destDir, which must already exist (and should be empty: the
// runner uses a fresh .partial folder). limits: { maxBytes, blockSize }.
async function extractArchive(archivePath, destDir, limits = {}) {
  const kind = archiveKind(archivePath);
  if (!kind) throw new ArchiveError('Unsupported archive type.');
  const budget = createBudget(limits);
  const stats = { files: 0, skipped: 0 };
  if (kind === 'zip') await extractZip(archivePath, destDir, budget, stats);
  else await extractTar(archivePath, destDir, budget, stats);
  return stats;
}

module.exports = {
  ArchiveError,
  ExtractLimitError,
  archiveKind,
  entryTarget,
  extractArchive,
};
