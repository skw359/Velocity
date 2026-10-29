// Small helpers shared by the route modules.

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const bandwidth = require('../bandwidth');
const drives = require('../drives');
const { isValidItemName } = require('../paths');

function formatBytes(bytes, decimals = 1) {
    if (!(bytes > 0)) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// A request field as a string. Repeated query keys arrive as arrays and JSON bodies can
// hold anything, so a non-string gets the fallback instead of reaching path code.
function str(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

// Sends the 403 itself, so callers read as `if (!assertWritable(...)) return;`.
function assertWritable(driveId, req, res) {
    if (drives.canWriteDrive(driveId, req.user)) return true;
    logger.warn(`[Access] ${req.user && req.user.username} denied write to drive ${driveId} [IP: ${req.ip}]`);
    res.status(403).json({ error: 'read_only_drive', message: 'This drive is read-only for your account.' });
    return false;
}

// A JSON 403 (not requireLogin's bare one), so the client reports it instead of logging out.
function assertReadable(driveId, req, res) {
    if (drives.canReadDrive(driveId, req.user)) return true;
    logger.warn(`[Access] ${req.user && req.user.username} denied read of drive ${driveId} [IP: ${req.ip}]`);
    res.status(403).json({ error: 'drive_unavailable', message: 'Your account does not have access to this drive.' });
    return false;
}

function sendInsufficientSpace(req, res, e, what) {
    logger.warn(`[Space] Refused ${what}: ${e.detail} [IP: ${req.ip}]`);
    res.status(507).json(e.toJSON());
}

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

// Resolves a client multi-selection ([{ name, path, drive }]) to readable, stat'd paths.
// Sends the error response itself and returns null if any item is invalid or gone.
async function resolveSelection(items, req, res) {
    if (!Array.isArray(items) || items.length === 0) { res.status(400).send('No items provided.'); return null; }
    if (items.length > 10000) { res.status(400).send('Too many items selected.'); return null; }
    const resolved = [];
    for (const it of items) {
        const name = it && it.name;
        const driveId = str(it && it.drive, 'internal') || 'internal';
        const dir = str(it && it.path, '/') || '/';
        if (!isValidItemName(name)) { res.status(400).send('Invalid item name.'); return null; }
        if (!assertReadable(driveId, req, res)) return null;
        const itemPath = drives.getSafePath(path.join(dir, name), driveId, req.user);
        if (!itemPath) { res.status(400).send('Invalid path.'); return null; }
        try { resolved.push({ name, path: dir, drive: driveId, itemPath, stats: await fs.promises.stat(itemPath) }); }
        catch { res.status(404).send(`'${name}' no longer exists.`); return null; }
    }
    return resolved;
}

module.exports = {
    formatBytes,
    str,
    assertWritable,
    assertReadable,
    sendInsufficientSpace,
    countDownloadBytes,
    resolveSelection,
};
