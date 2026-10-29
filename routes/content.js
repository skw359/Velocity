// Direct file URLs used by previews and media players: /content/* is the signed-in
// account's own storage, /drive/:driveId/* an external drive it may read.

const fs = require('fs');
const express = require('express');
const logger = require('../logger');
const drives = require('../drives');
const auth = require('../auth');
const { resolveInside } = require('../paths');
const { sendUserFile } = require('../user-content');
const { countDownloadBytes, formatBytes } = require('./helpers');

// Resolves the request path inside root and sends the file. Dot-segments are refused like a
// static server's defaults; directories are never listed or served (no index.html).
function serveFromRoot(root, req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.set('Allow', 'GET, HEAD');
        return res.sendStatus(405);
    }
    let relative;
    try {
        relative = decodeURIComponent(req.path);
    } catch {
        return res.sendStatus(400);
    }
    if (relative.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return res.sendStatus(404);
    const fullPath = resolveInside(root, relative);
    if (!fullPath) return res.sendStatus(404);

    fs.stat(fullPath, (err, stats) => {
        if (err || !stats.isFile()) return res.sendStatus(404);
        if (req.method === 'GET' && !req.headers.range) {
            logger.info(`[Access] ${req.user.username} ${relative} (${formatBytes(stats.size)}) [IP: ${req.ip}]`);
        }
        sendUserFile(req, res, fullPath);
    });
}

module.exports = function contentRoutes() {
    const router = express.Router();

    router.use('/content', auth.requireLogin, countDownloadBytes, (req, res) => {
        const root = drives.getDriveRoot('internal', req.user);
        if (!root) return res.status(404).send('No storage for this account.');
        serveFromRoot(root, req, res);
    });

    router.use('/drive/:driveId', auth.requireLogin, countDownloadBytes, (req, res) => {
        const driveId = req.params.driveId;
        if (!drives.canReadDrive(driveId, req.user)) {
            return res.status(403).send('Drive not available for this account.');
        }
        const driveRoot = drives.getDriveRoot(driveId, req.user);
        if (!driveRoot) return res.status(404).send('Drive not found');
        serveFromRoot(driveRoot, req, res);
    });

    return router;
};
