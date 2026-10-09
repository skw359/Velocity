// For uploads, updatedAt doubles as a liveness heartbeat so abandoned uploads can be reaped.

const { db, driver, DB_FILE, tx, migrate, now, genId } = require('./db');
const logger = require('./logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    user TEXT,
    type TEXT,
    status TEXT,
    destDrive TEXT,
    destPath TEXT,
    itemCount INTEGER DEFAULT 0,
    completedCount INTEGER DEFAULT 0,
    progress REAL DEFAULT 0,
    message TEXT,
    error TEXT,
    clientId TEXT,
    createdAt TEXT,
    updatedAt TEXT,
    startedAt TEXT,
    finishedAt TEXT
  );
  CREATE TABLE IF NOT EXISTS operation_items (
    id TEXT PRIMARY KEY,
    opId TEXT,
    idx INTEGER,
    name TEXT,
    sourceDrive TEXT,
    sourcePath TEXT,
    targetName TEXT,
    itemType TEXT,
    conflict TEXT,
    bytesReceived INTEGER DEFAULT 0,
    status TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_op_items_op ON operation_items (opId, status);
  CREATE INDEX IF NOT EXISTS idx_ops_status ON operations (status, type);
  CREATE INDEX IF NOT EXISTS idx_ops_user ON operations (user, status);
`);

// Columns added after the initial schema; migrate() ignores ones that already exist.
migrate([
  'ALTER TABLE operation_items ADD COLUMN relPath TEXT',
  'ALTER TABLE operation_items ADD COLUMN size INTEGER DEFAULT 0',
]);

logger.info(`[Operations] Store ready (${driver}) at ${DB_FILE}.`);

const ACTIVE = `('pending','running')`;

const insertOp = db.prepare(`
  INSERT INTO operations (id,user,type,status,destDrive,destPath,itemCount,completedCount,progress,message,error,clientId,createdAt,updatedAt,startedAt,finishedAt)
  VALUES (@id,@user,@type,@status,@destDrive,@destPath,@itemCount,@completedCount,@progress,@message,@error,@clientId,@createdAt,@updatedAt,@startedAt,@finishedAt)
`);
const insertItem = db.prepare(`
  INSERT INTO operation_items (id,opId,idx,name,sourceDrive,sourcePath,targetName,itemType,conflict,relPath,size,bytesReceived,status,error)
  VALUES (@id,@opId,@idx,@name,@sourceDrive,@sourcePath,@targetName,@itemType,@conflict,@relPath,@size,@bytesReceived,@status,@error)
`);
const selOp = db.prepare(`SELECT * FROM operations WHERE id = ?`);
const selItems = db.prepare(`SELECT * FROM operation_items WHERE opId = ? ORDER BY idx ASC`);

const createTxn = tx((op, items) => {
  insertOp.run(op);
  items.forEach((it) => insertItem.run(it));
});

function attachItems(op) {
  if (!op) return null;
  op.items = selItems.all(op.id);
  return op;
}

function create(opData, items = []) {
  const id = genId();
  const ts = now();
  const op = {
    id,
    user: opData.user || null,
    type: opData.type,
    status: 'pending',
    destDrive: opData.destDrive || null,
    destPath: opData.destPath || null,
    itemCount: items.length,
    completedCount: 0,
    progress: 0,
    message: opData.message || null,
    error: null,
    clientId: opData.clientId || null,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    finishedAt: null,
  };
  const itemRows = items.map((it, idx) => ({
    id: genId(),
    opId: id,
    idx,
    name: it.name,
    sourceDrive: it.sourceDrive || null,
    sourcePath: it.sourcePath == null ? null : it.sourcePath,
    targetName: it.targetName || null,
    itemType: it.itemType || null,
    conflict: it.conflict || null,
    relPath: it.relPath || null,   // upload: per-file key for chunk/offset matching
    size: it.size || 0,            // upload: file bytes; copy/move/duplicate: bytes added at the destination
    bytesReceived: 0,
    status: 'pending',
    error: null,
  }));
  createTxn(op, itemRows);
  return get(id);
}

function get(id) {
  return attachItems(selOp.get(id));
}

// Per-chunk ownership checks must not load every item of a large upload.
const selOwner = db.prepare(`SELECT user FROM operations WHERE id = ?`);
function ownerOf(id) {
  const row = selOwner.get(id);
  return row ? row.user : null;
}

function attachAll(ops) {
  return ops.map(attachItems);
}

function listActive(user) {
  const rows = db
    .prepare(`SELECT * FROM operations WHERE user = ? AND status IN ${ACTIVE} ORDER BY createdAt DESC`)
    .all(user);
  return attachAll(rows);
}

// Every account's active ops, for the free-space check (disk space is shared).
function listActiveAll() {
  const rows = db.prepare(`SELECT * FROM operations WHERE status IN ${ACTIVE}`).all();
  return attachAll(rows);
}

function listAll(user, limit = 50) {
  const rows = db
    .prepare(`SELECT * FROM operations WHERE user = ? ORDER BY createdAt DESC LIMIT ?`)
    .all(user, limit);
  return attachAll(rows);
}

// Oldest queued NON-upload op for the executor (uploads are client-driven).
function nextPending() {
  const row = db
    .prepare(`SELECT * FROM operations WHERE status = 'pending' AND type != 'upload' ORDER BY createdAt ASC LIMIT 1`)
    .get();
  return attachItems(row);
}

function claim(id) {
  const ts = now();
  const r = db
    .prepare(`UPDATE operations SET status='running', startedAt=COALESCE(startedAt, ?), updatedAt=? WHERE id=? AND status='pending'`)
    .run(ts, ts, id);
  return (r.changes || 0) > 0;
}

function recomputeParent(opId) {
  const op = db.prepare(`SELECT type FROM operations WHERE id=?`).get(opId);
  const agg = db
    .prepare(`SELECT COUNT(*) AS total,
                     SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS done,
                     COALESCE(SUM(bytesReceived),0) AS bytes,
                     COALESCE(SUM(size),0) AS size
              FROM operation_items WHERE opId=?`)
    .get(opId);
  const total = agg.total || 0;
  const done = agg.done || 0;
  // Uploads report byte progress so a polling viewer tab sees smooth movement.
  const progress = (op && op.type === 'upload' && agg.size > 0)
    ? (agg.bytes / agg.size) * 100
    : (total > 0 ? (done / total) * 100 : 0);
  db.prepare(`UPDATE operations SET completedCount=?, progress=?, updatedAt=? WHERE id=?`).run(done, progress, now(), opId);
}

function markItem(opId, itemId, status, error = null) {
  db.prepare(`UPDATE operation_items SET status=?, error=? WHERE id=?`).run(status, error, itemId);
  recomputeParent(opId);
}
const itemDone = (opId, itemId) => markItem(opId, itemId, 'completed', null);
const itemFail = (opId, itemId, err) => markItem(opId, itemId, 'failed', err == null ? null : String(err));

// Persisted so a resumed transfer/duplicate reuses the same destination instead of
// inventing a new suffixed name each attempt.
function setItemTarget(opId, itemId, targetName) {
  db.prepare(`UPDATE operation_items SET targetName=? WHERE id=?`).run(targetName, itemId);
  db.prepare(`UPDATE operations SET updatedAt=? WHERE id=?`).run(now(), opId);
}

function setItemBytes(opId, itemId, bytes) {
  db.prepare(`UPDATE operation_items SET bytesReceived=? WHERE id=?`).run(bytes, itemId);
  recomputeParent(opId);
}

function findUploadItem(opId, relPath, fileName) {
  let row = db.prepare(`SELECT * FROM operation_items WHERE opId=? AND relPath=? LIMIT 1`).get(opId, relPath);
  if (!row) row = db.prepare(`SELECT * FROM operation_items WHERE opId=? AND name=? LIMIT 1`).get(opId, relPath);
  if (!row && fileName) row = db.prepare(`SELECT * FROM operation_items WHERE opId=? AND name=? LIMIT 1`).get(opId, fileName);
  return row || null;
}

function setProgress(id, pct, message) {
  if (message === undefined) {
    db.prepare(`UPDATE operations SET progress=?, updatedAt=? WHERE id=?`).run(pct, now(), id);
  } else {
    db.prepare(`UPDATE operations SET progress=?, message=?, updatedAt=? WHERE id=?`).run(pct, message, now(), id);
  }
}

function finalize(id, status, error = null) {
  const ts = now();
  if (status === 'completed') {
    db.prepare(`UPDATE operations SET status=?, error=?, progress=100, finishedAt=?, updatedAt=? WHERE id=?`).run(status, null, ts, ts, id);
  } else {
    db.prepare(`UPDATE operations SET status=?, error=?, finishedAt=?, updatedAt=? WHERE id=?`).run(status, error == null ? null : String(error), ts, ts, id);
  }
}

function heartbeat(id) {
  db.prepare(`UPDATE operations SET updatedAt=? WHERE id=?`).run(now(), id);
}

const removeTxn = tx((id) => {
  db.prepare(`DELETE FROM operation_items WHERE opId=?`).run(id);
  db.prepare(`DELETE FROM operations WHERE id=?`).run(id);
});
function remove(id) {
  removeTxn(id);
}

// Uploads are left alone: they continue when the client reconnects, and the reaper handles abandonment.
const requeueTxn = tx(() => {
  db.prepare(`UPDATE operation_items SET status='pending' WHERE status='running' AND opId IN (SELECT id FROM operations WHERE type!='upload' AND status IN ('running','pending'))`).run();
  const r = db.prepare(`UPDATE operations SET status='pending', updatedAt=? WHERE type!='upload' AND status IN ('running','pending')`).run(now());
  return r.changes || 0;
});
function requeueUnfinished() {
  const n = requeueTxn();
  if (n > 0) logger.info(`[Operations] Requeued ${n} unfinished operation(s) for resume.`);
  return n;
}

function reapStaleUploads(maxAgeMs) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const r = db
    .prepare(`UPDATE operations SET status='interrupted', error='Upload abandoned (client disconnected).', finishedAt=?, updatedAt=? WHERE type='upload' AND status IN ('pending','running') AND updatedAt < ?`)
    .run(now(), now(), cutoff);
  if (r.changes) logger.info(`[Operations] Marked ${r.changes} stale upload(s) interrupted.`);
  return r.changes || 0;
}

function isCanceled(id) {
  const row = db.prepare(`SELECT status FROM operations WHERE id=?`).get(id);
  return !!row && row.status === 'canceled';
}

function getStatus(id) {
  const row = db.prepare(`SELECT status FROM operations WHERE id=?`).get(id);
  return row ? row.status : null;
}

function close() {
  try { db.close(); } catch { /* ignore */ }
}

module.exports = {
  driver,
  create,
  get,
  ownerOf,
  listActive,
  listActiveAll,
  listAll,
  nextPending,
  claim,
  markItem,
  itemDone,
  itemFail,
  setItemTarget,
  setItemBytes,
  findUploadItem,
  setProgress,
  finalize,
  heartbeat,
  remove,
  requeueUnfinished,
  reapStaleUploads,
  isCanceled,
  getStatus,
  close,
};
