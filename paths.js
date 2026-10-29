// Path rules shared by the routes, the operation runner and archive extraction.
//
// Two checks keep a client-supplied path inside its root: a lexical one on the resolved
// path, and a realpath one on the deepest part of it that exists, so a symlink or junction
// inside the root (on an external drive, say) can't lead anywhere outside it.

const fs = require('fs');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

const INVALID_WINDOWS_FILENAME_CHARS = /[<>:"\/\\|?*\x00-\x1F]/g;
const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// A name the client sends for one item. On Windows a backslash is a separator too.
const ITEM_NAME_SEPARATOR = IS_WINDOWS ? /[\\/]/ : /\//;

// Names are made safe for Windows on every platform, so a file stays usable after it is
// copied onto an NTFS/exFAT drive or synced to a Windows machine.
function sanitizePathSegment(segment, fallback = 'upload') {
  let sanitized = String(segment || '')
    .replace(/:/g, '-')
    .replace(INVALID_WINDOWS_FILENAME_CHARS, '_')
    .replace(/[. ]+$/g, '');

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    sanitized = fallback;
  }

  if (WINDOWS_RESERVED_FILENAME.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

function sanitizeUploadedRelativePath(relativePath, fallbackFileName = 'upload') {
  const fallback = sanitizePathSegment(fallbackFileName, 'upload');
  const rawSegments = String(relativePath || fallbackFileName || fallback)
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..');

  if (rawSegments.length === 0) {
    return fallback;
  }

  return path.join(...rawSegments.map((segment, index) => {
    const isLastSegment = index === rawSegments.length - 1;
    return sanitizePathSegment(segment, isLastSegment ? fallback : 'folder');
  }));
}

function isPathInside(basePath, candidatePath) {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate === resolvedBase) return true;
  // A drive root ("D:\") already ends in a separator; only append one when missing.
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedCandidate.startsWith(baseWithSep);
}

// One item addressed by name within a folder: never empty, '.', '..' or a nested path,
// so it can't name the folder itself (a delete of '.' would empty the whole root).
function isValidItemName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('\0')
    && !ITEM_NAME_SEPARATOR.test(name);
}

// Windows maps these names to devices in any directory (C:\files\CON is the console), so
// reading one could hang on a device instead of opening a file.
function hasWindowsDeviceSegment(relativePath) {
  return relativePath
    .split(/[\\/]/)
    .some((seg) => WINDOWS_RESERVED_FILENAME.test(seg.replace(/[. ]+$/, '')));
}

function realpathOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// Real path of the deepest existing ancestor of p (p itself when it exists). Paths that
// don't exist yet, like an upload's target, are judged by where they would be created.
// null if something other than a missing component stops the lookup.
function realpathOfExisting(p) {
  let cur = p;
  for (;;) {
    try {
      return fs.realpathSync.native(cur);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
      const up = path.dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  }
}

// The absolute path for subpath ('' and '/' are the root itself), or null when it would
// leave root, lexically or through a link. The lexical path is returned (not the real one),
// so callers can keep deriving relative paths from root.
function resolveInside(root, subpath = '') {
  if (typeof root !== 'string' || !root) return null;
  if (typeof subpath !== 'string' || subpath.includes('\0')) return null;
  const base = path.resolve(root);
  const target = path.resolve(path.join(base, subpath));
  if (!isPathInside(base, target)) return null;
  if (IS_WINDOWS && target !== base && hasWindowsDeviceSegment(path.relative(base, target))) return null;

  // A root that doesn't exist yet has nothing inside it to follow.
  const rootReal = realpathOrNull(base);
  if (!rootReal) return target;
  const targetReal = realpathOfExisting(target);
  if (!targetReal || !isPathInside(rootReal, targetReal)) return null;
  return target;
}

// Windows: mkdir({ recursive: true }) throws EPERM on an existing volume root ("E:\"),
// so an already-present directory counts as success.
async function ensureDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    if (!fs.existsSync(dir)) throw err;
  }
}

// "Keep both" naming for copy/move clashes: name-1, name-2, ... (before a file's extension).
function suffixedTransferName(name, isDirectory, n) {
  if (isDirectory) return `${name}-${n}`;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base}-${n}${ext}`;
}

function findFreeTransferName(destDir, name, isDirectory) {
  let n = 1;
  let candidate = suffixedTransferName(name, isDirectory, n);
  while (fs.existsSync(path.join(destDir, candidate))) {
    n += 1;
    candidate = suffixedTransferName(name, isDirectory, n);
  }
  return candidate;
}

// Names for laying several items side by side (zip root, combined archive, multi-item share):
// same-named items from different folders (search results) get -1, -2, ... suffixes.
function uniqueEntryNames(entries) {
  const used = new Set();
  return entries.map(({ name, isDirectory }) => {
    let entryName = name;
    for (let n = 1; used.has(entryName.toLowerCase()); n++) {
      entryName = suffixedTransferName(name, isDirectory, n);
    }
    used.add(entryName.toLowerCase());
    return entryName;
  });
}

module.exports = {
  IS_WINDOWS,
  WINDOWS_RESERVED_FILENAME,
  sanitizePathSegment,
  sanitizeUploadedRelativePath,
  isPathInside,
  isValidItemName,
  resolveInside,
  ensureDir,
  suffixedTransferName,
  findFreeTransferName,
  uniqueEntryNames,
};
