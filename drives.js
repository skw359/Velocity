// Storage roots: each account's private folder ('internal') and the external drives
// detected on this machine, plus the per-account rules for reaching them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const disk = require('./disk-space');
const config = require('./config');
const logger = require('./logger');
const { IS_WINDOWS, isPathInside, resolveInside } = require('./paths');

const CONTENT_DIR = config.CONTENT_DIR;

// Drive id -> root path. 'internal' is absent: it resolves per account (see getDriveRoot).
const driveRoots = new Map();

let detectedDrives = [];
let lastDriveScan = 0;
let fixedDrives = null;
const DRIVE_SCAN_INTERVAL = 5000; // ms

// Both platform back ends return { id, letter, label, type, path, size, freeSpace }.
// `letter` is null on Linux. `id` is sent back as ?drive= and keys driveRoots, so it
// must be URL-safe and stable across rescans.
async function detectExternalDrives() {
    if (fixedDrives) return fixedDrives;
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

// Replaces detection with a fixed list. The test suite uses it to stand up external
// drives in temporary folders; null restores normal detection.
function useFixedDrives(list) {
    driveRoots.clear();
    fixedDrives = list ? list.map((d) => ({ letter: null, type: 'local', size: 0, freeSpace: 0, label: d.id, ...d })) : null;
    detectedDrives = fixedDrives || [];
    lastDriveScan = 0;
    for (const drive of detectedDrives) driveRoots.set(drive.id, drive.path);
}

function getDetectedDrives() {
    return detectedDrives;
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
        const psCommand = 'Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 } | Select-Object DeviceID, VolumeName, DriveType, Size, FreeSpace | ConvertTo-Json -Compress';

        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { encoding: 'utf8', timeout: 10000, windowsHide: true }, (error, stdout) => {
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
        return userRootById(user.id);
    }
    // Unknown drive ids also fail closed, so a typo never lands in internal storage.
    return driveRoots.get(driveId) || null;
}

// Account ids are generated hex, but the id becomes a path segment, so anything else is refused.
function userRootById(userId) {
    return typeof userId === 'string' && /^[A-Za-z0-9_-]+$/.test(userId) ? path.join(CONTENT_DIR, 'u', userId) : null;
}

// Thumbnails and transcodes live in the account's own tree so no other account can
// reach them.
function userCacheDir(user) {
    const root = user && userRootById(user.id);
    if (!root) return null;
    const dir = path.join(root, 'cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    return dir;
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

// subpath is relative to the drive root; null when it can't be used (unknown drive,
// malformed input, or a path that leaves the root, lexically or through a link).
function getSafePath(subpath, driveId = 'internal', user = null) {
    const driveRoot = getDriveRoot(driveId, user);
    if (!driveRoot) return null;
    return resolveInside(driveRoot, subpath == null ? '/' : subpath);
}

// For the operation runner and space checks, which hold only an account id. Write
// permission is checked at enqueue time by the routes, not here.
function getSafePathForUser(subpath, driveId, userId) {
    return getSafePath(subpath, driveId, userId ? { id: userId } : null);
}

module.exports = {
    CONTENT_DIR,
    detectExternalDrives,
    useFixedDrives,
    getDetectedDrives,
    driveTag,
    driveName,
    isHiddenSystemEntry,
    getDriveRoot,
    userRootById,
    userCacheDir,
    canReadDrive,
    canWriteDrive,
    getSafePath,
    getSafePathForUser,
};
