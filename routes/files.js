// Browsing, previews, downloads and the single-item file actions.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const disk = require('../disk-space');
const logger = require('../logger');
const bandwidth = require('../bandwidth');
const drives = require('../drives');
const runner = require('../operation-runner');
const spaceCheck = require('../space-check');
const media = require('../media');
const dirSize = require('../dir-size');
const { isPathInside, isValidItemName, sanitizePathSegment, uniqueEntryNames } = require('../paths');
const {
    str, formatBytes, assertReadable, assertWritable, sendInsufficientSpace, resolveSelection,
} = require('./helpers');

// Form fields only, never files; check-conflicts can carry a long list of names.
const form = multer({ limits: { fields: 50, fieldSize: 8 * 1024 * 1024, files: 0, parts: 60 } }).none();

// Common query/body fields with their defaults.
function target(src) {
    const s = src || {};
    return {
        name: str(s.name),
        path: str(s.path, '/') || '/',
        drive: str(s.drive, 'internal') || 'internal',
    };
}

// Answers a perform* failure: its own status if it carries one, else 500 with `fallback`.
function sendOpFailure(req, res, e, what, fallback) {
    if (e instanceof spaceCheck.InsufficientSpaceError) return sendInsufficientSpace(req, res, e, what);
    if (e && e.status) return res.status(e.status).send(e.message);
    logger.error(`[${what}] Error:`, e);
    if (!res.headersSent) res.status(500).send(fallback);
}

// Saves edited text so a crash or a full disk mid-save leaves the previous version rather
// than a truncated file: the text goes to a hidden temporary file beside the original,
// which is then renamed over it. A rename would replace the file's identity, so it is
// written in place as before when that matters: another account owns it (a shared drive),
// it has other hard links, or Windows refuses the rename because the file is open.
async function saveTextFile(fullPath, content, stats) {
    const ownedByUs = typeof process.getuid !== 'function' || stats.uid === process.getuid();
    if (!ownedByUs || stats.nlink > 1) {
        await fs.promises.writeFile(fullPath, content, 'utf8');
        return;
    }
    const tmp = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
        await fs.promises.writeFile(tmp, content, 'utf8');
        await fs.promises.chmod(tmp, stats.mode & 0o7777);
        try {
            await fs.promises.rename(tmp, fullPath);
            return;
        } catch (err) {
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
        }
        await fs.promises.writeFile(fullPath, content, 'utf8');
    } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
}

function streamZip(req, res, label, fileName, fill) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    // archiver's 'error' is fatal and would crash the process if left unhandled.
    archive.on('error', (err) => {
        logger.error(`[Download] Archive error for ${label}: ${err.code || err.message}`);
        if (!res.headersSent) res.status(500).send('Error creating archive.');
        else res.destroy(err);
    });
    // Non-fatal issues (e.g. a file vanished or was locked mid-zip): log and keep going.
    archive.on('warning', (err) => {
        logger.warn(`[Download] Archive warning for ${label}: ${err.code || err.message}`);
    });
    archive.on('end', () => {
        bandwidth.addDownloaded(archive.pointer());
        logger.info(`[Download] Completed: ${label} (${formatBytes(archive.pointer())} zipped)`);
    });
    // If the client disconnects mid-download, stop zipping instead of churning the disk.
    res.on('close', () => {
        if (!res.writableFinished) archive.abort();
    });
    res.attachment(fileName);
    archive.pipe(res);
    fill(archive);
    archive.finalize().catch(() => { /* surfaced via the 'error' handler above */ });
}

module.exports = function fileRoutes() {
    const router = express.Router();

    router.get('/drives', async (req, res) => {
        try {
            // An account with no external-drive grant must not even learn they exist.
            const externalDrives = req.user.externalDrives === 'none'
                ? []
                : await drives.detectExternalDrives();

            res.json([
                { id: 'internal', label: 'Internal Storage', type: 'internal', letter: null },
                ...externalDrives.map(({ id, letter, label, type, size, freeSpace }) => ({ id, letter, label, type, size, freeSpace })),
            ]);
        } catch (error) {
            logger.error('[API /drives] Error:', error);
            res.status(500).json({ error: 'Failed to detect drives' });
        }
    });

    router.get('/storage', async (req, res) => {
        const driveId = str(req.query.drive, 'internal') || 'internal';
        if (!assertReadable(driveId, req, res)) return;
        try {
            const driveRoot = drives.getDriveRoot(driveId, req.user);
            if (!driveRoot) return res.status(404).send('Drive not found.');
            // An account's own folder may not exist yet; an external drive's root is never
            // created (that would make a directory where an unmounted disk should be).
            if (driveId === 'internal') await fs.promises.mkdir(driveRoot, { recursive: true }).catch(() => {});
            const { free, total } = await disk.check(driveRoot);
            res.json({ used: total - free, total, driveId });
        } catch (err) {
            logger.error('Error getting disk usage:', err);
            res.status(500).send('Could not retrieve disk usage information.');
        }
    });

    router.get('/list', async (req, res) => {
        const requestedPath = str(req.query.path, '/') || '/';
        const driveId = str(req.query.drive, 'internal') || 'internal';
        if (!drives.canReadDrive(driveId, req.user)) return res.status(403).send('Drive not available for this account.');
        const targetPath = drives.getSafePath(requestedPath, driveId, req.user);
        if (!targetPath) return res.status(400).send('Invalid path.');

        try {
            const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
            const filesWithStats = await Promise.all(
                entries.filter(e => !drives.isHiddenSystemEntry(e.name))
                .map(async (e) => {
                    try {
                        const stats = await fs.promises.stat(path.join(targetPath, e.name));
                        const isDir = stats.isDirectory();
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
    router.post('/check-conflicts', form, async (req, res) => {
        const { path: currentPath, drive: driveId } = target(req.body);
        if (!assertReadable(driveId, req, res)) return;

        const targetBasePath = drives.getSafePath(currentPath, driveId, req.user);
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

    router.get('/get-size', async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.query);
        if (!name) return res.status(400).send('Item name not provided.');
        if (!isValidItemName(name)) return res.status(400).send('Invalid path.');
        if (!assertReadable(driveId, req, res)) return;
        const itemPath = drives.getSafePath(path.join(currentPath, name), driveId, req.user);
        if (!itemPath) return res.status(400).send('Invalid path.');
        if (!fs.existsSync(itemPath)) return res.status(404).send('Item not found.');
        try {
            const { size } = await dirSize.measure(itemPath);
            res.json({ size });
        } catch (err) {
            logger.error(`[Size] Could not size ${itemPath}: ${err.message}`);
            res.status(500).send('Could not calculate size.');
        }
    });

    router.get('/info', async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.query);
        if (!name) return res.status(400).send('Name is required.');
        if (!isValidItemName(name)) return res.status(404).send('Item not found.');
        if (!assertReadable(driveId, req, res)) return;

        const targetPath = drives.getSafePath(path.join(currentPath, name), driveId, req.user);
        if (!targetPath || !fs.existsSync(targetPath)) return res.status(404).send('Item not found.');

        try {
            const stats = await fs.promises.stat(targetPath);
            const info = {
                name,
                created: stats.birthtime,
                modified: stats.mtime,
                size: 0,
                count: 0,
                type: stats.isDirectory() ? 'folder' : 'file'
            };

            if (stats.isDirectory()) {
                const dirStats = await dirSize.measure(targetPath);
                info.size = dirStats.size;
                info.count = dirStats.files;
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
    router.post('/info-multiple', async (req, res) => {
        const selection = await resolveSelection(req.body && req.body.items, req, res);
        if (!selection) return;

        try {
            const info = { files: 0, folders: 0, size: 0, count: 0, modified: null };
            for (const { stats, itemPath } of selection) {
                if (stats.isDirectory()) {
                    const dirStats = await dirSize.measure(itemPath);
                    info.folders++;
                    info.size += dirStats.size;
                    info.count += dirStats.files;
                } else {
                    info.files++;
                    info.size += stats.size;
                    info.count++;
                }
                if (!info.modified || stats.mtime > info.modified) info.modified = stats.mtime;
            }
            res.json(info);
        } catch (err) {
            logger.error(`[Info] Error sizing a selection: ${err.message}`);
            res.status(500).send('Error retrieving file info.');
        }
    });

    // Cached per account. The key covers drive, path, size and mtime: two images can't share
    // a thumbnail (as 'a/b.jpg' and 'a_b.jpg' used to), and an edited image gets a new one.
    router.get('/thumbnail', async (req, res) => {
        const imagePath = str(req.query.path).replace(/^\/+/, '');
        const driveId = str(req.query.drive, 'internal') || 'internal';
        if (!imagePath) return res.status(400).send('Image path is required.');
        if (!assertReadable(driveId, req, res)) return;

        const fullPath = drives.getSafePath(imagePath, driveId, req.user);
        let stats = null;
        try { if (fullPath) stats = await fs.promises.stat(fullPath); } catch { /* missing */ }
        if (!stats || !stats.isFile()) return res.status(404).send('Image not found.');

        const cacheDir = drives.userCacheDir(req.user);
        if (!cacheDir) return res.status(404).send('Image not found.');
        const key = crypto.createHash('sha256')
            .update(`${driveId}\0${fullPath}\0${stats.size}\0${stats.mtimeMs}`)
            .digest('hex').slice(0, 40);
        const thumbDir = path.join(cacheDir, 'thumbs');
        const thumbPath = path.join(thumbDir, `${key}.jpg`);

        try {
            if (!fs.existsSync(thumbPath)) {
                await fs.promises.mkdir(thumbDir, { recursive: true });
                const tmp = path.join(thumbDir, `.tmp-${crypto.randomBytes(6).toString('hex')}.jpg`);
                try {
                    await sharp(fullPath)
                        .resize({ width: 100, height: 100, fit: 'cover' })
                        .jpeg({ quality: 50 })
                        .toFile(tmp);
                    await fs.promises.rename(tmp, thumbPath);
                } finally {
                    await fs.promises.rm(tmp, { force: true }).catch(() => {});
                }
            }
            res.sendFile(thumbPath, { dotfiles: 'allow' });
        } catch (err) {
            logger.error(`[Thumbnail] Failed to generate thumbnail for ${imagePath}: ${err.message}`);
            if (!res.headersSent) res.status(500).send('Could not generate thumbnail.');
        }
    });

    router.post('/rename', form, async (req, res) => {
        const oldName = str(req.body.oldName);
        const newName = str(req.body.newName);
        const { path: currentPath, drive: driveId } = target(req.body);
        if (oldName && newName && oldName === newName) return res.status(200).send('No changes were made.');
        if (!assertWritable(driveId, req, res)) return;
        try {
            await runner.performRename({ userId: req.user.id, oldName, newName, path: currentPath, drive: driveId });
            logger.info(`Successfully renamed '${oldName}' to '${newName}' in path '${currentPath}' on drive '${driveId}'`);
            res.status(200).send('Rename successful.');
        } catch (e) {
            sendOpFailure(req, res, e, 'Rename', 'Failed to rename the item.');
        }
    });

    // Previews made by the transcoding queue live in the account's cache folder, which
    // /content serves as /content/cache/<name>.
    function previewLookup(req, res, nameFor) {
        const sourcePath = str(req.query.path);
        if (!sourcePath) return res.status(400).json({ message: 'Missing file path.' });
        const cacheDir = drives.userCacheDir(req.user);
        const fileName = nameFor(path.basename(sourcePath.replace(/\\/g, '/')));
        if (!cacheDir || !isValidItemName(fileName)) return res.status(404).json({ message: 'Preview not available or still processing.' });
        fs.access(path.join(cacheDir, fileName), fs.constants.F_OK, (err) => {
            if (err) return res.status(404).json({ message: 'Preview not available or still processing.' });
            res.json({ previewUrl: `/content/cache/${encodeURIComponent(fileName)}` });
        });
    }

    router.get('/preview/raw', (req, res) => previewLookup(req, res, media.rawPreviewName));
    router.get('/preview/video', (req, res) => previewLookup(req, res, media.videoPreviewName));

    router.get('/download', async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.query);
        if (!drives.canReadDrive(driveId, req.user)) return res.status(403).send('Drive not available for this account.');
        if (!isValidItemName(name)) return res.status(400).send('Invalid path.');
        const itemPath = drives.getSafePath(path.join(currentPath, name), driveId, req.user);
        if (!itemPath) return res.status(400).send('Invalid path.');

        let stats;
        try {
            stats = await fs.promises.stat(itemPath);
        } catch (error) {
            logger.error(`[Download] Error for '${name}': ${error.code || error.message}`);
            return res.status(error.code === 'ENOENT' ? 404 : 500).send(error.code === 'ENOENT' ? 'Not found.' : 'Server error.');
        }
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
            res.on('close', () => fileStream.destroy());
        } else {
            // Folders stream as a zip built on the fly, never buffered in memory.
            logger.info(`[Download] Started: ${name} (folder) from ${currentPath} [IP: ${req.ip}]`);
            streamZip(req, res, `'${name}'`, `${name}.zip`, (archive) => archive.directory(itemPath, false));
        }
    });

    // A multi-selection as one zip: each item at the archive root, folders with their contents.
    router.post('/download-multiple', async (req, res) => {
        const selection = await resolveSelection(req.body && req.body.items, req, res);
        if (!selection) return;

        const entryNames = uniqueEntryNames(selection.map((s) => ({ name: s.name, isDirectory: s.stats.isDirectory() })));
        logger.info(`[Download] Started: ${selection.length} items (zip) [IP: ${req.ip}]`);
        streamZip(req, res, `${selection.length} items`, 'download.zip', (archive) => {
            selection.forEach((s, i) => {
                if (s.stats.isDirectory()) archive.directory(s.itemPath, entryNames[i]);
                else archive.file(s.itemPath, { name: entryNames[i] });
            });
        });
    });

    router.post('/extract', form, async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.body);
        if (!assertWritable(driveId, req, res)) return;
        try {
            await runner.performExtract({ userId: req.user.id, name, path: currentPath, drive: driveId }, { strict: true });
            res.status(200).send('Extraction successful.');
        } catch (e) {
            sendOpFailure(req, res, e, 'Extract', 'Error during extraction.');
        }
    });

    router.post('/compress', form, async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.body);
        const type = str(req.body.type);
        if (!assertWritable(driveId, req, res)) return;
        try {
            await runner.performCompress({ userId: req.user.id, name, path: currentPath, type, drive: driveId }, { strict: true });
            res.status(201).send('Compression successful.');
        } catch (e) {
            sendOpFailure(req, res, e, 'Compress', 'Server error during compression.');
        }
    });

    router.post('/copy', form, async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.body);
        if (!assertWritable(driveId, req, res)) return;
        try {
            await spaceCheck.check({
                userId: req.user.id, type: 'duplicate',
                items: [{ name, sourcePath: currentPath, sourceDrive: driveId }],
            });
            const { copyName } = await runner.performDuplicate({ userId: req.user.id, name, path: currentPath, drive: driveId });
            res.status(200).send(`Successfully copied to ${copyName}`);
        } catch (e) {
            sendOpFailure(req, res, e, 'Copy', 'Error during copy.');
        }
    });

    // Copy or move into a chosen folder, possibly on another drive.
    router.post('/transfer', form, async (req, res) => {
        // A large copy/move can run for minutes/hours with no bytes on the wire; never time it out.
        req.setTimeout(0);
        res.setTimeout(0);

        const name = str(req.body.name);
        const sourcePath = str(req.body.sourcePath, '/') || '/';
        const sourceDrive = str(req.body.sourceDrive, 'internal') || 'internal';
        const destPath = str(req.body.destPath, '/') || '/';
        const destDrive = str(req.body.destDrive, 'internal') || 'internal';
        const mode = str(req.body.mode);
        const conflict = str(req.body.conflict) || undefined;

        if (!drives.canReadDrive(sourceDrive, req.user)) return res.status(403).send('Drive not available for this account.');
        if (mode === 'move' && !assertWritable(sourceDrive, req, res)) return;
        if (!assertWritable(destDrive, req, res)) return;

        try {
            await spaceCheck.check({
                userId: req.user.id, type: mode, destDrive, destPath,
                items: [{ name, sourcePath, sourceDrive, conflict }],
            });
            const { destName } = await runner.performTransferItem(
                { userId: req.user.id, name, sourcePath, sourceDrive, destPath, destDrive, mode, conflict },
                { strictConflict: true },
            );
            const verb = mode === 'copy' ? 'Copied' : 'Moved';
            logger.info(`[Transfer] ${verb} '${name}' from '${sourcePath}' [${sourceDrive}] to '${destPath}' [${destDrive}] as '${destName}'`);
            res.status(200).send(`${verb} to ${destName}`);
        } catch (e) {
            sendOpFailure(req, res, e, 'Transfer', `Error during ${mode === 'move' ? 'move' : 'copy'}.`);
        }
    });

    router.post('/create-folder', form, async (req, res) => {
        const folder = str(req.body.folder);
        const { path: currentPath, drive: driveId } = target(req.body);
        if (!assertWritable(driveId, req, res)) return;
        try {
            await runner.performCreateFolder({ userId: req.user.id, folder, path: currentPath, drive: driveId });
            res.sendStatus(201);
        } catch (e) {
            sendOpFailure(req, res, e, 'CreateFolder', 'Failed to create folder.');
        }
    });

    router.post('/create-file', form, async (req, res) => {
        const filename = str(req.body.filename);
        const { path: currentPath, drive: driveId } = target(req.body);
        if (!assertWritable(driveId, req, res)) return;
        try {
            await runner.performCreateFile({ userId: req.user.id, filename, path: currentPath, drive: driveId });
            res.sendStatus(201);
        } catch (e) {
            sendOpFailure(req, res, e, 'CreateFile', 'Failed to create file.');
        }
    });

    router.post('/save-file', (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.body);
        const content = req.body && req.body.content;
        if (!name || typeof content !== 'string') return res.status(400).send('Invalid request.');
        if (!isValidItemName(name)) return res.status(400).send('Invalid path.');
        if (!assertWritable(driveId, req, res)) return;
        const fullPath = drives.getSafePath(path.join(currentPath, name), driveId, req.user);
        if (!fullPath) return res.status(400).send('Invalid path.');
        fs.stat(fullPath, (statErr, stats) => {
            if (statErr || !stats.isFile()) return res.status(404).send('File not found.');
            saveTextFile(fullPath, content, stats).then(() => {
                dirSize.invalidate(fullPath);
                res.sendStatus(200);
            }, (err) => {
                logger.error(`[SaveFile] Error saving ${fullPath}:`, err);
                res.status(500).send(err.code === 'ENOSPC' ? 'The drive is full.' : 'Failed to save file.');
            });
        });
    });

    router.post('/delete', form, async (req, res) => {
        const { name, path: currentPath, drive: driveId } = target(req.body);
        if (!assertWritable(driveId, req, res)) return;
        try {
            await runner.performDelete({ userId: req.user.id, name, path: currentPath, drive: driveId });
            res.sendStatus(200);
        } catch (e) {
            sendOpFailure(req, res, e, 'Delete', 'Delete failed.');
        }
    });

    return router;
};
