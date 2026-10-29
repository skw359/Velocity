// Builds the server: middleware, routes and the search WebSocket. start() adds the
// background work (drive detection, the operation runner, the upload reaper) and listens.

const http = require('http');
const path = require('path');
const express = require('express');
const morgan = require('morgan');

const config = require('./config');
const logger = require('./logger');
const auth = require('./auth');
const security = require('./security');
const SqliteSessionStore = require('./session-store');
const drives = require('./drives');
const paths = require('./paths');
const runner = require('./operation-runner');
const spaceCheck = require('./space-check');
const operationStore = require('./operation-store');
const networkStats = require('./network-stats');
const bandwidth = require('./bandwidth');
const media = require('./media');
const dirSize = require('./dir-size');
const { attachSearch } = require('./search');
const { fontAwesome } = require('./fa-cache');
const { formatBytes } = require('./routes/helpers');
const authRoutes = require('./routes/auth');
const contentRoutes = require('./routes/content');
const fileRoutes = require('./routes/files');
const uploadRoutes = require('./routes/uploads');
const operationRoutes = require('./routes/operations');
const accountRoutes = require('./routes/account');
const systemRoutes = require('./routes/system');
const { shareRoutes, publicShareRoutes } = require('./routes/shares');

const SPA_INDEX = path.join(config.APP_DIR, 'client', 'dist', 'index.html');

// JSON bodies are parsed only after sign-in, and only these routes may send large ones
// (a saved file, the item list of a big upload).
const LARGE_JSON_ROUTES = new Set(['/save-file', '/operations', '/check-space']);
const smallJson = express.json({ limit: '1mb' });
const largeJson = express.json({ limit: '50mb' });
function apiJson(req, res, next) {
    return (LARGE_JSON_ROUTES.has(req.path) ? largeJson : smallJson)(req, res, next);
}

// Polling endpoints and chunks (logged with more detail) stay out of the request log.
function isQuietRequest(req) {
    const url = req.url || req.originalUrl;
    const isPolling = url.includes('/cpu-utilization') ||
                      url.includes('/network-stats') ||
                      url.includes('/bandwidth') ||
                      url.includes('/storage') ||
                      url.includes('/drives');
    const isUploadChunk = url.includes('/upload-chunk');
    const isOpPolling = (req.method === 'GET' && url.includes('/operations')) ||
                        url.includes('/upload-offset') ||
                        url.includes('/heartbeat');
    return isPolling || isUploadChunk || isOpPolling;
}

// Express's own handler would send stack traces whenever NODE_ENV isn't 'production'.
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    let status = err.status || err.statusCode || 500;
    if (err.name === 'MulterError') status = err.code === 'LIMIT_FIELD_VALUE' ? 413 : 400;
    if (status >= 500) logger.error(`[HTTP] ${req.method} ${req.originalUrl} failed: ${err.stack || err}`);
    res.status(status).json(status >= 500
        ? { error: 'server_error', message: 'Something went wrong on the server.' }
        : { error: err.type || 'bad_request', message: err.expose === false ? 'Bad request.' : String(err.message || 'Bad request.') });
}

// Hands the runner and the space checks the helpers they resolve paths with.
function wireModules() {
    runner.init({
        getSafePath: drives.getSafePathForUser,
        isPathInside: paths.isPathInside,
        findFreeTransferName: paths.findFreeTransferName,
        uniqueEntryNames: paths.uniqueEntryNames,
        changed: dirSize.invalidate,
    });
    spaceCheck.init({ getSafePath: drives.getSafePathForUser, driveName: drives.driveName, formatBytes });
}

// Returns { app, server, wss, sessionStore, listen(port, host), close() }.
function createApp() {
    wireModules();
    const app = express();
    app.set('trust proxy', config.TRUST_PROXY);
    app.disable('x-powered-by');

    app.use(morgan(logger.morganFormat, { stream: logger.stream, skip: isQuietRequest }));
    app.use(security.securityHeaders());
    app.use(security.refuseCrossSite);

    // Static assets need no session, so they are served before one is loaded.
    app.use(express.static(path.join(config.APP_DIR, 'public')));
    app.use('/assets', express.static(path.join(config.APP_DIR, 'assets')));
    // Fetched from the CDN on first hit, then served same-origin (CSP-safe) from disk.
    app.use('/vendor/fontawesome', fontAwesome);
    app.use(express.static(path.join(config.APP_DIR, 'client', 'dist'), { index: false }));

    const sessionStore = new SqliteSessionStore();
    const sessionMiddleware = auth.createSessionMiddleware(sessionStore);
    app.use(sessionMiddleware);

    app.use(authRoutes({ spaIndex: SPA_INDEX }));
    app.use(contentRoutes());
    // Mounted before the authenticated API so these work without a login.
    app.use('/api/public/share', publicShareRoutes());

    const api = express.Router();
    api.use(auth.requireLogin);
    api.use(apiJson);
    api.use(systemRoutes());
    api.use(fileRoutes());
    api.use(uploadRoutes());
    api.use(operationRoutes());
    api.use(shareRoutes());
    api.use(accountRoutes({ sessionStore }));
    api.use((req, res) => res.status(404).json({ error: 'not_found' }));
    app.use('/api', api);

    // Must stay after all API and static routes.
    app.get('/{*splat}', (req, res) => res.sendFile(SPA_INDEX));
    app.use(errorHandler);

    const server = http.createServer(app);
    // 0 = infinite. A big copy/move/download can sit with no bytes flowing for a long time.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.keepAliveTimeout = 0;
    server.timeout = 0;

    const activeSockets = new Set();
    server.on('connection', (socket) => {
        activeSockets.add(socket);
        socket.on('close', () => activeSockets.delete(socket));
    });

    const wss = attachSearch(server, { sessionMiddleware });

    function listen(port = config.PORT, host = config.HOST) {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                resolve(server.address());
            });
        });
    }

    async function close() {
        for (const client of wss.clients) client.terminate();
        await new Promise((resolve) => wss.close(() => resolve()));
        for (const socket of activeSockets) socket.destroy();
        await new Promise((resolve) => server.close(() => resolve()));
        sessionStore.close();
    }

    return { app, server, wss, sessionStore, listen, close };
}

let reaper = null;

function startBackgroundWork() {
    wireModules();
    // Resume jobs that were mid-flight when the process last died.
    operationStore.requeueUnfinished();
    runner.start();
    // Mark uploads abandoned by a vanished client as interrupted.
    if (!reaper) reaper = setInterval(() => operationStore.reapStaleUploads(60000), 20000);
}

// Resolves once the runner's loop has exited (an item in progress finishes first).
function stopBackgroundWork() {
    if (reaper) clearInterval(reaper);
    reaper = null;
    return runner.stop();
}

async function start() {
    await networkStats.init();
    media.resolveExternalTools();
    await drives.detectExternalDrives();
    operationStore.recountActive();

    const instance = createApp();
    await instance.listen();
    logger.boot({
        port: config.PORT,
        drives: ['internal', ...drives.getDetectedDrives().map(drives.driveTag)],
        workers: dirSize.MAX_WORKERS,
    });
    logger.info(`[Startup] Ready, serving on port ${config.PORT}`);
    startBackgroundWork();
    return instance;
}

// Stops everything start() began. An in-flight operation item is left unfinished in the
// store, so it resumes on the next start.
async function stop(instance) {
    const clientCount = instance ? instance.wss.clients.size : 0;
    if (instance) await instance.close();
    logger.step(`Dropped ${clientCount} websocket client${clientCount === 1 ? '' : 's'} · closed HTTP server`, 'ok');

    // Not awaited: an item mid-copy may take minutes, and is resumed on the next start.
    stopBackgroundWork();
    media.shutdown();
    operationStore.close();
    logger.step('Parked in-flight operations · closed operation store', 'ok');

    bandwidth.persist();
    await networkStats.shutdown();
    logger.step('Flushed bandwidth and network counters', 'ok');

    const { workers } = dirSize.stats();
    await dirSize.shutdown();
    logger.step(`Terminated ${workers} size worker${workers === 1 ? '' : 's'}`, 'ok');
}

module.exports = { createApp, start, stop, startBackgroundWork, stopBackgroundWork, SPA_INDEX };
