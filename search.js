// Search over a WebSocket. A connection runs one search at a time (a new query cancels the
// last), only a few run server-wide at once, and each is bounded in results, entries
// examined, depth and time. Content matching reads only small text files, so one search
// over a tree of large logs can't saturate the disk.

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const logger = require('./logger');
const drives = require('./drives');
const userStore = require('./user-store');
const auth = require('./auth');
const { isCrossSiteUpgrade } = require('./security');

const LIMITS = {
  results: 500,
  entries: 200000,          // directory entries examined per search
  depth: 32,
  durationMs: 60 * 1000,
  contentBytes: 10 * 1024 * 1024, // larger files are matched by name only
  concurrent: 4,            // searches running at once, server-wide
  queryLength: 256,
};

const SEARCHABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.html', '.css', '.xml', '.yaml', '.yml',
  '.py', '.java', '.c', '.cpp', '.h', '.cs', '.sh', '.log', '.ini', '.cfg',
]);

// Server-wide slots; a search waits for one in arrival order.
let running = 0;
const waiting = [];
function acquireSlot() {
  if (running < LIMITS.concurrent) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

// Whether the file's text contains needle (already lower-cased). A match split across two
// read chunks still counts.
async function contentMatches(file, needle, search) {
  let stats;
  try { stats = await fs.promises.stat(file); } catch { return false; }
  if (!stats.isFile() || stats.size > LIMITS.contentBytes) return false;
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const keep = needle.length - 1;
    let tail = '';
    let found = false;
    stream.on('data', (chunk) => {
      if (search.cancelled) { stream.destroy(); return; }
      if ((tail + chunk).toLowerCase().includes(needle)) {
        found = true;
        stream.destroy();
        return;
      }
      tail = keep > 0 ? chunk.slice(-keep) : '';
    });
    stream.on('close', () => resolve(found));
    stream.on('error', () => resolve(false));
  });
}

// Walks root depth-first, sending a search_result per match. Returns true if a limit cut
// the search short.
async function walk(root, driveId, query, search, send) {
  const needle = query.toLowerCase();
  const deadline = Date.now() + LIMITS.durationMs;
  let results = 0;
  let examined = 0;
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    if (search.cancelled) return false;
    if (Date.now() > deadline) return true;
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // Unreadable directories are skipped quietly.
      if (error.code !== 'EPERM' && error.code !== 'EACCES') logger.error(`[Search] Error in directory ${dir}: ${error.message}`);
      continue;
    }
    const relative = '/' + path.relative(root, dir).split(path.sep).filter(Boolean).join('/');
    const subdirs = [];

    for (const entry of entries) {
      if (search.cancelled) return false;
      if (drives.isHiddenSystemEntry(entry.name)) continue;
      if (++examined > LIMITS.entries || Date.now() > deadline) return true;

      const fullPath = path.join(dir, entry.name);
      // Dirent types come from lstat, so a symlinked folder is never descended into.
      const isDir = entry.isDirectory();
      let match = entry.name.toLowerCase().includes(needle);
      if (!match && entry.isFile() && SEARCHABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        match = await contentMatches(fullPath, needle, search);
      }
      if (match && !search.cancelled) {
        let stats;
        try { stats = await fs.promises.stat(fullPath); } catch { stats = null; }
        if (stats) {
          send({ type: 'search_result', data: { name: entry.name, path: relative, type: isDir ? 'folder' : 'file', mtime: stats.mtime, drive: driveId } });
          if (++results >= LIMITS.results) return true;
        }
      }
      if (isDir && depth < LIMITS.depth) subdirs.push(fullPath);
    }
    // Reversed onto the stack so folders are visited in listing order.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push({ dir: subdirs[i], depth: depth + 1 });
  }
  return false;
}

async function runSearch(ws, search, userId, query, driveId) {
  const send = (message) => {
    if (!search.cancelled && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  // Re-read per search: the socket outlives the upgrade-time check.
  const user = userStore.getById(userId);
  const root = user && user.status === 'active' && drives.canReadDrive(driveId, user)
    ? drives.getDriveRoot(driveId, user)
    : null;
  if (!root) {
    send({ type: 'search_complete' });
    return;
  }
  await acquireSlot();
  try {
    const truncated = await walk(root, driveId, query, search, send);
    send({ type: 'search_complete', truncated });
  } catch (error) {
    logger.error(`[Search] Failed: ${error && error.stack ? error.stack : error}`);
    send({ type: 'search_error', message: 'Error during search.' });
  } finally {
    releaseSlot();
  }
}

function rejectUpgrade(socket, status) {
  if (socket.writable) socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// Accepts search WebSockets on `server` for signed-in accounts only.
function attachSearch(server, { sessionMiddleware }) {
  // Messages are a short JSON command; anything bigger is refused by ws itself.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    // Nothing else listens for errors on the raw socket until ws takes it over.
    socket.on('error', () => socket.destroy());
    // A page on another site (or another port of this host) must not ride the cookie in.
    if (isCrossSiteUpgrade(request.headers)) {
      logger.warn(`[Search] Refused cross-site WebSocket (origin: ${request.headers.origin})`);
      return rejectUpgrade(socket, '403 Forbidden');
    }
    sessionMiddleware(request, {}, () => {
      const user = auth.sessionUser(request.session);
      if (!user) return rejectUpgrade(socket, '401 Unauthorized');
      request.searchUserId = user.id;
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
  });

  wss.on('connection', (ws, request) => {
    const userId = request.searchUserId;
    let current = null;
    const cancel = () => {
      if (current) current.cancelled = true;
      current = null;
    };

    ws.on('error', (err) => logger.warn(`[Search] WebSocket error: ${err.message}`));
    ws.on('close', cancel);
    ws.on('message', (message) => {
      let parsed;
      try { parsed = JSON.parse(message); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.type === 'stop_search') return cancel();
      if (parsed.type !== 'start_search' || typeof parsed.query !== 'string' || !parsed.query) return;

      cancel();
      const search = { cancelled: false };
      current = search;
      const driveId = typeof parsed.drive === 'string' && parsed.drive ? parsed.drive : 'internal';
      runSearch(ws, search, userId, parsed.query.slice(0, LIMITS.queryLength), driveId)
        .finally(() => { if (current === search) current = null; });
    });
  });

  return wss;
}

module.exports = { LIMITS, attachSearch, contentMatches };
