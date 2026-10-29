const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec, execFileSync } = require('child_process');
const sharp = require('sharp');
const { Worker } = require('worker_threads');
const os = require('os');
const http = require('http'); 
const multer = require('multer');
const disk = require('diskusage');
const unzipper = require('unzipper');
const tar = require('tar');
const archiver = require('archiver');
const morgan = require('morgan');
const { WebSocketServer } = require('ws'); 

const logger = require('./logger');
const networkStats = require('./network-stats');
const bandwidth = require('./bandwidth');
const shareStore = require('./share-store');
const { fontAwesome } = require('./fa-cache');
const operationStore = require('./operation-store');
const runner = require('./operation-runner');
const spaceCheck = require('./space-check');
const userStore = require('./user-store');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const BCRYPT_COST = 12;

const CONTENT_DIR = path.join(__dirname, 'content');
const CACHE_DIR = path.join(CONTENT_DIR, 'cache');

// Thumbnails and transcodes live in the account's own tree so no other account can
// reach them. CACHE_DIR is private server-side scratch; no route serves it.
function userCacheDir(user) {
    if (!user || !user.id) return null;
    const dir = path.join(CONTENT_DIR, 'u', user.id, 'cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    return dir;
}
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const upload = multer(); 

const COMPRESS_EXCLUDED_EXTENSIONS = ['.zip', '.gz', '.tar', '.tar.gz', '.rar', '.7z', '.bz2', '.xz'];
const SEARCHABLE_EXTENSIONS = [
  '.txt', '.md', '.json', '.js', '.html', '.css', '.xml', '.yaml', '.yml', 
  '.py', '.java', '.c', '.cpp', '.h', '.cs', '.sh', '.log', '.ini', '.cfg'
];

const transcodingQueue = [];
let isTranscoding = false;

const uploadSessions = new Map();

async function processTranscodingQueue() {
    if (isTranscoding || transcodingQueue.length === 0) {
        return;
    }
    
    isTranscoding = true;
    const job = transcodingQueue.shift();
    const filePath = job.filePath;
    // Derivatives belong to the account that uploaded the source.
    const cacheDir = job.cacheDir || CACHE_DIR;
    
    logger.info(`[Transcoding Queue] Processing ${filePath} (${transcodingQueue.length} remaining in queue)`);
    
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.mov') {
        const outputFileName = `${path.parse(filePath).name}.mp4`;
        const numCores = os.cpus().length;
        const threadsToUse = Math.max(1, Math.floor(numCores * 0.9));
        const outputPath = path.join(cacheDir, outputFileName);
        const command = `ffmpeg -threads ${threadsToUse} -i "${filePath}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart -y "${outputPath}"`;
        
        logger.info(`[FFmpeg] Starting conversion for ${filePath}`);
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                logger.error(`[FFmpeg] Error: ${stderr}`);
            } else {
                logger.info(`[FFmpeg] Converted ${outputFileName}`);
            }
            
            isTranscoding = false;
            processTranscodingQueue();
        });
    } else if (ext === '.cr3') {
        const parsedPath = path.parse(filePath);
        const outputFileName = `${parsedPath.base}.jpg`;
        const outputPath = path.join(cacheDir, outputFileName);
        
        convertCR3(filePath, outputPath, () => {
            isTranscoding = false;
            processTranscodingQueue();
        });
    } else {
        isTranscoding = false;
        processTranscodingQueue();
    }
}

// Drive id -> root path. 'internal' is absent: it resolves per account (see getDriveRoot).
const driveRoots = new Map();

let detectedDrives = [];
let lastDriveScan = 0;
const DRIVE_SCAN_INTERVAL = 5000; // ms

// Both platform back ends return { id, letter, label, type, path, size, freeSpace }.
// `letter` is null on Linux. `id` is sent back as ?drive= and keys driveRoots, so it
// must be URL-safe and stable across rescans.
const IS_WINDOWS = process.platform === 'win32';

async function detectExternalDrives() {
    const now = Date.now();
    if (now - lastDriveScan < DRIVE_SCAN_INTERVAL && detectedDrives.length > 0) {
        return detectedDrives;
    }

    let drives;
    try {
        drives = IS_WINDOWS ? await detectDrivesWindows() : await detectDrivesLinux();
    } catch (err) {
        logger.error(`[Drive Detection] Scan failed: ${err.message}`);
        return detectedDrives;
    }

    for (const drive of drives) driveRoots.set(drive.id, drive.path);

    detectedDrives = drives;
    lastDriveScan = now;

    if (drives.length > 0) {
        logger.info(`[Drive Detection] Found ${drives.length} external drive(s): ${drives.map(driveTag).join(', ')}`);
    }
    return drives;
}

function driveTag(drive) {
    return drive.letter || drive.path;
}

function driveName(driveId) {
    if (!driveId || driveId === 'internal') return 'Internal Storage';
    const drive = detectedDrives.find(d => d.id === driveId);
    return drive ? (drive.label || driveTag(drive)) : driveId;
}

function detectDrivesWindows() {
    return new Promise((resolve) => {
        const psCommand = `Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | Select-Object DeviceID, VolumeName, DriveType, Size, FreeSpace | ConvertTo-Json -Compress`;

        exec(`powershell -NoProfile -Command "${psCommand}"`, { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
            if (error) {
                logger.error('[Drive Detection] PowerShell error:', error.message);
                detectDrivesWindowsFallback().then(resolve);
                return;
            }

            try {
                if (!stdout || !stdout.trim()) {
                    logger.warn('[Drive Detection] No drives returned from PowerShell');
                    resolve(detectedDrives);
                    return;
                }

                let data = JSON.parse(stdout.trim());
                // A single result comes back as an object, not an array.
                if (!Array.isArray(data)) data = [data];

                const drives = [];
                const contentDrive = path.parse(CONTENT_DIR).root.replace(/\\/g, '').toUpperCase();

                for (const drive of data) {
                    if (!drive || !drive.DeviceID) continue;

                    const letter = drive.DeviceID;
                    // Skip the system drive (C:) and whichever drive holds content/.
                    if (letter.toUpperCase() === 'C:' || letter.toUpperCase() === contentDrive) {
                        continue;
                    }

                    const driveId = letter.replace(':', '').toLowerCase();
                    const drivePath = letter + '\\';

                    try {
                        fs.accessSync(drivePath, fs.constants.R_OK);

                        drives.push({
                            id: driveId,
                            letter: letter,
                            label: drive.VolumeName || `Drive ${letter}`,
                            type: drive.DriveType === 2 ? 'removable' : 'local',
                            path: drivePath,
                            size: parseInt(drive.Size) || 0,
                            freeSpace: parseInt(drive.FreeSpace) || 0
                        });
                    } catch (accessError) {
                        logger.warn(`[Drive Detection] Drive ${letter} not accessible`);
                    }
                }

                resolve(drives);
            } catch (parseError) {
                logger.error('[Drive Detection] JSON parse error:', parseError.message);
                logger.debug('[Drive Detection] Raw output:', stdout);
                resolve(detectedDrives);
            }
        });
    });
}

// Used when PowerShell is unavailable.
async function detectDrivesWindowsFallback() {
    logger.info('[Drive Detection] Using fallback method (scanning drive letters)');
    const drives = [];
    const driveLetters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const contentDrive = path.parse(CONTENT_DIR).root.replace(/\\/g, '').toUpperCase().replace(':', '');

    for (const letter of driveLetters) {
        if (letter === contentDrive) continue;

        const drivePath = `${letter}:\\`;

        try {
            await fs.promises.access(drivePath, fs.constants.R_OK);
            const stats = await fs.promises.stat(drivePath);
            if (!stats.isDirectory()) continue;

            let size = 0, freeSpace = 0;
            try {
                const diskInfo = await disk.check(drivePath);
                size = diskInfo.total;
                freeSpace = diskInfo.free;
            } catch (e) {
                // Disk space check failed, list the drive without it.
            }

            drives.push({
                id: letter.toLowerCase(),
                letter: `${letter}:`,
                label: `Drive ${letter}:`,
                type: 'removable',
                path: drivePath,
                size: size,
                freeSpace: freeSpace
            });
        } catch (e) {
            // Drive not present or not accessible, skip it.
        }
    }

    return drives;
}

// Mounts outside these roots are OS filesystems and are never offered as drives.
// Add roots with VELOCITY_EXTERNAL_DRIVES=/srv/media,/data
const DEFAULT_LINUX_DRIVE_ROOTS = ['/media', '/run/media', '/mnt'];

function linuxDriveRoots() {
    const extra = String(process.env.VELOCITY_EXTERNAL_DRIVES || '')
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(entry => path.resolve(entry));
    return [...new Set([...DEFAULT_LINUX_DRIVE_ROOTS, ...extra])];
}

// /proc/mounts needs no external binary or privileges. Only /dev/ block-device
// mounts count, which drops pseudo-filesystems and network shares.
async function detectDrivesLinux() {
    let table;
    try {
        table = await fs.promises.readFile('/proc/mounts', 'utf8');
    } catch (err) {
        logger.warn(`[Drive Detection] Could not read /proc/mounts (${err.message}); scanning mount roots instead`);
        return detectDrivesLinuxFallback();
    }

    const roots = linuxDriveRoots();
    const drives = [];
    const seen = new Set();

    for (const line of table.split('\n')) {
        if (!line.trim()) continue;
        // device mountpoint fstype options dump pass
        const [rawDevice, rawMount] = line.split(/\s+/);
        if (!rawDevice || !rawMount) continue;
        if (!rawDevice.startsWith('/dev/')) continue;

        const device = decodeMountField(rawDevice);
        const mountPoint = decodeMountField(rawMount);

        if (!roots.some(root => isPathInside(root, mountPoint))) continue;
        // The kernel lists the most recent mount last; later wins for a given point.
        if (seen.has(mountPoint)) continue;
        seen.add(mountPoint);

        const drive = await describeLinuxMount(mountPoint, device);
        if (drive) drives.push(drive);
    }

    return drives;
}

// Used when /proc/mounts is unavailable. A directory whose st_dev differs from its
// parent's is a mount point.
async function detectDrivesLinuxFallback() {
    const candidates = new Set();
    for (const root of linuxDriveRoots()) {
        for (const entry of await readdirSafe(root)) {
            const full = path.join(root, entry);
            candidates.add(full);
            // udisks2 nests one level deeper: /media/<user>/<label>.
            for (const sub of await readdirSafe(full)) candidates.add(path.join(full, sub));
        }
    }

    const drives = [];
    for (const mountPoint of candidates) {
        try {
            const [self, parent] = await Promise.all([
                fs.promises.stat(mountPoint),
                fs.promises.stat(path.dirname(mountPoint)),
            ]);
            if (!self.isDirectory() || self.dev === parent.dev) continue;
        } catch (e) {
            continue; // vanished or unreadable
        }
        const drive = await describeLinuxMount(mountPoint, null);
        if (drive) drives.push(drive);
    }

    return drives;
}

async function describeLinuxMount(mountPoint, device) {
    // The volume holding content/ is this server's own storage, not an external drive.
    if (isPathInside(mountPoint, CONTENT_DIR)) return null;

    try {
        await fs.promises.access(mountPoint, fs.constants.R_OK);
    } catch (e) {
        logger.warn(`[Drive Detection] Mount ${mountPoint} not accessible`);
        return null;
    }

    let size = 0, freeSpace = 0;
    try {
        const diskInfo = await disk.check(mountPoint);
        size = diskInfo.total;
        freeSpace = diskInfo.free;
    } catch (e) {
        // Usage unavailable; still list the drive.
    }

    return {
        id: linuxDriveId(mountPoint),
        letter: null,
        // udisks2 names the mount directory after the filesystem label.
        label: path.basename(mountPoint) || mountPoint,
        type: isRemovableDevice(device) ? 'removable' : 'local',
        path: mountPoint,
        size,
        freeSpace,
    };
}

// The digest keeps mounts distinct when their slugs collide ("/mnt/my disk" vs "/mnt/my-disk").
function linuxDriveId(mountPoint) {
    const slug = mountPoint
        .replace(/^\/+/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    const digest = crypto.createHash('sha1').update(mountPoint).digest('hex').slice(0, 6);
    return `${slug || 'drive'}-${digest}`;
}

// Only the whole-disk sysfs node carries `removable`, so a partition checks its parent.
// Cosmetic only: removable and fixed volumes are both offered.
function isRemovableDevice(device) {
    if (!device) return false;
    try {
        const node = path.basename(fs.realpathSync(device));
        const sysPath = fs.realpathSync(`/sys/class/block/${node}`);
        const diskPath = fs.existsSync(path.join(sysPath, 'removable')) ? sysPath : path.dirname(sysPath);
        return fs.readFileSync(path.join(diskPath, 'removable'), 'utf8').trim() === '1';
    } catch (e) {
        return false;
    }
}

// /proc/mounts octal-escapes characters that would break its whitespace-separated columns.
const MOUNT_ESCAPES = { '040': ' ', '011': '\t', '012': '\n', '134': '\\' };
function decodeMountField(field) {
    return field.replace(/\\(040|011|012|134)/g, (match, code) => MOUNT_ESCAPES[code]);
}

async function readdirSafe(dir) {
    try {
        return await fs.promises.readdir(dir);
    } catch (e) {
        return [];
    }
}

// Filesystem bookkeeping (and this app's own 'cache') never shown in listings or search.
// The Windows names also appear on NTFS/exFAT volumes mounted on Linux.
const HIDDEN_SYSTEM_ENTRIES = new Set([
    'cache',
    '$RECYCLE.BIN',
    'System Volume Information',
    'lost+found',
    '$Recycle.Bin',
]);

function isHiddenSystemEntry(name) {
    return name.startsWith('.') || HIDDEN_SYSTEM_ENTRIES.has(name);
}

function getDriveRoot(driveId, user) {
    if (!driveId || driveId === 'internal') {
        // Fail closed: falling back to the shared CONTENT_DIR would serve one
        // account's tree to another.
        if (!user || !user.id) return null;
        return path.join(CONTENT_DIR, 'u', user.id);
    }
    // Unknown drive ids also fail closed, so a typo never lands in internal storage.
    return driveRoots.get(driveId) || null;
}

function userRootById(userId) {
    return userId ? path.join(CONTENT_DIR, 'u', userId) : null;
}

// External drives are shared hardware. user.externalDrives is 'none' | 'ro' | 'rw'.
function canReadDrive(driveId, user) {
    if (!user) return false;
    if (!driveId || driveId === 'internal') return true;
    return user.externalDrives === 'ro' || user.externalDrives === 'rw';
}

function canWriteDrive(driveId, user) {
    if (!user) return false;
    if (!driveId || driveId === 'internal') return true;
    return user.externalDrives === 'rw';
}

// Sends the 403 itself, so callers read as `if (!assertWritable(...)) return;`.
function assertWritable(driveId, req, res) {
    if (canWriteDrive(driveId, req.user)) return true;
    logger.warn(`[Access] ${req.user && req.user.username} denied write to drive ${driveId} [IP: ${req.ip}]`);
    res.status(403).json({ error: 'read_only_drive', message: 'This drive is read-only for your account.' });
    return false;
}

// A JSON 403 (not requireLogin's bare one), so the client reports it instead of logging out.
function assertReadable(driveId, req, res) {
    if (canReadDrive(driveId, req.user)) return true;
    logger.warn(`[Access] ${req.user && req.user.username} denied read of drive ${driveId} [IP: ${req.ip}]`);
    res.status(403).json({ error: 'drive_unavailable', message: 'Your account does not have access to this drive.' });
    return false;
}

function triggerPostProcessing(filePath, cacheDir) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.mov' || ext === '.cr3') {
        transcodingQueue.push({ filePath, cacheDir });
        logger.info(`[Transcoding Queue] Added ${filePath} to queue (queue length: ${transcodingQueue.length})`);
        processTranscodingQueue();
    }
}

// ImageMagick v6 (still Ubuntu's apt default) is `convert`, not `magick`. `convert` is never
// probed on Windows, where System32\convert.exe is the FAT-to-NTFS tool.
let magickBin = null;

function hasTool(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function resolveExternalTools() {
  const magickCandidates = IS_WINDOWS ? ['magick'] : ['magick', 'convert'];
  magickBin = magickCandidates.find(candidate => hasTool(candidate, ['-version'])) || null;

  const tools = [
    ['ImageMagick', magickBin, 'CR3 (raw photo) previews'],
    ['ffmpeg', hasTool('ffmpeg', ['-version']) ? 'ffmpeg' : null, '.mov transcoding'],
    ['exiftool', hasTool('exiftool', ['-ver']) ? 'exiftool' : null, 'CR3 preview extraction'],
  ];

  for (const [name, bin, purpose] of tools) {
    if (bin) logger.info(`[Tools] ${name} available as '${bin}'`);
    else logger.warn(`[Tools] ${name} not found on PATH: ${purpose} disabled`);
  }
}

function convertCR3(inputPath, outputPath, callback) {
  logger.info(`[CR3 Converter] Starting conversion for: ${inputPath}`);

  if (!magickBin) {
    logger.warn('[CR3 Converter] ImageMagick is not installed; trying the ExifTool preview instead.');
    tryExiftoolFallback(inputPath, outputPath, callback);
    return;
  }

  const magickCommand = `${magickBin} "${inputPath}" -auto-orient -quality 90 "${outputPath}"`;
  
  exec(magickCommand, (magickError, stdout, stderr) => {
    if (!magickError) {
      fs.access(outputPath, fs.constants.F_OK, (err) => {
        if (!err) {
          logger.info(`[CR3 Converter] SUCCESS (Method 1: Direct Magick): ${outputPath}`);
          if (callback) callback();
        } else {
          logger.warn(`[CR3 Converter] Magick command finished but output file is missing. Falling back.`);
          tryExiftoolFallback(inputPath, outputPath, callback);
        }
      });
    } else {
      logger.warn(`[CR3 Converter] FAILED (Method 1: Direct Magick). Error: ${stderr.split('\n')[0]}`);
      logger.info('[CR3 Converter] Trying Method 2: ExifTool Preview Extraction...');
      tryExiftoolFallback(inputPath, outputPath, callback);
    }
  });
}

function tryExiftoolFallback(inputPath, outputPath, callback) {
  const tempPreviewPath = path.join(CACHE_DIR, `temp_preview_${Date.now()}.jpg`);
  const exiftoolCommand = `exiftool -b -PreviewImage -w "${tempPreviewPath}" "${inputPath}"`;
  const expectedTempFile = `${tempPreviewPath}_original`; // ExifTool often appends _original

  exec(exiftoolCommand, (exifError, stdout, stderr) => {
    if (exifError) {
      logger.error(`[CR3 Converter] FAILED (Method 2, Step 1: ExifTool Extract). Error: ${stderr}`);
      if (callback) callback();
      return; 
    }

    let actualTempFile = expectedTempFile;
    if (!fs.existsSync(expectedTempFile) && fs.existsSync(tempPreviewPath)) {
        actualTempFile = tempPreviewPath;
    }

    fs.access(actualTempFile, fs.constants.F_OK, (accessErr) => {
        if (accessErr) {
            logger.error(`[CR3 Converter] FAILED (Method 2: Temp file not found).`);
            if (callback) callback();
            return;
        }

        // Without ImageMagick the extracted preview is already a JPEG; move it in unoriented.
        if (!magickBin) {
            fs.rename(actualTempFile, outputPath, (renameErr) => {
                if (renameErr) {
                    logger.error(`[CR3 Converter] FAILED (Method 2, Step 3: no ImageMagick, could not move preview). Error: ${renameErr.message}`);
                } else {
                    logger.info(`[CR3 Converter] SUCCESS (Method 2: ExifTool preview, not oriented): ${outputPath}`);
                }
                if (callback) callback();
            });
            return;
        }

        const magickOrientCommand = `${magickBin} "${actualTempFile}" -auto-orient -quality 90 "${outputPath}"`;

        exec(magickOrientCommand, (orientError, orientStdout, orientStderr) => {
            fs.unlink(actualTempFile, (unlinkErr) => {
                if (unlinkErr) logger.warn(`[CR3 Converter] Failed to clean up temp file.`);
            });

            if (orientError) {
                logger.error(`[CR3 Converter] FAILED (Method 2, Step 3: Magick Orient). Error: ${orientStderr}`);
                if (callback) callback();
                return;
            }

            logger.info(`[CR3 Converter] SUCCESS (Method 2: ExifTool + Magick Orient): ${outputPath}`);
            if (callback) callback();
        });
    });
  });
}

function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

const INVALID_WINDOWS_FILENAME_CHARS = /[<>:"\/\\|?*\x00-\x1F]/g;
const WINDOWS_RESERVED_FILENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

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

// Windows: mkdir({ recursive: true }) throws EPERM on an existing volume root ("E:\"),
// so an already-present directory counts as success.
async function ensureDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    if (!fs.existsSync(dir)) throw err;
  }
}

function getSafePath(subpath, driveId = 'internal', user = null) {
  const driveRoot = getDriveRoot(driveId, user);
  if (!driveRoot) return null;
  const resolvedPath = path.resolve(path.join(driveRoot, subpath));
  // Not a bare startsWith: ".../u/<id>-other" must not count as inside ".../u/<id>".
  return isPathInside(driveRoot, resolvedPath) ? resolvedPath : null;
}

// For the operation runner, which holds only an account id. Write permission is
// checked at enqueue time by assertWritable, not here.
function getSafePathForUser(subpath, driveId, userId) {
  return getSafePath(subpath, driveId, userId ? { id: userId } : null);
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

const numCPUs = os.cpus().length;
const sizeWorkerPool = [];
const sizeRequestQueue = [];
const pendingRequests = new Map();
let taskIdCounter = 0;

for (let i = 0; i < numCPUs; i++) {
    const worker = new Worker(path.join(__dirname, 'size-worker.js'));
    worker.on('message', (result) => {
        const { taskId, size, error } = result;
        const res = pendingRequests.get(taskId);
        if (res) {
            if (error) {
                logger.error(`[Worker Pool] Worker failed task ${taskId}: ${error}`);
                res.status(500).send('Could not calculate size.');
            } else {
                res.json({ size });
            }
            pendingRequests.delete(taskId);
        }
        worker.isBusy = false;
        processSizeQueue();
    });
    worker.on('error', (err) => {
        logger.error('[Worker Pool] A size worker encountered a fatal error:', err);
        worker.isBusy = false; 
        processSizeQueue();
    });
    worker.isBusy = false;
    sizeWorkerPool.push(worker);
}

function processSizeQueue() {
    if (sizeRequestQueue.length === 0) return;
    const availableWorker = sizeWorkerPool.find(w => !w.isBusy);
    if (availableWorker) {
        const task = sizeRequestQueue.shift();
        availableWorker.isBusy = true;
        availableWorker.postMessage(task);
    }
}

app.use(morgan(logger.morganFormat, { 
    stream: logger.stream,
    skip: function (req, res) {
        const url = req.url || req.originalUrl;
        const isPolling = url.includes('/cpu-utilization') ||
                          url.includes('/network-stats') ||
                          url.includes('/bandwidth') ||
                          url.includes('/storage') ||
                          url.includes('/drives');
        // Chunks are logged manually with more detail.
        const isUploadChunk = url.includes('/upload-chunk');
        const isOpPolling = (req.method === 'GET' && url.includes('/operations')) ||
                          url.includes('/upload-offset') ||
                          url.includes('/heartbeat');

        return isPolling || isUploadChunk || isOpPolling;
    }
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
// Fetched from the CDN on first hit, then served same-origin (CSP-safe) from disk.
app.use('/vendor/fontawesome', fontAwesome);
app.use(express.static(path.join(__dirname, 'client', 'dist'), { index: false }));
// VELOCITY_SESSION_SECRET, else a random secret persisted to .session-secret so
// restarts don't log everyone out.
function getSessionSecret() {
  if (process.env.VELOCITY_SESSION_SECRET) return process.env.VELOCITY_SESSION_SECRET;
  const secretPath = path.join(__dirname, '.session-secret');
  try {
    return fs.readFileSync(secretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}

const sessionParser = session({ secret: getSessionSecret(), name: 'velocity.sid', resave: false, saveUninitialized: true });
app.use(sessionParser);
app.set('trust proxy', 1);

// Per-IP failure throttle for the unauthenticated /login and /api/signup.
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
    // Bound the map so a spray across spoofed IPs cannot grow it without limit.
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

// Regenerates the session id to defeat fixation: the pre-auth cookie every visitor
// gets (saveUninitialized) must not carry into the logged-in session.
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

const requireLogin = (req, res, next) => {
  if (req.session.loggedIn && req.session.userId) {
    // Re-read each request so deleting or disabling an account takes effect immediately.
    const user = userStore.getById(req.session.userId);
    if (user && user.status === 'active') {
      req.user = user;
      return next();
    }
    req.session.destroy(() => {});
  }
  logger.warn(`Unauthorized access attempt to ${req.originalUrl} from IP: ${req.ip}`);
  if (req.originalUrl.startsWith('/api/')) res.sendStatus(403);
  else res.redirect('/');
};

const requireOwner = (req, res, next) => {
  if (req.user && req.user.role === 'owner') return next();
  logger.warn(`[Admin] '${req.user && req.user.username}' denied owner action ${req.originalUrl} [IP: ${req.ip}]`);
  return res.status(403).json({ error: 'owner_only' });
};

// Operation records are owned by account id.
const currentUser = (req) => (req.user ? req.user.id : null);

// Adds the bytes actually sent (including aborted range streams) to the lifetime download total.
function countDownloadBytes(req, res, next) {
    let sent = 0;
    const origWrite = res.write;
    const origEnd = res.end;

    const measure = (chunk, encoding) => {
        if (!chunk) return;
        sent += Buffer.isBuffer(chunk)
            ? chunk.length
            : Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    };

    res.write = function (chunk, encoding, cb) {
        measure(chunk, encoding);
        return origWrite.call(this, chunk, encoding, cb);
    };
    res.end = function (chunk, encoding, cb) {
        measure(chunk, encoding);
        return origEnd.call(this, chunk, encoding, cb);
    };

    // 'close' fires even when the client aborts mid-stream (common when seeking video).
    res.on('close', () => {
        if (res.statusCode === 200 || res.statusCode === 206) {
            bandwidth.addDownloaded(sent);
        }
    });

    next();
}

const SPA_INDEX = path.join(__dirname, 'client', 'dist', 'index.html');

app.get('/', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/app');
  res.sendFile(SPA_INDEX);
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (isThrottled(req, 'login')) {
    logger.warn(`Throttled login attempt for '${username}' from IP: ${req.ip}`);
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
  }
  const user = typeof username === 'string' ? userStore.getByUsername(username) : null;
  // Always compare once, so a wrong username is not faster than a wrong password.
  const hash = user ? user.passwordHash : DUMMY_HASH;
  const matches = typeof password === 'string' && await bcrypt.compare(password, hash);
  const valid = !!user && matches && user.status === 'active';
  if (valid) {
    try {
      await establishSession(req, user);
    } catch (e) {
      logger.error(`[Auth] Session establishment failed for '${user.username}': ${e.message}`);
      return res.status(500).json({ error: 'session_failed' });
    }
    userStore.touchLogin(user.id);
    clearAuthFailures(req, 'login');
    logger.info(`Successful login for user: '${user.username}' from IP: ${req.ip}`);
    res.json({ success: true, user: userStore.publicShape(user) });
  } else {
    noteAuthFailure(req, 'login');
    logger.warn(`Failed login attempt for user: '${username}' from IP: ${req.ip}`);
    await new Promise(r => setTimeout(r, 300));
    res.status(401).json({ error: 'Login failed with provided credentials.' });
  }
});

app.get('/mainpage.html', requireLogin, (req, res) => {
  res.redirect('/app');
});

app.get('/app', requireLogin, (req, res) => {
  res.sendFile(SPA_INDEX);
});

// The static root is per account, so it is resolved per request.
app.use('/content', requireLogin, countDownloadBytes, (req, res) => {
    const root = getDriveRoot('internal', req.user);
    if (!root) return res.status(404).send('No storage for this account.');

    const relativeFilePath = decodeURIComponent(req.path);
    const fullPath = path.join(root, relativeFilePath);

    if (req.method === 'GET' && fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        if (stats.isFile()) {
            logger.info(`[Access] ${req.user.username} ${relativeFilePath} (${formatBytes(stats.size)}) [IP: ${req.ip}]`);
        }
    }
    // A miss must 404, not fall through to the SPA catch-all's index.html.
    express.static(root)(req, res, () => res.sendStatus(404));
});

app.use('/drive/:driveId', requireLogin, countDownloadBytes, (req, res, next) => {
    const driveId = req.params.driveId;
    if (!canReadDrive(driveId, req.user)) {
        return res.status(403).send('Drive not available for this account.');
    }
    const driveRoot = getDriveRoot(driveId, req.user);

    if (!driveRoot) {
        return res.status(404).send('Drive not found');
    }

    express.static(driveRoot)(req, res, next);
});

app.get('/logout', requireLogin, (req, res) => {
  const user = req.user.username;
  req.session.destroy(err => {
    if (err) {
      logger.error(`Error during session destruction for user '${user}': ${err.message}`);
      return res.status(500).send('Could not log out.');
    }
    logger.info(`User '${user}' logged out successfully.`);
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

app.get('/api/auth-status', (req, res) => {
  if (!req.session.loggedIn || !req.session.userId) return res.json({ loggedIn: false });
  const u = userStore.getById(req.session.userId);
  if (!u || u.status !== 'active') return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: userStore.publicShape(u) });
});

// Lets the login page send a fresh install's first visitor straight to signup.
app.get('/api/auth/bootstrap', (req, res) => {
  res.json({ hasUsers: userStore.count() > 0 });
});

// The first account becomes the owner. After that, signup is open to anyone who can
// reach the server.
app.post('/api/signup', async (req, res) => {
  if (isThrottled(req, 'signup')) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' });
  }
  const { username, password } = req.body || {};

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
  }
  const nameErr = userStore.validateUsername(username);
  if (nameErr) return res.status(400).json({ error: 'invalid_username', message: nameErr });

  const firstAccount = userStore.count() === 0;

  let user;
  try {
    user = userStore.create({
      username,
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
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
    fs.mkdirSync(userRootById(user.id), { recursive: true });
  } catch (e) {
    userStore.remove(user.id);
    logger.error(`[Signup] Could not create storage root for '${user.username}': ${e.message}`);
    return res.status(500).json({ error: 'storage_init_failed' });
  }

  try {
    await establishSession(req, user);
  } catch (e) {
    logger.error(`[Signup] Session establishment failed for '${user.username}': ${e.message}`);
    return res.status(500).json({ error: 'session_failed' });
  }
  userStore.touchLogin(user.id);
  clearAuthFailures(req, 'signup');
  logger.info(`[Signup] Account '${user.username}' created (${user.role}) [IP: ${req.ip}]`);
  res.json({ ok: true, user: userStore.publicShape(user) });
});

const apiRouter = express.Router();
apiRouter.use(requireLogin);

apiRouter.get('/drives', async (req, res) => {
    try {
        // An account with no external-drive grant must not even learn they exist.
        const externalDrives = req.user.externalDrives === 'none'
            ? []
            : await detectExternalDrives();

        const drives = [
            {
                id: 'internal',
                label: 'Internal Storage',
                type: 'internal',
                path: getDriveRoot('internal', req.user),
                letter: null
            },
            ...externalDrives
        ];
        
        res.json(drives);
    } catch (error) {
        logger.error('[API /drives] Error:', error);
        res.status(500).json({ error: 'Failed to detect drives' });
    }
});

apiRouter.get('/storage', async (req, res) => {
  const driveId = req.query.drive || 'internal';
  if (!assertReadable(driveId, req, res)) return;
  
  try {
    const driveRoot = getDriveRoot(driveId, req.user);
    if (!driveRoot) return res.status(404).send('Drive not found.');
    const { free, total } = await disk.check(driveRoot);
    const used = total - free;
    res.json({ used, total, driveId });
  } catch (err) {
    logger.error('Error getting disk usage:', err);
    res.status(500).send('Could not retrieve disk usage information.');
  }
});

apiRouter.get('/network-stats', (req, res) => res.json(networkStats.getStats()));

// Lifetime upload/download byte totals (persist across restarts).
apiRouter.get('/bandwidth', (req, res) => res.json(bandwidth.getStats()));

apiRouter.get('/cpu-utilization', (req, res) => {
    const startCpus = os.cpus();
    setTimeout(() => {
        const endCpus = os.cpus();
        let totalIdle = 0, totalTick = 0;
        let startTotalIdle = 0, startTotalTick = 0;
        startCpus.forEach(cpu => {
            for (const type in cpu.times) startTotalTick += cpu.times[type];
            startTotalIdle += cpu.times.idle;
        });
        endCpus.forEach(cpu => {
            for (const type in cpu.times) totalTick += cpu.times[type];
            totalIdle += cpu.times.idle;
        });
        const idleDiff = totalIdle - startTotalIdle;
        const totalDiff = totalTick - startTotalTick;
        if (totalDiff === 0) return res.json({ utilization: 0 });
        const utilization = 100 * (1 - idleDiff / totalDiff);
        res.json({ utilization });
    }, 500);
});

apiRouter.get('/list', async (req, res) => { 
  const requestedPath = req.query.path || '/';
  const driveId = req.query.drive || 'internal';
  if (!canReadDrive(driveId, req.user)) return res.status(403).send('Drive not available for this account.');
  const targetPath = getSafePath(requestedPath, driveId, req.user);

  if (!targetPath) return res.status(400).send('Invalid path.');

  try {
    const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
    const filesWithStats = await Promise.all(
        entries.filter(e => !isHiddenSystemEntry(e.name))
        .map(async (e) => {
            try {
                const fullPath = path.join(targetPath, e.name);
                const stats = await fs.promises.stat(fullPath);
                const isDir = e.isDirectory();
                return {
                    name: e.name,
                    type: isDir ? 'folder' : 'file',
                    mtime: stats.mtime,
                    // Folder sizes need a recursive walk, so they are fetched lazily via /get-size.
                    size: isDir ? null : stats.size
                };
            } catch (statErr) { return null; }
        })
    );
    res.json(filesWithStats.filter(file => file !== null));
  } catch (err) {
    logger.error(`Error reading content for path '${requestedPath}' on drive '${driveId}': ${err.message}`);
    return res.status(500).send('Error reading content.');
  }
});

// Pre-upload check for replace / skip / keep both. Names are sanitized like the upload
// route's, so the check matches what would actually be written.
apiRouter.post('/check-conflicts', upload.none(), async (req, res) => {
    const { path: currentPath = '/', drive: driveId = 'internal' } = req.body;
    if (!assertReadable(driveId, req, res)) return;

    const targetBasePath = getSafePath(currentPath, driveId, req.user);
    if (!targetBasePath) return res.status(400).send('Invalid path.');

    let names = req.body.names;
    if (typeof names === 'string') {
        try { names = JSON.parse(names); } catch { names = [names]; }
    }
    if (!Array.isArray(names)) return res.status(400).send('Invalid names list.');

    try {
        // Unfiltered, so the client can pick collision-free "-1" rename targets.
        let existingNames = [];
        try {
            existingNames = await fs.promises.readdir(targetBasePath);
        } catch (readErr) {
            if (readErr.code !== 'ENOENT') throw readErr; // missing dest dir => nothing can conflict
        }

        const conflicts = [];
        const seen = new Set();
        for (const rawName of names) {
            // Only the first path segment becomes a top-level item in the destination folder.
            const topName = String(rawName || '').split(/[\\/]/)[0];
            if (!topName || seen.has(topName)) continue;
            seen.add(topName);

            const safeTop = sanitizePathSegment(topName, 'upload');
            const candidate = path.resolve(path.join(targetBasePath, safeTop));
            if (!isPathInside(targetBasePath, candidate)) continue;

            try {
                const stats = await fs.promises.stat(candidate);
                conflicts.push({ name: topName, type: stats.isDirectory() ? 'folder' : 'file' });
            } catch (statErr) {
                if (statErr.code !== 'ENOENT') {
                    logger.warn(`[CheckConflicts] stat failed for ${candidate}: ${statErr.message}`);
                }
            }
        }

        res.json({ conflicts, existingNames });
    } catch (err) {
        logger.error(`[CheckConflicts] Error for '${currentPath}' [${driveId}]: ${err.message}`);
        res.status(500).send('Failed to check for conflicts.');
    }
});

apiRouter.get('/get-size', (req, res) => {
    const { name, path: currentPath, drive: driveId = 'internal' } = req.query;
    if (!name) return res.status(400).send('Item name not provided.');
    if (!assertReadable(driveId, req, res)) return;
    const targetBasePath = getSafePath(currentPath || '/', driveId, req.user);
    if (!targetBasePath) return res.status(400).send('Invalid base path.');
    // `name` is caller-supplied; ".." must not walk out into another vault or anywhere on disk.
    const itemPath = path.resolve(path.join(targetBasePath, name));
    if (!isPathInside(targetBasePath, itemPath)) return res.status(400).send('Invalid path.');
    if (!fs.existsSync(itemPath)) return res.status(404).send('Item not found.');
    const taskId = taskIdCounter++;
    pendingRequests.set(taskId, res);
    sizeRequestQueue.push({ itemPath, taskId });
    processSizeQueue();
});

apiRouter.get('/info', async (req, res) => {
    const { name, path: currentPath = '/', drive: driveId = 'internal' } = req.query;
    if (!name) return res.status(400).send('Name is required.');
    if (!assertReadable(driveId, req, res)) return;
    
    const targetPath = getSafePath(path.join(currentPath, name), driveId, req.user);
    if (!targetPath || !fs.existsSync(targetPath)) return res.status(404).send('Item not found.');

    try {
        const stats = await fs.promises.stat(targetPath);
        let info = {
            name: name,
            created: stats.birthtime,
            modified: stats.mtime,
            size: 0,
            count: 0,
            type: stats.isDirectory() ? 'folder' : 'file'
        };

        if (stats.isDirectory()) {
            const dirStats = await getDirectoryStats(targetPath);
            info.size = dirStats.totalSize;
            info.count = dirStats.fileCount;
        } else {
            info.size = stats.size;
            info.count = 1;
        }

        res.json(info);
    } catch (err) {
        logger.error(`[Info] Error getting info for ${targetPath}:`, err);
        res.status(500).send('Error retrieving file info.');
    }
});

// Totals for a multi-selection: how many files/folders, combined size, and the newest change.
apiRouter.post('/info-multiple', async (req, res) => {
    const selection = await resolveSelection(req.body && req.body.items, req, res);
    if (!selection) return;

    const info = { files: 0, folders: 0, size: 0, count: 0, modified: null };
    for (const { stats, itemPath } of selection) {
        if (stats.isDirectory()) {
            const dirStats = await getDirectoryStats(itemPath);
            info.folders++;
            info.size += dirStats.totalSize;
            info.count += dirStats.fileCount;
        } else {
            info.files++;
            info.size += stats.size;
            info.count++;
        }
        if (!info.modified || stats.mtime > info.modified) info.modified = stats.mtime;
    }
    res.json(info);
});

apiRouter.get('/thumbnail', async (req, res) => {
    let { path: imagePath, drive: driveId = 'internal' } = req.query;
    if (!imagePath) return res.status(400).send('Image path is required.');
    if (imagePath.startsWith('/')) imagePath = imagePath.substring(1);
    if (!assertReadable(driveId, req, res)) return;

    const fullPath = getSafePath(imagePath, driveId, req.user);
    if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).send('Image not found.');

    // Include drive ID in thumbnail cache name to avoid conflicts
    const thumbnailFileName = `${driveId}_${imagePath.replace(/[\\/]/g, '_')}`;
    const thumbnailCachePath = path.join(userCacheDir(req.user), thumbnailFileName);

    try {
        if (fs.existsSync(thumbnailCachePath)) {
            res.sendFile(thumbnailCachePath);
            return;
        }
        await sharp(fullPath)
            .resize({ width: 100, height: 100, fit: 'cover' })
            .jpeg({ quality: 50 })
            .toFile(thumbnailCachePath);
        res.sendFile(thumbnailCachePath);
    } catch (err) {
        logger.error(`[Thumbnail] Failed to generate thumbnail for ${imagePath}:`, err);
        res.status(500).send('Could not generate thumbnail.');
    }
});

apiRouter.post('/rename', upload.none(), async (req, res) => {
    const { oldName, newName, path: currentPath = '/', drive: driveId = 'internal' } = req.body;
    if (oldName && newName && oldName === newName) return res.status(200).send('No changes were made.');
    if (!assertWritable(driveId, req, res)) return;
    try {
        await runner.performRename({ userId: req.user.id, oldName, newName, path: currentPath, drive: driveId });
        logger.info(`Successfully renamed '${oldName}' to '${newName}' in path '${currentPath}' on drive '${driveId}'`);
        res.status(200).send('Rename successful.');
    } catch (e) {
        if (e && e.status) return res.status(e.status).send(e.message);
        logger.error(`[Rename] Error renaming '${oldName}' to '${newName}':`, e);
        res.status(500).send('Failed to rename the item.');
    }
});

apiRouter.get('/preview/raw', (req, res) => {
    const rawImagePath = req.query.path;
    if (!rawImagePath) return res.status(400).json({ message: 'Missing raw image path.' });
    const parsedPath = path.parse(rawImagePath);
    const cachedFileName = `${parsedPath.base}.jpg`;
    const cachedFilePathDisk = path.join(userCacheDir(req.user), cachedFileName);
    const cachedFileUrl = path.join('/cache', cachedFileName).replace(/\\/g, '/');

    fs.access(cachedFilePathDisk, fs.constants.F_OK, (err) => {
        if (err) return res.status(404).json({ message: 'Preview not available or still processing.' });
        res.json({ previewUrl: `/content${cachedFileUrl}` });
    });
});

apiRouter.get('/preview/video', (req, res) => {
    const movPath = req.query.path;
    if (!movPath) return res.status(400).send('Missing video path.');
    const parsedPath = path.parse(movPath);
    const cachedFileName = `${parsedPath.name}.mp4`;
    const cachedFileUrl = path.join('/cache', cachedFileName).replace(/\\/g, '/');
    const cachedFilePathDisk = path.join(userCacheDir(req.user), cachedFileName);

    fs.access(cachedFilePathDisk, fs.constants.F_OK, (err) => {
        if (err) return res.status(404).json({ message: 'Preview not available or still processing.' });
        res.json({ previewUrl: `/content${cachedFileUrl}` });
    });
});

apiRouter.post('/upload-chunk', async (req, res) => {
    const CHUNK_SIZE = 10 * 1024 * 1024; // MUST match the client's chunk size
    const fileName = decodeURIComponent(req.headers['x-file-name']);
    const relativePath = decodeURIComponent(req.headers['x-relative-path']);
    const chunkIndex = parseInt(req.headers['x-chunk-index']);
    const totalChunks = parseInt(req.headers['x-total-chunks']);
    const currentPath = decodeURIComponent(req.headers['x-current-path'] || '/');
    const totalFileSize = parseInt(req.headers['x-total-file-size']);
    const driveId = decodeURIComponent(req.headers['x-drive-id'] || 'internal');
    const uploadId = req.headers['x-upload-id'] || 'default';
    const opId = req.headers['x-op-id'] || null; // links chunks to a durable operation record

    if (!assertWritable(driveId, req, res)) return;
    const targetBasePath = getSafePath(currentPath, driveId, req.user);
    if (!targetBasePath) return res.status(400).send('Invalid base path.');

    const sanitizedRelativePath = sanitizeUploadedRelativePath(relativePath, fileName);
    const finalDestPath = path.resolve(path.join(targetBasePath, sanitizedRelativePath));
    if (!isPathInside(targetBasePath, finalDestPath)) {
        logger.warn(`[Upload] Rejected unsafe upload path: ${relativePath} -> ${sanitizedRelativePath} [Drive: ${driveId}] [IP: ${req.ip}]`);
        return res.status(400).send('Invalid upload path.');
    }

    // Re-check before the first byte: the batch was checked when queued, but the
    // disk can fill up from elsewhere meanwhile.
    if (chunkIndex === 0) {
        try {
            await spaceCheck.guardUploadFile(finalDestPath, totalFileSize, driveId);
        } catch (e) {
            if (e instanceof spaceCheck.InsufficientSpaceError) {
                req.resume(); // drain the refused chunk so the connection stays usable
                return sendInsufficientSpace(req, res, e, `upload of ${sanitizedRelativePath}`);
            }
            logger.warn(`[Upload] Space check failed, uploading anyway: ${e.message}`);
        }
    }

    if (chunkIndex === 0) {
        try {
            const destDir = path.dirname(finalDestPath);
            await ensureDir(destDir);
            // The file itself is created/truncated by the 'w' write stream below.

            if (sanitizedRelativePath !== relativePath.replace(/\\/g, path.sep)) {
                logger.warn(`[Upload] Sanitized upload path: ${relativePath} -> ${sanitizedRelativePath} [Drive: ${driveId}] [IP: ${req.ip}]`);
            }

            if (!uploadSessions.has(uploadId)) {
                uploadSessions.set(uploadId, {
                    fileCount: 0,
                    totalSize: 0,
                    startTime: Date.now(),
                    clientIp: req.ip,
                    timer: null
                });
            }
            const session = uploadSessions.get(uploadId);
            session.fileCount++;
            session.totalSize += totalFileSize;

            logger.info(`[Upload] Started: ${sanitizedRelativePath} (${formatBytes(totalFileSize)}) -> ${currentPath} [Drive: ${driveId}] [IP: ${req.ip}]`);
        } catch (err) {
            logger.error(`[Upload] Failed to initialize file "${relativePath}" at "${finalDestPath}" [Drive: ${driveId}] [IP: ${req.ip}]: ${err.stack || err.message}`);
            return res.status(500).send('Failed to initialize file.');
        }
    }

    // Positional writes make chunks idempotent: a re-sent or resumed chunk
    // overwrites its range instead of appending.
    const flags = chunkIndex === 0 ? 'w' : 'r+';
    const writeStream = fs.createWriteStream(finalDestPath, { flags, start: chunkIndex * CHUNK_SIZE });
    let chunkBytes = 0;
    req.on('data', (data) => { chunkBytes += data.length; });
    req.pipe(writeStream);

    writeStream.on('error', (err) => {
        logger.error(`[Upload] Write error for ${sanitizedRelativePath}: ${err.message}`);
        if (!res.headersSent) res.status(500).send('Write failed.');
    });

    writeStream.on('finish', () => {
        bandwidth.addUploaded(chunkBytes);

        // Only the caller's own op, so another account's op id can't be advanced or completed.
        if (opId && operationStore.ownerOf(opId) === currentUser(req)) {
            try {
                const item = operationStore.findUploadItem(opId, relativePath, fileName);
                if (item) {
                    operationStore.setItemBytes(opId, item.id, chunkIndex * CHUNK_SIZE + chunkBytes);
                    if (chunkIndex === totalChunks - 1) {
                        operationStore.itemDone(opId, item.id);
                        const op = operationStore.get(opId);
                        if (op && op.items.length > 0 && op.items.every((it) => it.status === 'completed')) {
                            operationStore.finalize(opId, 'completed');
                        }
                    }
                }
            } catch (e) { logger.error(`[Upload] op tracking failed: ${e.message}`); }
        }

        if (chunkIndex === totalChunks - 1) {
            logger.info(`[Upload] Completed: ${sanitizedRelativePath} (${formatBytes(totalFileSize)})`);
            triggerPostProcessing(finalDestPath, userCacheDir(req.user));

            const session = uploadSessions.get(uploadId);
            if (session) {
                if (session.timer) clearTimeout(session.timer);

                // Log the batch summary once no other file completes for 3s.
                session.timer = setTimeout(() => {
                    const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
                    logger.info(`[Upload Session] Completed: ${session.fileCount} files (${formatBytes(session.totalSize)}) in ${duration}s [IP: ${session.clientIp}]`);
                    uploadSessions.delete(uploadId);
                }, 3000);
            }
        }
        res.status(200).send('Chunk received.');
    });
});

apiRouter.get('/download', async (req, res) => {
    const { name, path: currentPath = '/', drive: driveId = 'internal' } = req.query;
    if (!canReadDrive(driveId, req.user)) return res.status(403).send('Drive not available for this account.');
    const itemPath = getSafePath(path.join(currentPath, name), driveId, req.user);
    if (!itemPath) return res.status(400).send('Invalid path.');

    try {
        const stats = await fs.promises.stat(itemPath);
        const sizeStr = formatBytes(stats.size);

        if (stats.isFile()) {
            logger.info(`[Download] Started: ${name} (${sizeStr}) from ${currentPath} [IP: ${req.ip}]`);
            
            const fileStream = fs.createReadStream(itemPath);
            // Headers wait for 'open' so a locked file (EBUSY mid copy/move) can still get an error status.
            fileStream.on('open', () => {
                res.attachment(name);
                fileStream.pipe(res);
            });
            fileStream.on('end', () => {
                bandwidth.addDownloaded(stats.size);
                logger.info(`[Download] Completed: ${name} (${sizeStr})`);
            });
            fileStream.on('error', (err) => {
                logger.error(`[Download] Stream error for '${name}': ${err.code || err.message}`);
                const locked = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
                if (!res.headersSent) {
                    res.status(locked ? 423 : 500).send(locked
                        ? 'File is currently in use by another operation (such as an ongoing copy or move). Try again once it finishes.'
                        : 'Error reading file.');
                } else {
                    res.destroy(err);
                }
            });
        } else {
            // Folders stream as a zip built on the fly, never buffered in memory.
            logger.info(`[Download] Started: ${name} (folder) from ${currentPath} [IP: ${req.ip}]`);

            const archive = archiver('zip', { zlib: { level: 6 } });

            // archiver's 'error' is fatal and would crash the process if left unhandled.
            archive.on('error', (err) => {
                logger.error(`[Download] Archive error for '${name}': ${err.code || err.message}`);
                if (!res.headersSent) res.status(500).send('Error creating archive.');
                else res.destroy(err);
            });
            // Non-fatal issues (e.g. a file vanished or was locked mid-zip): log and keep going.
            archive.on('warning', (err) => {
                logger.warn(`[Download] Archive warning for '${name}': ${err.code || err.message}`);
            });
            archive.on('end', () => {
                bandwidth.addDownloaded(archive.pointer());
                logger.info(`[Download] Completed: ${name} (${formatBytes(archive.pointer())} zipped)`);
            });

            // If the client disconnects mid-download, stop zipping instead of churning the disk.
            res.on('close', () => {
                if (!res.writableFinished) archive.abort();
            });

            res.attachment(`${name}.zip`);
            archive.pipe(res);
            archive.directory(itemPath, false);
            archive.finalize().catch(() => { /* surfaced via the 'error' handler above */ });
        }
    } catch (error) {
        logger.error(`[Download] Error for '${name}': ${error.code || error.message}`);
        if (!res.headersSent) res.status(500).send('Server error.');
    }
});

// Resolves a client multi-selection ([{ name, path, drive }]) to readable, stat'd paths.
// Sends the error response itself and returns null if any item is invalid or gone.
async function resolveSelection(items, req, res) {
    if (!Array.isArray(items) || items.length === 0) { res.status(400).send('No items provided.'); return null; }
    const resolved = [];
    for (const it of items) {
        const name = it && it.name;
        const driveId = (it && it.drive) || 'internal';
        if (typeof name !== 'string' || !name) { res.status(400).send('Invalid item name.'); return null; }
        if (!assertReadable(driveId, req, res)) return null;
        const itemPath = getSafePath(path.join(it.path || '/', name), driveId, req.user);
        if (!itemPath) { res.status(400).send('Invalid path.'); return null; }
        try { resolved.push({ name, path: it.path || '/', drive: driveId, itemPath, stats: await fs.promises.stat(itemPath) }); }
        catch { res.status(404).send(`'${name}' no longer exists.`); return null; }
    }
    return resolved;
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

// A multi-selection as one zip: each item at the archive root, folders with their contents.
apiRouter.post('/download-multiple', async (req, res) => {
    const selection = await resolveSelection(req.body && req.body.items, req, res);
    if (!selection) return;

    const entryNames = uniqueEntryNames(selection.map((s) => ({ name: s.name, isDirectory: s.stats.isDirectory() })));
    const entries = selection.map((s, i) => ({ itemPath: s.itemPath, entryName: entryNames[i], isDirectory: s.stats.isDirectory() }));

    logger.info(`[Download] Started: ${entries.length} items (zip) [IP: ${req.ip}]`);
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('error', (err) => {
        logger.error(`[Download] Archive error for ${entries.length} items: ${err.code || err.message}`);
        if (!res.headersSent) res.status(500).send('Error creating archive.');
        else res.destroy(err);
    });
    archive.on('warning', (err) => {
        logger.warn(`[Download] Archive warning for ${entries.length} items: ${err.code || err.message}`);
    });
    archive.on('end', () => {
        bandwidth.addDownloaded(archive.pointer());
        logger.info(`[Download] Completed: ${entries.length} items (${formatBytes(archive.pointer())} zipped)`);
    });
    res.on('close', () => {
        if (!res.writableFinished) archive.abort();
    });

    res.attachment('download.zip');
    archive.pipe(res);
    for (const { itemPath, entryName, isDirectory } of entries) {
        if (isDirectory) archive.directory(itemPath, entryName);
        else archive.file(itemPath, { name: entryName });
    }
    archive.finalize().catch(() => { /* surfaced via the 'error' handler above */ });
});

// Never exposes the share's on-disk path or drive.
function publicShare(rec) {
    return {
        token: rec.token,
        name: rec.name,
        type: rec.type,
        access: rec.access,
        createdAt: rec.createdAt,
        url: `/share/${rec.token}`,
    };
}

// Returns the existing link if the item is already shared.
apiRouter.post('/share', upload.none(), (req, res) => {
    const { name, path: currentPath = '/', drive: driveId = 'internal' } = req.body;
    if (!name) return res.status(400).send('Item name not provided.');
    if (!assertReadable(driveId, req, res)) return;
    const itemPath = getSafePath(path.join(currentPath, name), driveId, req.user);
    if (!itemPath) return res.status(400).send('Invalid path.');
    let stats;
    try { stats = fs.statSync(itemPath); }
    catch { return res.status(404).send('Item not found.'); }
    const rec = shareStore.create({
        ownerId: req.user.id,
        name, path: currentPath, drive: driveId,
        type: stats.isDirectory() ? 'folder' : 'file',
    });
    logger.info(`[Shares] Link ${rec.token} -> ${name} (${rec.access}) [IP: ${req.ip}]`);
    res.json({ share: publicShare(rec) });
});

// One link for several items, which viewers see as a folder holding them. Returns the
// existing link if this exact selection is already shared.
apiRouter.post('/share-multiple', async (req, res) => {
    const selection = await resolveSelection(req.body && req.body.items, req, res);
    if (!selection) return;
    const driveId = selection[0].drive;
    if (selection.some((s) => s.drive !== driveId)) return res.status(400).send('Items must be on the same drive.');
    const entryNames = uniqueEntryNames(selection.map((s) => ({ name: s.name, isDirectory: s.stats.isDirectory() })));
    const rec = shareStore.createSelection({
        ownerId: req.user.id,
        drive: driveId,
        items: selection.map((s, i) => ({ name: s.name, path: s.path, entryName: entryNames[i] })),
    });
    logger.info(`[Shares] Link ${rec.token} -> ${selection.length} items (${rec.access}) [IP: ${req.ip}]`);
    res.json({ share: publicShare(rec) });
});

apiRouter.get('/share', (req, res) => {
    const { name, path: currentPath = '/', drive: driveId = 'internal' } = req.query;
    if (!name) return res.status(400).send('Item name not provided.');
    const rec = shareStore.findByTarget(req.user.id, driveId, currentPath, name);
    res.json({ share: rec ? publicShare(rec) : null });
});

// access: 'public' (anyone with the link) or 'restricted' (owner only).
apiRouter.put('/share/:token', (req, res) => {
    if (!shareStore.isOwner(shareStore.get(req.params.token), req.user.id)) {
        return res.status(404).send('Share not found.');
    }
    const rec = shareStore.setAccess(req.params.token, req.body && req.body.access);
    if (!rec) return res.status(404).send('Share not found.');
    logger.info(`[Shares] Link ${rec.token} access set to ${rec.access} [IP: ${req.ip}]`);
    res.json({ share: publicShare(rec) });
});

apiRouter.delete('/share/:token', (req, res) => {
    if (!shareStore.isOwner(shareStore.get(req.params.token), req.user.id)) {
        return res.status(404).send('Share not found.');
    }
    const ok = shareStore.remove(req.params.token);
    if (!ok) return res.status(404).send('Share not found.');
    logger.info(`[Shares] Link ${req.params.token} revoked [IP: ${req.ip}]`);
    res.json({ success: true });
});

apiRouter.post('/extract', upload.none(), async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(403);
    const { name, path: currentPath, drive: driveId = 'internal' } = req.body;
    if (!assertWritable(driveId, req, res)) return;
    try {
        await runner.performExtract({ userId: req.user.id, name, path: currentPath, drive: driveId }, { strict: true });
        res.status(200).send('Extraction successful.');
    } catch (e) {
        if (e && e.status) return res.status(e.status).send(e.message);
        logger.error(`[Extract] Error:`, e);
        if (!res.headersSent) res.status(500).send('Error during extraction.');
    }
});

apiRouter.post('/compress', upload.none(), async (req, res) => {
    const { name, path: currentPath = '/', type, drive: driveId = 'internal' } = req.body;
    if (!assertWritable(driveId, req, res)) return;
    try {
        await runner.performCompress({ userId: req.user.id, name, path: currentPath, type, drive: driveId }, { strict: true });
        res.status(201).send('Compression successful.');
    } catch (e) {
        if (e && e.status) return res.status(e.status).send(e.message);
        logger.error(`[Compress] Error:`, e);
        res.status(500).send('Server error during compression.');
    }
});

apiRouter.post('/copy', upload.none(), async (req, res) => {
    const { name, path: currentPath = '/', drive: driveId = 'internal' } = req.body;
    if (!assertWritable(driveId, req, res)) return;
    try {
        await spaceCheck.check({
            userId: req.user.id, type: 'duplicate',
            items: [{ name, sourcePath: currentPath, sourceDrive: driveId }],
        });
        const { copyName } = await runner.performDuplicate({ userId: req.user.id, name, path: currentPath, drive: driveId });
        res.status(200).send(`Successfully copied to ${copyName}`);
    } catch (e) {
        if (e instanceof spaceCheck.InsufficientSpaceError) return sendInsufficientSpace(req, res, e, 'duplicate');
        if (e && e.status) return res.status(e.status).send(e.message);
        logger.error(`[Copy] Error:`, e);
        res.status(500).send('Error during copy.');
    }
});

// Copy or move into a chosen folder, possibly on another drive.
apiRouter.post('/transfer', upload.none(), async (req, res) => {
    // A large copy/move can run for minutes/hours with no bytes on the wire; never time it out.
    req.setTimeout(0);
    res.setTimeout(0);

    const {
        name,
        sourcePath = '/',
        sourceDrive = 'internal',
        destPath = '/',
        destDrive = 'internal',
        mode,
    } = req.body;

    if (!canReadDrive(sourceDrive, req.user)) return res.status(403).send('Drive not available for this account.');
    if (mode === 'move' && !assertWritable(sourceDrive, req, res)) return;
    if (!assertWritable(destDrive, req, res)) return;

    try {
        await spaceCheck.check({
            userId: req.user.id, type: mode, destDrive, destPath,
            items: [{ name, sourcePath, sourceDrive, conflict: req.body.conflict }],
        });
        const { destName } = await runner.performTransferItem(
            { userId: req.user.id, name, sourcePath, sourceDrive, destPath, destDrive, mode, conflict: req.body.conflict },
            { strictConflict: true },
        );
        const verb = mode === 'copy' ? 'Copied' : 'Moved';
        logger.info(`[Transfer] ${verb} '${name}' from '${sourcePath}' [${sourceDrive}] to '${destPath}' [${destDrive}] as '${destName}'`);
        res.status(200).send(`${verb} to ${destName}`);
    } catch (e) {
        if (e instanceof spaceCheck.InsufficientSpaceError) return sendInsufficientSpace(req, res, e, mode);
        if (e && e.status) return res.status(e.status).send(e.message);
        logger.error('[Transfer] Error:', e);
        res.status(500).send(`Error during ${mode === 'move' ? 'move' : 'copy'}.`);
    }
});

apiRouter.post('/create-folder', upload.none(), async (req, res) => {
  const { folder, path: currentPath = '/', drive: driveId = 'internal' } = req.body;
  if (!assertWritable(driveId, req, res)) return;
  try {
    await runner.performCreateFolder({ userId: req.user.id, folder, path: currentPath, drive: driveId });
    res.sendStatus(201);
  } catch (e) {
    if (e && e.status) return res.status(e.status).send(e.message);
    res.status(500).send('Failed to create folder.');
  }
});

apiRouter.post('/create-file', upload.none(), async (req, res) => {
  const { filename, path: currentPath = '/', drive: driveId = 'internal' } = req.body;
  if (!assertWritable(driveId, req, res)) return;
  try {
    await runner.performCreateFile({ userId: req.user.id, filename, path: currentPath, drive: driveId });
    res.sendStatus(201);
  } catch (e) {
    if (e && e.status) return res.status(e.status).send(e.message);
    res.status(500).send('Failed to create file.');
  }
});

apiRouter.post('/save-file', (req, res) => {
  const { name, path: currentPath = '/', drive: driveId = 'internal', content } = req.body;
  if (!name || typeof content !== 'string') return res.status(400).send('Invalid request.');
  if (!assertWritable(driveId, req, res)) return;
  const fullPath = getSafePath(path.join(currentPath, name), driveId, req.user);
  if (!fullPath) return res.status(400).send('Invalid path.');
  fs.stat(fullPath, (statErr, stats) => {
    if (statErr || !stats.isFile()) return res.status(404).send('File not found.');
    fs.writeFile(fullPath, content, 'utf8', err => {
      if (err) {
        logger.error(`[SaveFile] Error saving ${fullPath}:`, err);
        return res.status(500).send('Failed to save file.');
      }
      res.sendStatus(200);
    });
  });
});

apiRouter.post('/delete', upload.none(), async (req, res) => {
  const { name, path: currentPath = '/', drive: driveId = 'internal' } = req.body;
  if (!assertWritable(driveId, req, res)) return;
  try {
    await runner.performDelete({ userId: req.user.id, name, path: currentPath, drive: driveId });
    res.sendStatus(200);
  } catch (e) {
    if (e && e.status) return res.status(e.status).send(e.message);
    logger.error('[Delete] Error:', e);
    res.status(500).send('Delete failed.');
  }
});

// The client derives long-op progress from GET /operations, so it survives reloads and
// new tabs. The runner performs non-upload work and resumes it after a crash.
const VALID_OP_TYPES = ['copy', 'move', 'duplicate', 'upload', 'extract', 'compress', 'delete', 'rename', 'create-folder', 'create-file'];

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
    if (!canReadDrive(driveId, user)) {
      return { error: 'drive_unavailable', message: 'Your account does not have access to this drive.' };
    }
  }
  for (const driveId of needWrite) {
    if (!canWriteDrive(driveId, user)) {
      return { error: 'read_only_drive', message: 'This drive is read-only for your account.' };
    }
  }
  return null;
}

function sendInsufficientSpace(req, res, e, what) {
  logger.warn(`[Space] Refused ${what}: ${e.detail} [IP: ${req.ip}]`);
  res.status(507).json(e.toJSON());
}

apiRouter.post('/operations', async (req, res) => {
  try {
    const body = req.body || {};
    const { type, destDrive = 'internal', destPath = '/', message, clientId } = body;
    let items = body.items;
    if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
    if (!Array.isArray(items)) items = [];
    if (!VALID_OP_TYPES.includes(type)) return res.status(400).send('Invalid operation type.');
    if (items.length === 0) return res.status(400).send('No items provided.');

    const rows = items.map((it) => ({
      name: it.name,
      sourceDrive: it.sourceDrive || 'internal',
      sourcePath: it.sourcePath == null ? '/' : it.sourcePath,
      targetName: it.targetName || null,
      itemType: it.itemType || null,
      conflict: it.conflict || null,
      relPath: it.relPath || null,   // upload: per-file key (matches /upload-chunk + /upload-offset)
      size: it.size || 0,            // upload: total bytes, for byte-based progress
    }));

    // Before touching the disk: even a 409 would reveal what exists on a drive the account can't see.
    const denied = operationAccessError(type, destDrive, rows, req.user);
    if (denied) {
      logger.warn(`[Access] ${req.user.username} denied ${type} (${denied.error}) [IP: ${req.ip}]`);
      return res.status(403).json(denied);
    }

    // The runner treats a pre-existing target as "already done" (resume), so a fresh
    // clash must be rejected here.
    if (type === 'extract') {
      for (const it of items) {
        const base = getSafePath(it.sourcePath || '/', it.sourceDrive || 'internal', req.user);
        const ext = path.extname(it.name || '').toLowerCase();
        const dirName = (it.name || '').endsWith('.tar.gz') ? it.name.replace(/\.tar\.gz$/, '') : path.basename(it.name || '', ext);
        if (base && dirName && fs.existsSync(path.join(base, dirName))) {
          return res.status(409).send(items.length === 1 ? 'Folder already exists.' : `A folder named '${dirName}' already exists next to '${it.name}'.`);
        }
      }
    } else if (type === 'compress' && items.length === 1) {
      // Only a lone item has a fixed archive name; several items get one the runner picks free.
      const it = items[0] || {};
      const src = getSafePath(path.join(it.sourcePath || '/', it.name || ''), it.sourceDrive || 'internal', req.user);
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
apiRouter.post('/check-space', async (req, res) => {
  const { type, destDrive = 'internal', destPath = '/' } = req.body || {};
  let items = req.body && req.body.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
  if (!Array.isArray(items)) items = [];
  // Same access rule as POST /operations; no free-space figures without it.
  const denied = operationAccessError(type, destDrive, items.map((it) => ({ sourceDrive: (it && it.sourceDrive) || 'internal' })), req.user);
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

apiRouter.get('/operations', (req, res) => {
  const user = currentUser(req);
  if (req.query.all) return res.json(operationStore.listAll(user, Number(req.query.limit) || 50));
  res.json(operationStore.listActive(user));
});

// Ownership is always checked: a record carries paths and filenames from its owner's storage.
function ownedOp(req) {
  const rec = operationStore.get(req.params.id);
  if (!rec || rec.user !== currentUser(req)) return null;
  return rec;
}

apiRouter.get('/operations/:id', (req, res) => {
  const rec = ownedOp(req);
  if (!rec) return res.status(404).send('Operation not found.');
  res.json(rec);
});

// Uploads push progress and finalize here; any PATCH also counts as a heartbeat.
apiRouter.patch('/operations/:id', (req, res) => {
  const rec = ownedOp(req);
  if (!rec) return res.status(404).send('Operation not found.');
  const { progress, message, status, error } = req.body || {};
  if (progress !== undefined || message !== undefined) {
    operationStore.setProgress(req.params.id, progress !== undefined ? progress : rec.progress, message);
  }
  if (status) operationStore.finalize(req.params.id, status, error);
  else operationStore.heartbeat(req.params.id);
  res.json(operationStore.get(req.params.id));
});

// The runner stops between items once an op is marked canceled.
apiRouter.delete('/operations/:id', (req, res) => {
  const rec = ownedOp(req);
  if (!rec) return res.status(404).send('Operation not found.');
  operationStore.finalize(req.params.id, 'canceled');
  res.json({ ok: true });
});

apiRouter.post('/operations/:id/heartbeat', (req, res) => {
  if (!ownedOp(req)) return res.status(404).send('Operation not found.');
  operationStore.heartbeat(req.params.id);
  res.json({ ok: true });
});

// Lets the client resume an upload from the right byte offset.
apiRouter.get('/upload-offset', (req, res) => {
  const { file, opId } = req.query;
  let { path: currentPath = '/', drive: driveId = 'internal' } = req.query;
  if (!file) return res.json({ offset: 0 });
  // The destination comes from the op record. Another account's op counts as
  // missing, or its id would lend us its destination.
  if (opId) {
    const op = operationStore.get(opId);
    if (op && op.user === currentUser(req)) { currentPath = op.destPath || currentPath; driveId = op.destDrive || driveId; }
  }
  if (!assertReadable(driveId, req, res)) return;
  const targetBasePath = getSafePath(currentPath, driveId, req.user);
  if (!targetBasePath) return res.json({ offset: 0 });
  const rel = sanitizeUploadedRelativePath(decodeURIComponent(file), decodeURIComponent(file));
  const finalDestPath = path.resolve(path.join(targetBasePath, rel));
  if (!isPathInside(targetBasePath, finalDestPath)) return res.json({ offset: 0 });
  try { return res.json({ offset: fs.statSync(finalDestPath).size }); }
  catch { return res.json({ offset: 0 }); }
});

async function getDirectoryStats(dirPath) {
    let totalSize = 0;
    let fileCount = 0;

    async function walk(currentPath) {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else {
                const stats = await fs.promises.stat(fullPath);
                totalSize += stats.size;
                fileCount++;
            }
        }
    }

    try {
        await walk(dirPath);
        return { totalSize, fileCount };
    } catch (err) {
        logger.error(`Error calculating stats for ${dirPath}: ${err}`);
        return { totalSize: 0, fileCount: 0 };
    }
}

// Mounted before the authenticated apiRouter so these routes work without a login.
const shareViewRouter = express.Router();

// Sends the error response itself and returns null on failure.
function resolveShare(req, res) {
    const rec = shareStore.get(req.params.token);
    if (!rec) { res.status(404).json({ error: 'not_found' }); return null; }
    // 'restricted' means the owner only; any other signed-in account is a stranger.
    if (rec.access !== 'public' && !shareStore.isOwner(rec, req.session.userId)) {
        res.status(403).json({ error: 'login_required' }); return null;
    }
    // A link can't outlive its owner's access. Checked per view, so reinstating the
    // account brings its links back.
    const owner = userStore.getById(rec.ownerId);
    if (!owner || owner.status !== 'active' || !canReadDrive(rec.drive, owner)) {
        res.status(404).json({ error: 'gone' }); return null;
    }
    // Resolve inside the owner's storage, never the viewer's.
    if (rec.items) {
        // A multi-item share has no folder of its own: its root lists whichever items still exist.
        const entries = rec.items
            .map((it) => ({ name: it.entryName, abs: getSafePathForUser(path.join(it.path, it.name), rec.drive, rec.ownerId) }))
            .filter((e) => e.abs && fs.existsSync(e.abs));
        if (entries.length === 0) { res.status(404).json({ error: 'gone' }); return null; }
        return { rec, entries };
    }
    const root = getSafePathForUser(path.join(rec.path, rec.name), rec.drive, rec.ownerId);
    if (!root || !fs.existsSync(root)) { res.status(404).json({ error: 'gone' }); return null; }
    return { rec, root };
}

// Returns null if the subpath would escape the share. In a multi-item share the first
// segment picks the item, and its root (no subpath) has no single path on disk.
function resolveShareSubpath(r, subpath) {
    let root = r.root;
    let rest = subpath;
    if (r.entries) {
        const [first, ...tail] = subpath.split('/');
        const entry = r.entries.find((e) => e.name === first);
        if (!entry) return null;
        root = entry.abs;
        rest = tail.join('/');
    }
    if (!rest) return root;
    const target = path.resolve(path.join(root, rest));
    return isPathInside(root, target) ? target : null;
}

shareViewRouter.get('/:token', (req, res) => {
    const r = resolveShare(req, res); if (!r) return;
    const name = r.entries ? `${r.entries.length} ${r.entries.length === 1 ? 'item' : 'items'}` : r.rec.name;
    res.json({ name, type: r.rec.type, access: r.rec.access });
});

shareViewRouter.get('/:token/list', async (req, res) => {
    const r = resolveShare(req, res); if (!r) return;
    if (r.rec.type === 'file') return res.status(400).json({ error: 'not_a_folder' });
    const subpath = req.query.subpath || '';
    try {
        let children;
        if (r.entries && !subpath) {
            children = r.entries;
        } else {
            const target = resolveShareSubpath(r, subpath);
            if (!target) return res.status(400).json({ error: 'invalid_path' });
            const names = await fs.promises.readdir(target);
            children = names.filter((n) => !isHiddenSystemEntry(n)).map((n) => ({ name: n, abs: path.join(target, n) }));
        }
        const items = await Promise.all(children.map(async ({ name, abs }) => {
            try {
                const st = await fs.promises.stat(abs);
                return {
                    name,
                    type: st.isDirectory() ? 'folder' : 'file',
                    mtime: st.mtime,
                    size: st.isFile() ? st.size : undefined,
                };
            } catch { return null; }
        }));
        res.json(items.filter(Boolean));
    } catch (err) {
        logger.error(`[Shares] List failed for ${req.params.token}: ${err.message}`);
        res.status(500).json({ error: 'list_failed' });
    }
});

// Inline with range support, so shared videos can be scrubbed.
shareViewRouter.get('/:token/raw', countDownloadBytes, (req, res) => {
    const r = resolveShare(req, res); if (!r) return;
    const target = resolveShareSubpath(r, req.query.subpath || '');
    if (!target) return res.status(400).send('Invalid path.');
    let st;
    try { st = fs.statSync(target); } catch { return res.status(404).send('Not found.'); }
    if (!st.isFile()) return res.status(400).send('Not a file.');
    res.sendFile(target, (err) => {
        if (err && !res.headersSent) res.status(err.status || 500).end();
    });
});

// Streams a zip that `fill(archive)` populates; stops zipping if the viewer disconnects.
function streamShareZip(res, fileName, fill) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).send('Error creating archive.');
        else res.destroy(err);
    });
    archive.on('end', () => bandwidth.addDownloaded(archive.pointer()));
    res.on('close', () => { if (!res.writableFinished) archive.abort(); });
    res.attachment(fileName);
    archive.pipe(res);
    fill(archive);
    archive.finalize().catch(() => { /* surfaced via 'error' above */ });
}

shareViewRouter.get('/:token/download', countDownloadBytes, (req, res) => {
    const r = resolveShare(req, res); if (!r) return;
    const subpath = req.query.subpath || '';
    // The root of a multi-item share downloads every item it holds, side by side.
    if (r.entries && !subpath) {
        logger.info(`[Shares] Download ${req.params.token}: ${r.entries.length} items [IP: ${req.ip}]`);
        return streamShareZip(res, 'download.zip', (archive) => {
            for (const e of r.entries) {
                if (fs.statSync(e.abs).isDirectory()) archive.directory(e.abs, e.name);
                else archive.file(e.abs, { name: e.name });
            }
        });
    }
    const target = resolveShareSubpath(r, subpath);
    if (!target) return res.status(400).send('Invalid path.');
    let st;
    try { st = fs.statSync(target); } catch { return res.status(404).send('Not found.'); }
    const baseName = path.basename(target);

    if (st.isFile()) {
        logger.info(`[Shares] Download ${req.params.token}: ${baseName} [IP: ${req.ip}]`);
        const stream = fs.createReadStream(target);
        stream.on('open', () => { res.attachment(baseName); stream.pipe(res); });
        stream.on('end', () => bandwidth.addDownloaded(st.size));
        stream.on('error', (err) => {
            if (!res.headersSent) res.status(500).send('Error reading file.');
            else res.destroy(err);
        });
    } else {
        logger.info(`[Shares] Download ${req.params.token}: ${baseName} (folder) [IP: ${req.ip}]`);
        streamShareZip(res, `${baseName}.zip`, (archive) => archive.directory(target, false));
    }
});

// Requires the current password, so a borrowed session can't lock the real owner out.
apiRouter.post('/account/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'New password must be at least 8 characters.' });
  }
  const ok = typeof currentPassword === 'string'
    && await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!ok) {
    await new Promise(r => setTimeout(r, 300));
    return res.status(401).json({ error: 'wrong_password', message: 'Current password is incorrect.' });
  }
  userStore.setPassword(req.user.id, await bcrypt.hash(newPassword, BCRYPT_COST));
  logger.info(`[Account] '${req.user.username}' changed their password [IP: ${req.ip}]`);
  res.json({ ok: true });
});

apiRouter.get('/admin/users', requireOwner, (req, res) => {
  res.json({ accounts: userStore.list().map(userStore.publicShape) });
});

// Needs no old password, which is why it is owner-only.
apiRouter.post('/admin/users/:id/password', requireOwner, async (req, res) => {
  const { newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
  }
  const target = userStore.getById(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  userStore.setPassword(target.id, await bcrypt.hash(newPassword, BCRYPT_COST));
  logger.info(`[Admin] '${req.user.username}' reset the password for '${target.username}' [IP: ${req.ip}]`);
  res.json({ ok: true });
});

// requireLogin re-reads the account per request, so suspension ends open sessions immediately.
apiRouter.post('/admin/users/:id/status', requireOwner, (req, res) => {
  const status = req.body && req.body.status === 'active' ? 'active' : 'suspended';
  const target = userStore.getById(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'cannot_suspend_owner' });
  const updated = userStore.setStatus(target.id, status);
  logger.info(`[Admin] '${req.user.username}' set status=${status} for '${target.username}' [IP: ${req.ip}]`);
  res.json({ account: userStore.publicShape(updated) });
});

apiRouter.post('/admin/users/:id/drives', requireOwner, (req, res) => {
  const mode = ['none', 'ro', 'rw'].includes(req.body && req.body.externalDrives)
    ? req.body.externalDrives : 'ro';
  const target = userStore.getById(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  const updated = userStore.setExternalDrives(target.id, mode);
  logger.info(`[Admin] '${req.user.username}' set externalDrives=${mode} for '${target.username}' [IP: ${req.ip}]`);
  res.json({ account: userStore.publicShape(updated) });
});

// Removing the files is irreversible, so it is opt-in (?deleteFiles=1).
apiRouter.delete('/admin/users/:id', requireOwner, async (req, res) => {
  const target = userStore.getById(req.params.id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'cannot_delete_owner' });

  const deleteFiles = req.query.deleteFiles === '1' || req.query.deleteFiles === 'true';
  for (const rec of shareStore.listByOwner(target.id)) shareStore.remove(rec.token);
  userStore.remove(target.id);
  if (deleteFiles) {
    const root = userRootById(target.id);
    await fs.promises.rm(root, { recursive: true, force: true }).catch((e) => {
      logger.error(`[Admin] Could not remove storage for '${target.username}': ${e.message}`);
    });
  }
  logger.info(`[Admin] '${req.user.username}' deleted account '${target.username}'${deleteFiles ? ' and its files' : ' (files kept)'} [IP: ${req.ip}]`);
  res.json({ ok: true, filesDeleted: deleteFiles });
});

app.use('/api/public/share', shareViewRouter);

app.use('/api', apiRouter);

// Must stay after all API and static routes.
app.get('/{*splat}', (req, res) => {
  res.sendFile(SPA_INDEX);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const activeSockets = new Set();

server.on('connection', (socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
});

server.on('upgrade', (request, socket, head) => {
    sessionParser(request, {}, () => {
        // Search walks the filesystem, so the socket must carry an authenticated account.
        const user = request.session.loggedIn && request.session.userId
            ? userStore.getById(request.session.userId)
            : null;
        if (!user || user.status !== 'active') {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        request.searchUser = user;
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
});

wss.on('connection', (ws, request) => {
    const wsUser = request && request.searchUser;
    let isClientSearching = false;
    let currentSearchDrive = 'internal';
    
    ws.on('message', async (message) => {
        let parsedMessage;
        try { parsedMessage = JSON.parse(message); } catch (e) { return; }

        if (parsedMessage.type === 'stop_search') {
            isClientSearching = false; return;
        }

        if (parsedMessage.type === 'start_search' && parsedMessage.query) {
            isClientSearching = true;
            currentSearchDrive = parsedMessage.drive || 'internal';
            const query = parsedMessage.query;
            const queryLower = query.toLowerCase();
            const searchedPaths = new Set();
            
            // Re-read per search: the socket outlives the upgrade-time check.
            const searchUser = wsUser && userStore.getById(wsUser.id);
            if (!searchUser || searchUser.status !== 'active' || !canReadDrive(currentSearchDrive, searchUser)) {
                isClientSearching = false;
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'search_complete' }));
                return;
            }
            const searchRoot = getDriveRoot(currentSearchDrive, searchUser);
            if (!searchRoot) {
                isClientSearching = false;
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'search_complete' }));
                return;
            }

            const checkFileContent = (filePath) => {
                return new Promise((resolve) => {
                    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
                    let found = false;
                    stream.on('data', chunk => {
                        if (!isClientSearching) { stream.destroy(); found = false; return; }
                        if (chunk.toLowerCase().includes(queryLower)) { found = true; stream.destroy(); }
                    });
                    stream.on('close', () => resolve(found));
                    stream.on('error', () => resolve(false));
                });
            };

            const performSearch = async (currentDir) => {
                if (!isClientSearching) return;
                try {
                    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (!isClientSearching) break;
                        const fullPath = path.join(currentDir, entry.name);
                        
                        if (isHiddenSystemEntry(entry.name)) {
                            continue;
                        }
                        
                        if (searchedPaths.has(fullPath)) continue;
                        const relativePath = path.sep + path.relative(searchRoot, currentDir);
                        let foundInName = false;

                        if (entry.name.toLowerCase().includes(queryLower)) {
                            try {
                                const stats = fs.statSync(fullPath); 
                                const result = {
                                    name: entry.name,
                                    path: relativePath.replace(/\\/g, '/'),
                                    type: entry.isDirectory() ? 'folder' : 'file',
                                    mtime: stats.mtime,
                                    drive: currentSearchDrive
                                };
                                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'search_result', data: result }));
                                searchedPaths.add(fullPath);
                                foundInName = true;
                            } catch (statErr) {
                                // Skip files we can't stat
                            }
                        }

                        if (!foundInName && entry.isFile() && SEARCHABLE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
                            const contentMatch = await checkFileContent(fullPath);
                            if (isClientSearching && contentMatch) { 
                                try {
                                    const stats = fs.statSync(fullPath); 
                                    const result = {
                                        name: entry.name,
                                        path: relativePath.replace(/\\/g, '/'),
                                        type: 'file',
                                        mtime: stats.mtime,
                                        drive: currentSearchDrive
                                    };
                                    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'search_result', data: result }));
                                    searchedPaths.add(fullPath);
                                } catch (statErr) {
                                    // Skip files we can't stat
                                }
                            }
                        }
                        if (entry.isDirectory()) await performSearch(fullPath);
                    }
                } catch (error) { 
                    // Unreadable directories are skipped quietly.
                    if (error.code !== 'EPERM' && error.code !== 'EACCES') {
                        logger.error(`[Search] Error in directory ${currentDir}:`, error); 
                    }
                }
            };
            
            try { await performSearch(searchRoot); } catch (error) {
                if (isClientSearching && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'search_error', message: 'Error during search.' }));
            } finally {
                if (isClientSearching && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'search_complete' }));
            }
        }
    });
    ws.on('close', () => isClientSearching = false);
});

// 0 = infinite. A big copy/move/download can sit with no bytes flowing for a long time.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.timeout = 0;

// The migration below runs only when no accounts exist AND this legacy data is present,
// so a fresh install's first visitor gets signup instead of a seeded account.
function hasLegacySingleUserData() {
  let loose = [];
  try {
    loose = fs.readdirSync(CONTENT_DIR).filter((e) => e !== 'u' && e !== 'cache');
  } catch { /* no content dir yet: nothing to adopt */ }
  if (loose.length > 0) return true;
  if (shareStore.listOrphans().length > 0) return true;
  try {
    if (operationStore.countByUser(LEGACY_USERNAME) > 0) return true;
  } catch { /* store unavailable; fall through */ }
  return false;
}

function migrateSingleUserInstall() {
  if (userStore.count() > 0) return;
  if (!LEGACY_PASSWORD_HASH) return;
  if (!hasLegacySingleUserData()) return;

  let owner;
  try {
    owner = userStore.create({
      username: LEGACY_USERNAME,
      passwordHash: LEGACY_PASSWORD_HASH,
      role: 'owner',
      externalDrives: 'rw',
    });
  } catch (e) {
    logger.error(`[Migration] Could not create the owner account: ${e.message}`);
    return;
  }

  const root = userRootById(owner.id);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    logger.error(`[Migration] Could not create the owner's storage root: ${e.message}`);
    return;
  }

  // Everything in content/ except 'cache' and 'u' (the account roots) belonged to that user.
  let moved = 0;
  for (const entry of fs.readdirSync(CONTENT_DIR)) {
    if (entry === 'u' || entry === 'cache') continue;
    try {
      fs.renameSync(path.join(CONTENT_DIR, entry), path.join(root, entry));
      moved++;
    } catch (e) {
      logger.error(`[Migration] Could not move '${entry}' into the owner's storage: ${e.message}`);
    }
  }

  let adopted = 0;
  for (const rec of shareStore.listOrphans()) { shareStore.setOwner(rec.token, owner.id); adopted++; }
  const reassigned = operationStore.reassignUser(LEGACY_USERNAME, owner.id);

  logger.info(`[Migration] Upgraded the single-user install: owner '${owner.username}' (${owner.id}), ${moved} item(s) moved, ${adopted} share(s) adopted, ${reassigned} operation(s) reassigned.`);
}

let operationReaper = null;

(async () => {
    try {
        await networkStats.init();
        resolveExternalTools();
        await detectExternalDrives();

        server.listen(PORT, () => {
            logger.boot({
                port: PORT,
                drives: ['internal', ...detectedDrives.map(driveTag)],
                workers: numCPUs,
            });
            logger.info(`[Startup] Ready, serving on port ${PORT}`);

            // Resume jobs that were mid-flight when the process last died.
            runner.init({ getSafePath: getSafePathForUser, isPathInside, findFreeTransferName, uniqueEntryNames });
            spaceCheck.init({ getSafePath: getSafePathForUser, driveName, formatBytes });
            operationStore.requeueUnfinished();
            runner.start();
            // Mark uploads abandoned by a vanished client as interrupted.
            operationReaper = setInterval(() => operationStore.reapStaleUploads(60000), 20000);
        });
    } catch (error) {
        logger.error(`[Server Start] Failed: ${error.message}`);
        process.exit(1);
    }
})();

const gracefulShutdown = async (signal) => {
    logger.rule(`shutdown · ${signal}`);
    const shutdownTimeout = setTimeout(() => process.exit(1), 5000);

    const clientCount = wss.clients.size;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.terminate();
    });
    activeSockets.forEach(socket => socket.destroy());
    logger.step(`Dropped ${clientCount} websocket client${clientCount === 1 ? '' : 's'}`, 'ok');

    // An in-flight item is left non-completed so it resumes on next boot.
    runner.stop();
    if (operationReaper) clearInterval(operationReaper);
    operationStore.close();
    logger.step('Parked in-flight operations · closed operation store', 'ok');

    try {
        bandwidth.persist();
        logger.step('Flushed bandwidth counters', 'ok');
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
        logger.step('Closed HTTP and websocket servers', 'ok');
        await networkStats.shutdown();
        sizeWorkerPool.forEach(worker => worker.terminate());
        logger.step(`Terminated ${sizeWorkerPool.length} size worker${sizeWorkerPool.length === 1 ? '' : 's'}`, 'ok');
        clearTimeout(shutdownTimeout);
        logger.rule('');
        process.exit(0);
    } catch (error) {
        logger.step(`Shutdown failed: ${error.message}`, 'fail');
        clearTimeout(shutdownTimeout);
        logger.rule('');
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Last-resort net: a stray I/O 'error' (e.g. EBUSY on a file mid copy/move) must not
// take the whole server down.
process.on('uncaughtException', (err) => {
    logger.error(`[UncaughtException] ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`[UnhandledRejection] ${reason && reason.stack ? reason.stack : reason}`);
});
