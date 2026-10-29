// Folder sizes. The walk runs on worker threads (a deep tree is a lot of JavaScript for the
// main thread); they start on first use, at most a few at a time, and exit after a minute
// idle. Results are cached briefly and dropped as soon as Velocity changes anything under
// them, and concurrent requests for one folder share a single walk.

const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('./logger');

const MAX_WORKERS = Math.max(1, Math.min(4, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length));
const WORKER_IDLE_MS = 60 * 1000;
// Changes made outside Velocity (straight onto an external drive) show up within this long.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 5000;

const cache = new Map();    // absPath -> { value, expires }
const inflight = new Map(); // absPath -> Promise<{ size, files }>
const pool = [];            // { worker, task, idleTimer }
const queue = [];           // { itemPath, resolve, reject }
let nextTaskId = 1;
// Bumped by every invalidation; a walk that started before one isn't cached.
let epoch = 0;

function spawn() {
  const slot = { worker: new Worker(path.join(__dirname, 'size-worker.js')), task: null, idleTimer: null };
  slot.worker.on('message', (msg) => {
    const task = slot.task;
    if (!task || msg.taskId !== task.id) return;
    slot.task = null;
    if (msg.error) task.reject(new Error(msg.error));
    else task.resolve({ size: msg.size, files: msg.files });
    dispatch();
  });
  // A crashed or terminated worker leaves the pool; its task fails instead of hanging.
  const retire = (err) => {
    const i = pool.indexOf(slot);
    if (i !== -1) pool.splice(i, 1);
    clearTimeout(slot.idleTimer);
    if (slot.task) {
      slot.task.reject(err || new Error('The size worker stopped.'));
      slot.task = null;
    }
    dispatch();
  };
  slot.worker.on('error', (err) => {
    logger.error(`[Size] A size worker failed: ${err.message}`);
    retire(err);
  });
  slot.worker.on('exit', () => retire(null));
  pool.push(slot);
  return slot;
}

function dispatch() {
  while (queue.length) {
    let slot = pool.find((s) => !s.task);
    if (!slot) {
      if (pool.length >= MAX_WORKERS) break;
      slot = spawn();
    }
    const job = queue.shift();
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.task = { id: nextTaskId++, ...job };
    slot.worker.ref(); // a walk in progress keeps the process alive; an idle worker doesn't
    slot.worker.postMessage({ taskId: slot.task.id, itemPath: job.itemPath });
  }
  for (const slot of pool) {
    if (slot.task || slot.idleTimer) continue;
    slot.worker.unref();
    slot.idleTimer = setTimeout(() => slot.worker.terminate(), WORKER_IDLE_MS);
    slot.idleTimer.unref();
  }
}

function walk(itemPath) {
  return new Promise((resolve, reject) => {
    queue.push({ itemPath, resolve, reject });
    dispatch();
  });
}

function remember(key, value) {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  // Map order is insertion order, so the first key is the stalest.
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// { size, files } for a file or folder (regular files only; symlinks are not followed).
function measure(absPath) {
  const key = path.resolve(absPath);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const startEpoch = epoch;
  const pending = walk(key)
    .then((value) => {
      if (epoch === startEpoch) remember(key, value);
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

function related(a, b) {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

// Drops cached sizes that changedPath affects: its own, every folder above it, and
// everything below it.
function invalidate(changedPath) {
  epoch++;
  const p = path.resolve(changedPath);
  for (const key of cache.keys()) if (related(key, p)) cache.delete(key);
  for (const key of inflight.keys()) if (related(key, p)) inflight.delete(key);
}

function stats() {
  return { workers: pool.length, busy: pool.filter((s) => s.task).length, queued: queue.length, cached: cache.size };
}

async function shutdown() {
  const workers = pool.splice(0).map((s) => s.worker);
  await Promise.all(workers.map((w) => w.terminate()));
}

module.exports = { MAX_WORKERS, measure, invalidate, stats, shutdown };
