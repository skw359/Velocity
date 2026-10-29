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
  // Running totals, kept in step with item changes so progress never re-aggregates every item.
  'ALTER TABLE operations ADD COLUMN bytesDone INTEGER DEFAULT 0',
  'ALTER TABLE operations ADD COLUMN sizeTotal INTEGER DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_op_items_order ON operation_items (opId, idx)',
]);

logger.info(`[Operations] Store ready (${driver}) at ${DB_FILE}.`);

const ACTIVE = `('pending','running')`;

const insertOp = db.prepare(`
  INSERT INTO operations (id,user,type,status,destDrive,destPath,itemCount,completedCount,progress,message,error,clientId,createdAt,updatedAt,startedAt,finishedAt,bytesDone,sizeTotal)
  VALUES (@id,@user,@type,@status,@destDrive,@destPath,@itemCount,@completedCount,@progress,@message,@error,@clientId,@createdAt,@updatedAt,@startedAt,@finishedAt,@bytesDone,@sizeTotal)
`);
const insertItem = db.prepare(`
  INSERT INTO operation_items (id,opId,idx,name,sourceDrive,sourcePath,targetName,itemType,conflict,relPath,size,bytesReceived,status,error)
  VALUES (@id,@opId,@idx,@name,@sourceDrive,@sourcePath,@targetName,@itemType,@conflict,@relPath,@size,@bytesReceived,@status,@error)
`);
const selOp = db.prepare(`SELECT * FROM operations WHERE id = ?`);
const selItems = db.prepare(`SELECT * FROM operation_items WHERE opId = ? ORDER BY idx ASC`);
const selFirstItem = db.prepare(`SELECT * FROM operation_items WHERE opId = ? ORDER BY idx ASC LIMIT 1`);
const selOpenItems = db.prepare(`SELECT * FROM operation_items WHERE opId = ? AND status != 'completed' ORDER BY idx ASC LIMIT ?`);

const createTxn = tx((op, items) => {
  insertOp.run(op);
  items.forEach((it) => insertItem.run(it));
});

function attachItems(op) {
  if (!op) return null;
  op.items = selItems.all(op.id);
  return op;
}

// What the polled lists send: the first item (it names the operation) and the next
// unfinished ones (upload progress), not every item of a 10,000-file upload every two
// seconds. GET /operations/:id still returns them all.
const SUMMARY_ITEMS = 20;
function attachItemSummary(op) {
  if (!op) return null;
  if (op.itemCount <= SUMMARY_ITEMS + 1) return attachItems(op);
  const first = selFirstItem.get(op.id);
  const open = selOpenItems.all(op.id, SUMMARY_ITEMS).filter((it) => !first || it.id !== first.id);
  op.items = first ? [first, ...open] : open;
  op.itemsTruncated = true;
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
    bytesDone: 0,
    sizeTotal: items.reduce((sum, it) => sum + (Number(it.size) || 0), 0),
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

// The operation row alone. Per-chunk checks must not load every item of a large upload.
function getMeta(id) {
  return selOp.get(id) || null;
}

function ownerOf(id) {
  const row = getMeta(id);
  return row ? row.user : null;
}

function attachAll(ops) {
  return ops.map(attachItems);
}

function listActive(user) {
  const rows = db
    .prepare(`SELECT * FROM operations WHERE user = ? AND status IN ${ACTIVE} ORDER BY createdAt DESC`)
    .all(user);
  return rows.map(attachItemSummary);
}

// Every account's active ops, for the free-space check (disk space is shared).
function listActiveAll() {
  const rows = db.prepare(`SELECT * FROM operations WHERE status IN ${ACTIVE}`).all();
  return attachAll(rows);
}

function listAll(user, limit = 50) {
  const rows = db
    .prepare(`SELECT * FROM operations WHERE user = ? ORDER BY createdAt DESC LIMIT ?`)
    .all(user, Math.max(1, Math.min(500, Number(limit) || 50)));
  return rows.map(attachItemSummary);
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

// Uploads report byte progress so a polling viewer tab sees smooth movement; everything
// else reports finished items. Written in SQL so both totals updates below share it.
const PROGRESS_SQL = `CASE WHEN type='upload' AND sizeTotal > 0 THEN MIN(100.0, bytesDone * 100.0 / sizeTotal)
                           WHEN itemCount > 0 THEN completedCount * 100.0 / itemCount
                           ELSE 0 END`;

// Full recount from the items: used once per startup for active operations (rows created
// before the running totals existed) and as the reference the incremental updates match.
const recountStmt = db.prepare(`
  UPDATE operations SET
    completedCount = (SELECT COUNT(*) FROM operation_items WHERE opId = @id AND status = 'completed'),
    bytesDone = (SELECT COALESCE(SUM(bytesReceived), 0) FROM operation_items WHERE opId = @id),
    sizeTotal = (SELECT COALESCE(SUM(size), 0) FROM operation_items WHERE opId = @id),
    itemCount = (SELECT COUNT(*) FROM operation_items WHERE opId = @id)
  WHERE id = @id`);
const progressStmt = db.prepare(`UPDATE operations SET progress = ${PROGRESS_SQL}, updatedAt = @ts WHERE id = @id`);

function recomputeParent(opId) {
  recountStmt.run({ id: opId });
  progressStmt.run({ id: opId, ts: now() });
}

const selItemState = db.prepare(`SELECT status, bytesReceived FROM operation_items WHERE id = ? AND opId = ?`);
const setItemStatusStmt = db.prepare(`UPDATE operation_items SET status = ?, error = ? WHERE id = ?`);
const setItemBytesStmt = db.prepare(`UPDATE operation_items SET bytesReceived = ? WHERE id = ?`);
const bumpCompletedStmt = db.prepare(`UPDATE operations SET completedCount = completedCount + ? WHERE id = ?`);
const bumpBytesStmt = db.prepare(`UPDATE operations SET bytesDone = bytesDone + ? WHERE id = ?`);

// O(1) per change: the parent's totals move by this item's delta.
const markItemTxn = tx((opId, itemId, status, error) => {
  const prev = selItemState.get(itemId, opId);
  if (!prev) return;
  setItemStatusStmt.run(status, error, itemId);
  const delta = (status === 'completed' ? 1 : 0) - (prev.status === 'completed' ? 1 : 0);
  if (delta) bumpCompletedStmt.run(delta, opId);
  progressStmt.run({ id: opId, ts: now() });
});

function markItem(opId, itemId, status, error = null) {
  markItemTxn(opId, itemId, status, error);
}
const itemDone = (opId, itemId) => markItem(opId, itemId, 'completed', null);
const itemFail = (opId, itemId, err) => markItem(opId, itemId, 'failed', err == null ? null : String(err));

// Persisted so a resumed transfer/duplicate reuses the same destination instead of
// inventing a new suffixed name each attempt.
function setItemTarget(opId, itemId, targetName) {
  db.prepare(`UPDATE operation_items SET targetName=? WHERE id=?`).run(targetName, itemId);
  db.prepare(`UPDATE operations SET updatedAt=? WHERE id=?`).run(now(), opId);
}

const setItemBytesTxn = tx((opId, itemId, bytes) => {
  const prev = selItemState.get(itemId, opId);
  if (!prev) return;
  setItemBytesStmt.run(bytes, itemId);
  const delta = bytes - (prev.bytesReceived || 0);
  if (delta) bumpBytesStmt.run(delta, opId);
  progressStmt.run({ id: opId, ts: now() });
});

function setItemBytes(opId, itemId, bytes) {
  setItemBytesTxn(opId, itemId, bytes);
}

const selByRelPath = db.prepare(`SELECT * FROM operation_items WHERE opId = ? AND relPath = ? LIMIT 2`);
const selByName = db.prepare(`SELECT * FROM operation_items WHERE opId = ? AND name = ? LIMIT 2`);

// The item an upload chunk belongs to. relPath is the key the client sends with both; a
// bare-name fallback is used only when it is unambiguous, because resuming from another
// file's byte count would splice two files together.
function findUploadItem(opId, relPath, fileName) {
  const unique = (rows) => (rows.length === 1 ? rows[0] : null);
  const byPath = selByRelPath.all(opId, relPath);
  if (byPath.length) return unique(byPath);
  return unique(selByName.all(opId, relPath)) || (fileName ? unique(selByName.all(opId, fileName)) : null);
}

// True once every item of the operation has completed (O(1): reads the running total).
function allItemsDone(opId) {
  const op = getMeta(opId);
  return !!op && op.itemCount > 0 && op.completedCount >= op.itemCount;
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

// Active rows may predate the running totals (or come from a crash mid-update): recount
// them once at startup so the incremental updates start from the truth.
function recountActive() {
  const ids = db.prepare(`SELECT id FROM operations WHERE status IN ${ACTIVE}`).all();
  for (const { id } of ids) recomputeParent(id);
  return ids.length;
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
  getMeta,
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
  allItemsDone,
  recomputeParent,
  setProgress,
  finalize,
  heartbeat,
  remove,
  requeueUnfinished,
  recountActive,
  reapStaleUploads,
  isCanceled,
  getStatus,
  close,
};
