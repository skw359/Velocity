import { useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import {
  apiListOperations,
  apiGetOperation,
  apiEnqueueOperation,
  apiHeartbeatOperation,
  isRefusal,
} from '../api/fetch';

// One id per tab, stamped on its operations so it knows which uploads to heartbeat.
export const clientId =
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const ACTIVE = new Set(['pending', 'running']);

const VERB = {
  copy: 'Copy', move: 'Move', duplicate: 'Duplicate', upload: 'Upload',
  extract: 'Extract', compress: 'Compress', delete: 'Delete', rename: 'Rename',
  'create-folder': 'Create folder', 'create-file': 'Create file',
};

// Types the server sizes against free space before accepting; a slow check shows a notice.
const SPACE_CHECKED = new Set(['copy', 'move', 'duplicate', 'upload']);
const SPACE_NOTICE_DELAY_MS = 400;
let spaceCheckSeq = 0;

export const STORAGE_TITLE = 'Insufficient storage space';

// The runner fails a queued op with "Insufficient storage space. <detail>", or the disk
// fills mid-run (ENOSPC); both show as the same red banner.
function storageFailureDetail(op) {
  const error = String(op.error || '');
  if (error.startsWith(STORAGE_TITLE)) return error.slice(STORAGE_TITLE.length).replace(/^[.:\s]+/, '');
  if (/ENOSPC|no space left/i.test(error)) {
    return `The drive ran out of space before the ${(VERB[op.type] || 'operation').toLowerCase()} could finish.`;
  }
  return null;
}

// Call once (in the dashboard): it owns the only operations polling loop.
export function useOperations({ onComplete } = {}) {
  const { state, dispatch, showOpError, dismissOpError } = useAppContext();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const unmountedRef = useRef(false);

  // id -> last known record of in-flight ops, including ones just started here, so an op
  // that finishes between two polls still gets finalized.
  const trackedRef = useRef(new Map());

  const finalize = useCallback((op) => {
    if (unmountedRef.current) return;
    if (op && (op.status === 'failed' || op.status === 'interrupted') && op.error) {
      const storageDetail = storageFailureDetail(op);
      if (storageDetail !== null) showOpError(STORAGE_TITLE, storageDetail);
      else alert(`${VERB[op.type] || 'Operation'} ${op.status}: ${op.error}`);
    }
    onCompleteRef.current?.(op || null);
  }, [showOpError]);

  // One poll tick, also called on demand by callers that know the list is stale.
  const refreshOperations = useCallback(async () => {
    let ops;
    try { ops = await apiListOperations(); } catch { return; }
    if (unmountedRef.current || !Array.isArray(ops)) return;
    dispatch({ type: 'SET_OPERATIONS', payload: ops });

    const currentActive = new Set();
    for (const op of ops) {
      if (ACTIVE.has(op.status)) {
        currentActive.add(op.id);
        trackedRef.current.set(op.id, op);
      }
    }

    for (const id of [...trackedRef.current.keys()]) {
      if (!currentActive.has(id)) {
        trackedRef.current.delete(id);
        const inList = ops.find(o => o.id === id);
        if (inList) finalize(inList);
        else apiGetOperation(id).then(finalize).catch(() => finalize(null));
      }
    }
  }, [dispatch, finalize]);

  useEffect(() => {
    unmountedRef.current = false;
    refreshOperations();
    const interval = setInterval(refreshOperations, 2000);
    return () => { unmountedRef.current = true; clearInterval(interval); };
  }, [refreshOperations]);

  // Keep this tab's own uploads alive; the server reaps uploads with no heartbeat.
  useEffect(() => {
    const interval = setInterval(() => {
      for (const op of state.activeOperations) {
        if (op.type === 'upload' && op.clientId === clientId && ACTIVE.has(op.status)) {
          apiHeartbeatOperation(op.id).catch(() => {});
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [state.activeOperations]);

  // A refusal is shown in the red banner and rethrown with `handled` set, so callers skip their own alert.
  const startOperation = useCallback(async (payload) => {
    const noticeKey = `space-check:${++spaceCheckSeq}`;
    const noticeTimer = SPACE_CHECKED.has(payload.type) && setTimeout(() => {
      dispatch({ type: 'SET_LOCAL_OP', payload: { key: noticeKey, message: 'Checking available space…', showCancel: false, showUploadInfo: false } });
    }, SPACE_NOTICE_DELAY_MS);
    let rec;
    try {
      rec = await apiEnqueueOperation({ ...payload, clientId });
    } catch (e) {
      if (isRefusal(e)) {
        showOpError(e.message, e.detail);
        e.handled = true;
      }
      throw e;
    } finally {
      clearTimeout(noticeTimer);
      dispatch({ type: 'CLEAR_LOCAL_OP', payload: noticeKey });
    }
    dismissOpError();
    trackedRef.current.set(rec.id, rec);
    dispatch({ type: 'UPSERT_OPERATION', payload: rec });
    return rec;
  }, [dispatch, showOpError, dismissOpError]);

  return { startOperation, refreshOperations, clientId };
}
