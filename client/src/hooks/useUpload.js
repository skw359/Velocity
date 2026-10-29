import { useRef, useEffect, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { formatBytes } from '../utils/format';
import { topLevelName } from '../utils/conflicts';
import {
  apiEnqueueOperation, apiGetUploadOffset, apiCancelOperation, apiCheckSpace, apiDeleteItem, isStorageError, isRefusal,
} from '../api/fetch';
import { clientId, STORAGE_TITLE } from './useOperations';

const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_TOOLTIP_FILES = 10;
// Progress events fire per socket write; coalesce them so re-renders stay at ~10fps.
const PROGRESS_EMIT_MS = 100;

class UploadManager {
  constructor(onProgress, onFinish, onStatusMessage, onStorageFull) {
    this.queue = [];
    this.activeUploads = 0;
    // Running totals kept in step with filesMap by setFileUploaded, so progress never re-sums the batch.
    this.totalBytes = 0;
    this.uploadedBytes = 0;
    this.isUploading = false;
    this.filesMap = new Map();
    // Unfinished files in queue order, so the tooltip never scans the whole batch.
    this.pending = new Set();
    this.emitTimer = null;
    this.lastEmit = 0;
    this.targetDrive = 'internal';
    this.currentPath = '/';
    this.onProgress = onProgress;
    this.onFinish = onFinish;
    this.onStatusMessage = onStatusMessage;
    this.onStorageFull = onStorageFull;
    this.opId = null; // durable backend operation id for this batch
    // Bumped by cancelAll so in-flight files from a cancelled batch stop and don't
    // decrement the next batch's activeUploads.
    this.generation = 0;
  }

  addEntries(entries, driveId, currentPath) {
    this.targetDrive = driveId;
    this.currentPath = currentPath;
    entries.forEach(entry => {
      const uniqueId = entry.file.name + entry.path;
      this.queue.push(entry);
      // A repeat name+path replaces its row; back out its old contribution to the totals.
      const prev = this.filesMap.get(uniqueId);
      if (prev) {
        this.totalBytes -= prev.size;
        this.uploadedBytes -= prev.uploaded;
      }
      this.totalBytes += entry.file.size;
      this.filesMap.set(uniqueId, {
        name: entry.file.name,
        size: entry.file.size,
        uploaded: 0,
      });
      this.pending.add(uniqueId);
    });

    if (!this.isUploading && this.queue.length > 0) {
      this.start();
    } else {
      this.updateGlobalProgress();
    }
  }

  start() {
    this.isUploading = true;
    this.onStatusMessage?.(`Preparing upload of ${this.queue.length} items...`);
    this.processQueue();
  }

  // Shared by finish and cancelAll so a cancelled batch can't leave stale rows behind.
  resetBatch() {
    this.stopEmitting();
    this.filesMap.clear();
    this.pending.clear();
    this.totalBytes = 0;
    this.uploadedBytes = 0;
  }

  async processQueue() {
    const remaining = this.queue.length + this.activeUploads;
    if (remaining === 0) {
      this.finish();
      return;
    }
    while (this.activeUploads < MAX_CONCURRENT_UPLOADS && this.queue.length > 0) {
      const entry = this.queue.shift();
      const generation = this.generation;
      this.activeUploads++;
      this.uploadFile(entry, generation)
        .catch((e) => {
          // The drive filled up mid-batch; every later file would be refused too.
          if (isStorageError(e) && generation === this.generation) {
            this.cancelAll();
            this.onStorageFull?.(e);
          } else {
            console.error(`Upload of ${entry.path} failed:`, e);
          }
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.activeUploads--;
          this.processQueue();
        });
    }
  }

  async uploadFile(entry, generation) {
    const { file, path: relativePath } = entry;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uniqueId = file.name + relativePath;

    if (file.size === 0) {
      await this.sendChunk(new Blob([]), file.name, relativePath, 0, 1, this.currentPath, 0, this.targetDrive);
      this.setFileUploaded(uniqueId, 0); // also retires it from `pending`
      return;
    }

    // Resume: skip chunks already on the server. Chunks are written at fixed offsets,
    // so re-sending the boundary chunk is safe.
    let startChunk = 0;
    if (this.opId) {
      try {
        const { offset } = await apiGetUploadOffset(this.opId, relativePath);
        if (offset > 0) {
          startChunk = Math.floor(offset / CHUNK_SIZE);
          // Already complete on disk: re-send the final chunk so the server marks it done.
          if (startChunk >= totalChunks) startChunk = totalChunks - 1;
          this.setFileUploaded(uniqueId, startChunk * CHUNK_SIZE);
        }
      } catch { /* offset unknown, upload the whole file */ }
    }

    for (let chunkIndex = startChunk; chunkIndex < totalChunks; chunkIndex++) {
      if (!this.isUploading || generation !== this.generation) return;
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      let retries = 3;
      while (retries > 0) {
        // Each attempt re-sends the whole chunk, so rewind to the boundary to avoid double-counting.
        this.setFileUploaded(uniqueId, start);
        try {
          await this.sendChunk(
            chunk, file.name, relativePath, chunkIndex, totalChunks, this.currentPath, file.size, this.targetDrive,
            (loaded) => this.setFileUploaded(uniqueId, start + loaded),
          );
          // Progress events count bytes handed to the socket, which can run ahead; settle on the boundary.
          this.setFileUploaded(uniqueId, end);
          break;
        } catch (e) {
          if (isStorageError(e)) throw e; // retrying can't make room
          console.error(`Chunk ${chunkIndex} failed for ${file.name}. Retries left: ${retries}`);
          retries--;
          if (retries === 0) throw e;
          await new Promise(r => setTimeout(r, 1000));
          // A quick server restart may still have persisted this chunk; skip ahead if so.
          if (this.opId) {
            try {
              const { offset } = await apiGetUploadOffset(this.opId, relativePath);
              if (Math.floor(offset / CHUNK_SIZE) > chunkIndex) {
                this.setFileUploaded(uniqueId, offset);
                break;
              }
            } catch { /* keep retrying */ }
          }
        }
      }
    }
  }

  // Optional onBytes(loadedBytesOfThisChunk) is fed by the XHR's own upload progress events.
  sendChunk(chunk, fileName, relPath, index, total, currPath, totalSize, driveId, onBytes) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload-chunk', true);
      if (onBytes) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onBytes(e.loaded); };
      }
      xhr.setRequestHeader('x-file-name', encodeURIComponent(fileName));
      xhr.setRequestHeader('x-relative-path', encodeURIComponent(relPath));
      xhr.setRequestHeader('x-chunk-index', index);
      xhr.setRequestHeader('x-total-chunks', total);
      xhr.setRequestHeader('x-current-path', encodeURIComponent(currPath));
      xhr.setRequestHeader('x-total-file-size', totalSize);
      xhr.setRequestHeader('x-drive-id', encodeURIComponent(driveId));
      xhr.setRequestHeader('x-op-id', this.opId || '');
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.onload = () => {
        if (xhr.status === 200) { resolve(); return; }
        if (xhr.status === 507) {
          let body = {};
          try { body = JSON.parse(xhr.responseText); } catch { /* keep the defaults */ }
          const err = new Error(body.message || STORAGE_TITLE);
          err.code = 'insufficient_storage';
          err.detail = body.detail || '';
          reject(err);
          return;
        }
        reject(new Error(xhr.responseText));
      };
      xhr.onerror = () => reject(new Error('Network Error'));
      xhr.send(chunk);
    });
  }

  // The single writer for a file's byte count; this keeps the running totals honest.
  setFileUploaded(uniqueId, bytes) {
    const f = this.filesMap.get(uniqueId);
    if (!f) return;
    const next = Math.max(0, Math.min(f.size, bytes));
    if (next !== f.uploaded) {
      this.uploadedBytes += next - f.uploaded;
      f.uploaded = next;
    }
    if (next >= f.size) this.pending.delete(uniqueId);
    this.scheduleProgress();
  }

  // At most one render per PROGRESS_EMIT_MS, with a trailing emit so the last update isn't dropped.
  scheduleProgress() {
    if (!this.isUploading || this.emitTimer) return;
    const since = Date.now() - this.lastEmit;
    if (since >= PROGRESS_EMIT_MS) {
      this.updateGlobalProgress();
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.updateGlobalProgress();
    }, PROGRESS_EMIT_MS - since);
  }

  updateGlobalProgress() {
    if (!this.isUploading) return;
    this.lastEmit = Date.now();
    const totalUploadedCurrent = this.uploadedBytes;
    const totalSizeCurrent = this.totalBytes;
    const percentage = totalSizeCurrent > 0 ? (totalUploadedCurrent / totalSizeCurrent) * 100 : 100;
    const message = `Uploading... ${formatBytes(totalUploadedCurrent)} / ${formatBytes(totalSizeCurrent)}`;

    const tooltipFiles = [];
    for (const key of this.pending) {
      const val = this.filesMap.get(key);
      if (!val) continue;
      const percent = val.size > 0 ? (val.uploaded / val.size) * 100 : 100;
      tooltipFiles.push({ name: val.name, percent: Math.floor(percent) });
      if (tooltipFiles.length >= MAX_TOOLTIP_FILES) break;
    }

    this.onProgress?.(percentage, message, tooltipFiles);
  }

  stopEmitting() {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
  }

  cancelAll() {
    this.isUploading = false;
    this.generation += 1;
    this.resetBatch();
    this.queue = [];
    this.activeUploads = 0;
    if (this.opId) { apiCancelOperation(this.opId).catch(() => {}); this.opId = null; }
    this.onFinish?.();
  }

  finish() {
    this.isUploading = false;
    this.resetBatch();
    this.opId = null; // backend finalizes via the last chunk; next batch gets a fresh op
    console.log('Upload queue finished.');
    this.onFinish?.();
  }
}

export function useUpload(onFinish) {
  const { dispatch, longOpStartImmediate, longOpStop, showOpError, dismissOpError } = useAppContext();
  const managerRef = useRef(null);
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; });

  const getManager = useCallback(() => {
    if (!managerRef.current) {
      managerRef.current = new UploadManager(
        (percentage, message, tooltipFiles) => {
          dispatch({ type: 'SET_LOCAL_OP', payload: { key: 'upload', message, showCancel: true, showUploadInfo: true, percent: percentage, tooltipFiles } });
        },
        () => {
          longOpStop('upload');
          onFinishRef.current?.();
        },
        (message) => {
          longOpStartImmediate('upload', message, () => managerRef.current?.cancelAll());
        },
        (err) => showOpError(err.message, err.detail),
      );
    }
    return managerRef.current;
  }, [dispatch, longOpStartImmediate, longOpStop, showOpError]);

  // `replace` names are deleted only after the server confirms the upload fits,
  // so a refused upload doesn't lose them.
  const addEntries = useCallback(async (entries, driveId, currentPath, { replace = [] } = {}) => {
    const mgr = getManager();
    const replaceSet = new Set(replace);
    const items = entries.map(e => ({
      name: e.file.name,
      sourceDrive: driveId,
      sourcePath: currentPath,
      relPath: e.path,
      size: e.file.size,
      conflict: replaceSet.has(topLevelName(e.path)) ? 'replace' : undefined,
    }));

    // A cancel during the awaits below bumps the generation; after that nothing may be deleted or sent.
    const generation = mgr.generation;
    let op = null;
    if (!mgr.isUploading) {
      // One durable record per batch: other tabs see it, it enables resume, and
      // creating it is where the server checks free space.
      longOpStartImmediate('upload', `Preparing upload of ${entries.length} items...`, () => mgr.cancelAll());
      try {
        op = await apiEnqueueOperation({ type: 'upload', clientId, destDrive: driveId, destPath: currentPath, items });
      } catch (e) {
        if (isRefusal(e)) {
          longOpStop('upload');
          showOpError(e.message, e.detail);
          return;
        }
        // Proceed without a durable record rather than block the upload.
      }
      if (mgr.generation !== generation) {
        if (op) apiCancelOperation(op.id).catch(() => {});
        return;
      }
      mgr.opId = op?.id ?? null;
    } else {
      // Joining a running batch that already has a record: dry-run the space check
      // and leave its bar alone.
      try {
        await apiCheckSpace({ type: 'upload', destDrive: driveId, destPath: currentPath, items });
      } catch (e) {
        showOpError(e.message, e.detail);
        return;
      }
      if (mgr.generation !== generation) return;
    }

    dismissOpError();
    if (replace.length) {
      try {
        await Promise.all(replace.map(name => apiDeleteItem(name, currentPath, driveId)));
      } catch (err) {
        console.error('Failed to remove replaced items:', err);
      }
      if (mgr.generation !== generation) {
        if (op) apiCancelOperation(op.id).catch(() => {});
        return;
      }
    }
    mgr.addEntries(entries, driveId, currentPath);
  }, [getManager, longOpStartImmediate, longOpStop, showOpError, dismissOpError]);

  const cancelAll = useCallback(() => {
    managerRef.current?.cancelAll();
  }, []);

  return { addEntries, cancelAll };
}

export async function traverseFileTree(entry, path) {
  path = path || '';
  if (entry.isFile) {
    return new Promise(resolve => {
      entry.file(file => {
        resolve([{ file, path: path + file.name }]);
      });
    });
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    return new Promise(resolve => {
      dirReader.readEntries(async entries => {
        let files = [];
        for (let e of entries) {
          const result = await traverseFileTree(e, path + entry.name + '/');
          files = files.concat(result);
        }
        resolve(files);
      });
    });
  }
  return [];
}
