// Chunked, resumable uploads.
//
// A file arrives as fixed-size chunks written at their own offsets, so a resent chunk
// overwrites rather than appends. The server checks everything it is told: chunk indexes
// and counts must agree with the declared size, each chunk must carry exactly its share of
// bytes, a chunk can only extend a file that already holds every byte before it (no holes),
// and the last chunk completes the file only once its size on disk is exactly the declared
// size. Resume offsets come from what this upload recorded as received, never from the
// size of whatever file happens to be at the path.

const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const logger = require('../logger');
const bandwidth = require('../bandwidth');
const drives = require('../drives');
const operationStore = require('../operation-store');
const spaceCheck = require('../space-check');
const media = require('../media');
const dirSize = require('../dir-size');
const { sanitizeUploadedRelativePath, resolveInside, ensureDir } = require('../paths');
const { str, formatBytes, assertWritable, assertReadable, sendInsufficientSpace } = require('./helpers');

const CHUNK_SIZE = 10 * 1024 * 1024; // MUST match CHUNK_SIZE in client/src/hooks/useUpload.js
// A chunk whose connection sends nothing for this long is abandoned, freeing its file for
// the client's retry (the server has no other request timeout).
const CHUNK_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

class UploadError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function count(value) {
    const s = String(value == null ? '' : value).trim();
    return /^\d{1,15}$/.test(s) ? Number(s) : NaN;
}

function decodeHeader(value, fallback) {
    if (value == null || value === '') return fallback;
    try {
        return decodeURIComponent(String(value));
    } catch {
        throw new UploadError(400, 'Malformed upload header.');
    }
}

function expectedChunkCount(totalSize) {
    return Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));
}

function chunkLength(index, totalChunks, totalSize) {
    return index === totalChunks - 1 ? totalSize - index * CHUNK_SIZE : CHUNK_SIZE;
}

function parseChunkHeaders(req) {
    const h = req.headers;
    const fileName = decodeHeader(h['x-file-name'], '');
    if (!fileName) throw new UploadError(400, 'Missing file name.');
    const meta = {
        fileName,
        relativePath: decodeHeader(h['x-relative-path'], fileName),
        currentPath: decodeHeader(h['x-current-path'], '/'),
        driveId: decodeHeader(h['x-drive-id'], 'internal'),
        chunkIndex: count(h['x-chunk-index']),
        totalChunks: count(h['x-total-chunks']),
        totalFileSize: count(h['x-total-file-size']),
        opId: str(h['x-op-id']) || null,
    };
    if (!Number.isSafeInteger(meta.totalFileSize)) throw new UploadError(400, 'Invalid file size.');
    if (!Number.isSafeInteger(meta.totalChunks) || meta.totalChunks !== expectedChunkCount(meta.totalFileSize)) {
        throw new UploadError(400, 'Chunk count does not match the file size.');
    }
    if (!Number.isSafeInteger(meta.chunkIndex) || meta.chunkIndex >= meta.totalChunks) {
        throw new UploadError(400, 'Chunk index out of range.');
    }
    meta.start = meta.chunkIndex * CHUNK_SIZE;
    meta.length = chunkLength(meta.chunkIndex, meta.totalChunks, meta.totalFileSize);
    meta.isLast = meta.chunkIndex === meta.totalChunks - 1;
    const declared = h['content-length'];
    if (declared !== undefined && count(declared) !== meta.length) {
        throw new UploadError(400, `Chunk ${meta.chunkIndex} must be ${meta.length} bytes.`);
    }
    return meta;
}

// Passes bytes through, failing as soon as more than `limit` arrive.
function byteLimit(limit) {
    let seen = 0;
    const t = new Transform({
        transform(chunk, encoding, cb) {
            seen += chunk.length;
            if (seen > limit) return cb(new UploadError(400, 'Chunk is larger than declared.'));
            cb(null, chunk);
        },
    });
    t.bytes = () => seen;
    return t;
}

// One chunk at a time per destination file, so the hole and size checks can't race a
// concurrent chunk for the same file (the client already sends them in order).
const fileLocks = new Map();
async function withFileLock(key, fn) {
    const prev = fileLocks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const chained = prev.then(() => mine);
    fileLocks.set(key, chained);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (fileLocks.get(key) === chained) fileLocks.delete(key);
    }
}

async function fileSize(file) {
    try {
        return (await fs.promises.stat(file)).size;
    } catch {
        return -1;
    }
}

// The upload record's item for this file, if the op exists and belongs to the caller.
function trackedItem(req, opId, relativePath, fileName) {
    if (!opId) return null;
    const op = operationStore.getMeta(opId);
    if (!op || op.user !== req.user.id || op.type !== 'upload') return null;
    return operationStore.findUploadItem(opId, relativePath, fileName);
}

// Bytes of this upload known to be on disk: the op's record, never more than the file holds.
async function resumeOffset(item, destPath) {
    if (!item) return 0;
    const size = await fileSize(destPath);
    return Math.max(0, Math.min(size, item.bytesReceived || 0));
}

// Batch summaries for the log, per account and upload operation.
const uploadSessions = new Map();
const SESSION_IDLE_MS = 10 * 60 * 1000;
function noteFileStarted(key, size, ip) {
    let session = uploadSessions.get(key);
    if (!session) {
        session = { fileCount: 0, totalSize: 0, startTime: Date.now(), clientIp: ip, timer: null };
        uploadSessions.set(key, session);
    }
    session.fileCount++;
    session.totalSize += size;
    // Forgotten if the batch goes quiet without completing, so the map can't grow forever.
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => uploadSessions.delete(key), SESSION_IDLE_MS);
    session.timer.unref();
}
function noteFileCompleted(key) {
    const session = uploadSessions.get(key);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    // Log the batch summary once no other file completes for 3s.
    session.timer = setTimeout(() => {
        const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
        logger.info(`[Upload Session] Completed: ${session.fileCount} files (${formatBytes(session.totalSize)}) in ${duration}s [IP: ${session.clientIp}]`);
        uploadSessions.delete(key);
    }, 3000);
    session.timer.unref();
}

module.exports = function uploadRoutes() {
    const router = express.Router();

    router.post('/upload-chunk', async (req, res) => {
        let meta;
        try {
            meta = parseChunkHeaders(req);
        } catch (e) {
            return res.status(e.status || 400).json({ error: 'invalid_chunk', message: e.message });
        }
        const { fileName, relativePath, currentPath, driveId, chunkIndex, totalFileSize, opId, start, length, isLast } = meta;

        if (!assertWritable(driveId, req, res)) return;
        const targetBasePath = drives.getSafePath(currentPath, driveId, req.user);
        if (!targetBasePath) return res.status(400).send('Invalid base path.');

        const sanitizedRelativePath = sanitizeUploadedRelativePath(relativePath, fileName);
        const finalDestPath = resolveInside(targetBasePath, sanitizedRelativePath);
        if (!finalDestPath || finalDestPath === targetBasePath) {
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

        const item = trackedItem(req, opId, relativePath, fileName);
        const sessionKey = `${req.user.id}:${opId || '-'}`;
        req.setTimeout(CHUNK_IDLE_TIMEOUT_MS, () => {
            req.destroy(Object.assign(new Error('Chunk upload stalled.'), { code: 'ECONNABORTED' }));
        });
        // The timeout belongs to the socket, which keep-alive reuses: clear it once this
        // chunk is answered, so a later long request on the connection isn't cut off.
        res.once('finish', () => { if (req.socket) req.socket.setTimeout(0); });

        try {
            await withFileLock(finalDestPath, async () => {
                if (chunkIndex === 0) {
                    await ensureDir(path.dirname(finalDestPath));
                    if (sanitizedRelativePath !== relativePath.replace(/\\/g, path.sep).replace(/\//g, path.sep)) {
                        logger.warn(`[Upload] Sanitized upload path: ${relativePath} -> ${sanitizedRelativePath} [Drive: ${driveId}] [IP: ${req.ip}]`);
                    }
                    noteFileStarted(sessionKey, totalFileSize, req.ip);
                    logger.info(`[Upload] Started: ${sanitizedRelativePath} (${formatBytes(totalFileSize)}) -> ${currentPath} [Drive: ${driveId}] [IP: ${req.ip}]`);
                } else if (await fileSize(finalDestPath) < start) {
                    // An earlier chunk is missing: writing here would leave a hole.
                    throw new UploadError(409, 'Upload out of order; resume from the server offset.', {
                        error: 'upload_out_of_order',
                        offset: await resumeOffset(item, finalDestPath),
                    });
                }

                // Chunk 0 truncates, so a restarted file never keeps a stale tail.
                const limiter = byteLimit(length);
                const out = fs.createWriteStream(finalDestPath, { flags: chunkIndex === 0 ? 'w' : 'r+', start });
                try {
                    // pipeline closes the file even when the client goes away mid-chunk.
                    await pipeline(req, limiter, out);
                } finally {
                    bandwidth.addUploaded(limiter.bytes());
                }
                if (limiter.bytes() !== length) {
                    throw new UploadError(400, `Chunk ${chunkIndex} is incomplete (${limiter.bytes()} of ${length} bytes).`);
                }

                if (isLast) {
                    // Anything past the declared size is a stale tail from an earlier, longer file.
                    const fh = await fs.promises.open(finalDestPath, 'r+');
                    let size;
                    try {
                        if ((await fh.stat()).size > totalFileSize) await fh.truncate(totalFileSize);
                        size = (await fh.stat()).size;
                    } finally {
                        await fh.close();
                    }
                    if (size !== totalFileSize) {
                        throw new UploadError(409, `File is incomplete (${size} of ${totalFileSize} bytes).`, {
                            error: 'upload_incomplete',
                            offset: await resumeOffset(item, finalDestPath),
                        });
                    }
                }
            });
        } catch (e) {
            if (e instanceof UploadError) {
                if (!req.complete) req.resume();
                logger.warn(`[Upload] Refused chunk ${chunkIndex} of ${sanitizedRelativePath}: ${e.message} [IP: ${req.ip}]`);
                if (!res.headersSent) res.status(e.status).json({ error: 'invalid_chunk', message: e.message, ...e.extra });
                return;
            }
            if (e && (e.code === 'ERR_STREAM_PREMATURE_CLOSE' || e.code === 'ECONNRESET' || e.code === 'ECONNABORTED')) {
                logger.warn(`[Upload] Client went away during chunk ${chunkIndex} of ${sanitizedRelativePath}`);
                return;
            }
            logger.error(`[Upload] Write error for ${sanitizedRelativePath} at "${finalDestPath}" [Drive: ${driveId}] [IP: ${req.ip}]: ${e && e.stack ? e.stack : e}`);
            if (!res.headersSent) res.status(500).send(e && e.code === 'ENOSPC' ? 'The drive is full.' : 'Write failed.');
            return;
        }

        // Only the caller's own op, so another account's op id can't be advanced or completed.
        if (item) {
            try {
                operationStore.setItemBytes(opId, item.id, start + length);
                if (isLast) {
                    operationStore.itemDone(opId, item.id);
                    if (operationStore.allItemsDone(opId)) operationStore.finalize(opId, 'completed');
                }
            } catch (e) {
                logger.error(`[Upload] op tracking failed: ${e.message}`);
            }
        }

        if (isLast) {
            logger.info(`[Upload] Completed: ${sanitizedRelativePath} (${formatBytes(totalFileSize)})`);
            dirSize.invalidate(finalDestPath);
            media.enqueue(finalDestPath, drives.userCacheDir(req.user));
            noteFileCompleted(sessionKey);
        }
        res.status(200).send('Chunk received.');
    });

    // Where a resumed upload should continue: the bytes this upload operation recorded for
    // the file. Without the caller's own upload record there is nothing to resume from.
    router.get('/upload-offset', async (req, res) => {
        const file = str(req.query.file);
        const opId = str(req.query.opId);
        if (!file || !opId) return res.json({ offset: 0 });
        const op = operationStore.getMeta(opId);
        if (!op || op.user !== req.user.id || op.type !== 'upload') return res.json({ offset: 0 });
        const driveId = op.destDrive || 'internal';
        if (!assertReadable(driveId, req, res)) return;
        const targetBasePath = drives.getSafePath(op.destPath || '/', driveId, req.user);
        if (!targetBasePath) return res.json({ offset: 0 });
        const finalDestPath = resolveInside(targetBasePath, sanitizeUploadedRelativePath(file, path.basename(file.replace(/\\/g, '/'))));
        if (!finalDestPath) return res.json({ offset: 0 });
        const item = operationStore.findUploadItem(opId, file, path.basename(file.replace(/\\/g, '/')));
        res.json({ offset: await resumeOffset(item, finalDestPath) });
    });

    return router;
};

module.exports.CHUNK_SIZE = CHUNK_SIZE;
