// Share links: management for signed-in owners, and the public view anyone with a link
// (or, for a restricted link, only its owner) can open.

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const logger = require('../logger');
const bandwidth = require('../bandwidth');
const drives = require('../drives');
const shareStore = require('../share-store');
const userStore = require('../user-store');
const { isValidItemName, resolveInside, uniqueEntryNames } = require('../paths');
const { sendUserFile, applyUserContentHeaders } = require('../user-content');
const { str, assertReadable, resolveSelection, countDownloadBytes } = require('./helpers');

const form = multer({ limits: { fields: 20, fieldSize: 64 * 1024, files: 0, parts: 30 } }).none();

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

// Sends the error response itself and returns null on failure.
function resolveShare(req, res) {
    const rec = shareStore.get(str(req.params.token));
    if (!rec) { res.status(404).json({ error: 'not_found' }); return null; }
    // 'restricted' means the owner only; any other signed-in account is a stranger.
    if (rec.access !== 'public' && !shareStore.isOwner(rec, req.session.userId)) {
        res.status(403).json({ error: 'login_required' }); return null;
    }
    // A link can't outlive its owner's access. Checked per view, so reinstating the
    // account brings its links back.
    const owner = userStore.getById(rec.ownerId);
    if (!owner || owner.status !== 'active' || !drives.canReadDrive(rec.drive, owner)) {
        res.status(404).json({ error: 'gone' }); return null;
    }
    // Resolve inside the owner's storage, never the viewer's.
    if (rec.items) {
        // A multi-item share has no folder of its own: its root lists whichever items still exist.
        const entries = rec.items
            .map((it) => ({ name: it.entryName, abs: drives.getSafePathForUser(path.join(it.path, it.name), rec.drive, rec.ownerId) }))
            .filter((e) => e.abs && fs.existsSync(e.abs));
        if (entries.length === 0) { res.status(404).json({ error: 'gone' }); return null; }
        return { rec, entries };
    }
    const root = drives.getSafePathForUser(path.join(rec.path, rec.name), rec.drive, rec.ownerId);
    if (!root || !fs.existsSync(root)) { res.status(404).json({ error: 'gone' }); return null; }
    return { rec, root };
}

// Returns null if the subpath would escape the share (lexically or through a link) or
// names something the listing hides. In a multi-item share the first segment picks the
// item, and its root (no subpath) has no single path on disk.
function resolveShareSubpath(r, subpath) {
    const segments = String(subpath).split(/[\\/]/).filter(Boolean);
    if (segments.some((seg) => seg === '..' || drives.isHiddenSystemEntry(seg))) return null;
    let root = r.root;
    let rest = segments;
    if (r.entries) {
        const entry = r.entries.find((e) => e.name === segments[0]);
        if (!entry) return null;
        root = entry.abs;
        rest = segments.slice(1);
    }
    return rest.length ? resolveInside(root, rest.join('/')) : root;
}

// Streams a zip that `fill(archive)` populates; stops zipping if the viewer disconnects.
function streamShareZip(res, fileName, fill) {
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).send('Error creating archive.');
        else res.destroy(err);
    });
    archive.on('warning', (err) => logger.warn(`[Shares] Archive warning: ${err.code || err.message}`));
    archive.on('end', () => bandwidth.addDownloaded(archive.pointer()));
    res.on('close', () => { if (!res.writableFinished) archive.abort(); });
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.attachment(fileName);
    archive.pipe(res);
    fill(archive);
    archive.finalize().catch(() => { /* surfaced via 'error' above */ });
}

// Management, mounted behind requireLogin.
function shareRoutes() {
    const router = express.Router();

    // Returns the existing link if the item is already shared.
    router.post('/share', form, (req, res) => {
        const name = str(req.body.name);
        const currentPath = str(req.body.path, '/') || '/';
        const driveId = str(req.body.drive, 'internal') || 'internal';
        if (!name) return res.status(400).send('Item name not provided.');
        if (!isValidItemName(name)) return res.status(400).send('Invalid path.');
        if (!assertReadable(driveId, req, res)) return;
        const itemPath = drives.getSafePath(path.join(currentPath, name), driveId, req.user);
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
    router.post('/share-multiple', async (req, res) => {
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

    router.get('/share', (req, res) => {
        const name = str(req.query.name);
        if (!name) return res.status(400).send('Item name not provided.');
        const rec = shareStore.findByTarget(req.user.id, str(req.query.drive, 'internal') || 'internal', str(req.query.path, '/') || '/', name);
        res.json({ share: rec ? publicShare(rec) : null });
    });

    // access: 'public' (anyone with the link) or 'restricted' (owner only).
    router.put('/share/:token', (req, res) => {
        if (!shareStore.isOwner(shareStore.get(req.params.token), req.user.id)) {
            return res.status(404).send('Share not found.');
        }
        const rec = shareStore.setAccess(req.params.token, req.body && req.body.access);
        if (!rec) return res.status(404).send('Share not found.');
        logger.info(`[Shares] Link ${rec.token} access set to ${rec.access} [IP: ${req.ip}]`);
        res.json({ share: publicShare(rec) });
    });

    router.delete('/share/:token', (req, res) => {
        if (!shareStore.isOwner(shareStore.get(req.params.token), req.user.id)) {
            return res.status(404).send('Share not found.');
        }
        const ok = shareStore.remove(req.params.token);
        if (!ok) return res.status(404).send('Share not found.');
        logger.info(`[Shares] Link ${req.params.token} revoked [IP: ${req.ip}]`);
        res.json({ success: true });
    });

    return router;
}

// The public view: no login required (restricted links check the owner's session).
function publicShareRoutes() {
    const router = express.Router();

    router.get('/:token', (req, res) => {
        const r = resolveShare(req, res); if (!r) return;
        const name = r.entries ? `${r.entries.length} ${r.entries.length === 1 ? 'item' : 'items'}` : r.rec.name;
        res.json({ name, type: r.rec.type, access: r.rec.access });
    });

    router.get('/:token/list', async (req, res) => {
        const r = resolveShare(req, res); if (!r) return;
        if (r.rec.type === 'file') return res.status(400).json({ error: 'not_a_folder' });
        const subpath = str(req.query.subpath);
        try {
            let children;
            if (r.entries && !subpath) {
                children = r.entries;
            } else {
                const target = resolveShareSubpath(r, subpath);
                if (!target) return res.status(400).json({ error: 'invalid_path' });
                const names = await fs.promises.readdir(target);
                children = names.filter((n) => !drives.isHiddenSystemEntry(n)).map((n) => ({ name: n, abs: path.join(target, n) }));
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

    // Inline with range support, so shared videos can be scrubbed; anything a browser could
    // run as a page downloads instead (see user-content.js).
    router.get('/:token/raw', countDownloadBytes, (req, res) => {
        const r = resolveShare(req, res); if (!r) return;
        const target = resolveShareSubpath(r, str(req.query.subpath));
        if (!target) return res.status(400).send('Invalid path.');
        let st;
        try { st = fs.statSync(target); } catch { return res.status(404).send('Not found.'); }
        if (!st.isFile()) return res.status(400).send('Not a file.');
        sendUserFile(req, res, target, { crossOrigin: true });
    });

    router.get('/:token/download', countDownloadBytes, (req, res) => {
        const r = resolveShare(req, res); if (!r) return;
        const subpath = str(req.query.subpath);
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
            stream.on('open', () => {
                applyUserContentHeaders(res, target, { crossOrigin: true, forceDownload: true });
                stream.pipe(res);
            });
            stream.on('end', () => bandwidth.addDownloaded(st.size));
            stream.on('error', (err) => {
                if (!res.headersSent) res.status(500).send('Error reading file.');
                else res.destroy(err);
            });
            res.on('close', () => stream.destroy());
        } else {
            logger.info(`[Shares] Download ${req.params.token}: ${baseName} (folder) [IP: ${req.ip}]`);
            streamShareZip(res, `${baseName}.zip`, (archive) => archive.directory(target, false));
        }
    });

    return router;
}

module.exports = { shareRoutes, publicShareRoutes };
