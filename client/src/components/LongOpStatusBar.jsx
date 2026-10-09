import { useState, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { apiCancelOperation } from '../api/fetch';
import { clientId } from '../hooks/useOperations';
import ConfirmModal from './modals/ConfirmModal';

const VERB = {
  copy: 'Copying', move: 'Moving', duplicate: 'Duplicating', upload: 'Uploading',
  extract: 'Extracting', compress: 'Compressing', delete: 'Deleting',
  rename: 'Renaming', 'create-folder': 'Creating folder', 'create-file': 'Creating file',
};

// Per-file tooltip rows for a lone upload, and for one nested in a multi-task list.
const MAX_TOOLTIP_FILES = 10;
const MAX_NESTED_FILES = 5;

function driveLabel(drives, id) {
  if (!id || id === 'internal') return null; // internal is the default; don't clutter the message
  const d = drives?.find(x => x.id === id || x.letter === id);
  return d ? (d.label || d.letter || id) : id;
}

// e.g. "Copying 3 items from /A to /B (drive D)…", unless the record carries its own message.
function buildMessage(op, drives) {
  if (op.message) return op.message;
  const verb = VERB[op.type] || 'Processing';
  const items = op.items || [];
  const n = op.itemCount || items.length || 1;
  const subject = n === 1 ? `'${items[0]?.targetName || items[0]?.name || ''}'` : `${n} items`;
  if (op.type === 'copy' || op.type === 'move') {
    const src = items[0]?.sourcePath;
    const sd = driveLabel(drives, items[0]?.sourceDrive);
    const dd = driveLabel(drives, op.destDrive);
    const from = src ? ` from ${src}${sd ? ` (${sd})` : ''}` : '';
    const to = op.destPath ? ` to ${op.destPath}${dd ? ` (${dd})` : ''}` : '';
    return `${verb} ${subject}${from}${to}…`;
  }
  return `${verb} ${subject}…`;
}

function uploadFiles(op) {
  return (op.items || [])
    .filter(it => it.size)
    .map(it => ({ name: it.name, percent: Math.min(100, Math.floor(((it.bytesReceived || 0) / it.size) * 100)) }))
    .filter(f => f.percent < 100)
    .slice(0, MAX_TOOLTIP_FILES);
}

// Merges this tab's local ops with the backend's active records, oldest first:
//   { id, message, percent: number|null, cancel: fn|null, isUpload, files: [{name, percent}], startedAt }
function collectTasks(state, longOpCancel) {
  const localOps = state.localOps || {};
  const tasks = Object.entries(localOps).map(([key, t]) => ({
    id: `local:${key}`,
    message: t.message,
    percent: typeof t.percent === 'number' ? t.percent : null,
    cancel: t.showCancel ? () => longOpCancel(key) : null,
    isUpload: key === 'upload',
    files: t.showUploadInfo ? (t.tooltipFiles || []) : [],
    startedAt: t.startedAt || 0,
  }));
  const ownUploadIsLocal = !!localOps.upload;
  for (const op of state.activeOperations || []) {
    // This tab's own upload is listed from the local manager, whose progress is smoother than the 2s poll.
    if (ownUploadIsLocal && op.type === 'upload' && op.clientId === clientId) continue;
    // 'pending' = waiting behind an earlier op. Uploads are never claimed by the runner,
    // so they stay 'pending' throughout.
    const queued = op.status === 'pending' && op.type !== 'upload';
    tasks.push({
      id: op.id,
      message: `${queued ? 'Queued: ' : ''}${buildMessage(op, state.availableDrives)}`,
      percent: typeof op.progress === 'number' ? op.progress : 0,
      cancel: () => apiCancelOperation(op.id).catch(() => {}),
      isUpload: op.type === 'upload',
      files: op.type === 'upload' ? uploadFiles(op) : [],
      startedAt: new Date(op.createdAt).getTime() || 0,
    });
  }
  return tasks.sort((a, b) => a.startedAt - b.startedAt);
}

function FileRows({ files, className, max }) {
  const shown = files.slice(0, max);
  return (
    <>
      {shown.map((f, i) => (
        <li key={i} className={className}>
          <span className="tooltip-file-name">{f.name}</span>
          <span className="tooltip-file-progress">{f.percent}%</span>
        </li>
      ))}
      {files.length > shown.length && (
        <li className={`${className} long-op-task-more`}>+{files.length - shown.length} more</li>
      )}
    </>
  );
}

// Rendered keyed by the error's id so a repeat of the same refusal visibly arrives again.
function OpErrorBanner({ error, onDismiss }) {
  return (
    <div className="long-op-status-bar long-op-error show" role="alert">
      <div className="long-op-content">
        <div className="long-op-status-left">
          <svg className="long-op-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span className="long-op-error-text">
            <strong>{error.title}</strong>
            {error.detail && <span className="long-op-error-detail">{error.detail}</span>}
          </span>
        </div>
        <button type="button" className="long-op-cancel-btn" style={{ display: 'block' }} onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

export default function LongOpStatusBar() {
  const { state, longOpCancel, dismissOpError } = useAppContext();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const hideTimerRef = useRef(null);
  // Kept after the dialog closes so its text doesn't change while it fades out.
  const [confirm, setConfirm] = useState({ show: false, keys: [], count: 0, hasUpload: false });

  const tasks = collectTasks(state, longOpCancel);
  const cancelable = tasks.filter(t => t.cancel);
  // Slot ids like 'local:upload' are reused by the next batch, so pin tasks by id + start time.
  // Looked up live, so a task that finishes while the dialog is open isn't cancelled late.
  const taskKey = (t) => `${t.id}@${t.startedAt}`;
  const confirmTargets = cancelable.filter(t => confirm.keys.includes(taskKey(t)));
  const confirmOpen = confirm.show && confirmTargets.length > 0;

  const closeConfirm = useCallback(() => setConfirm(c => ({ ...c, show: false })), []);

  // Uploads and multi-task cancels ask first; a single other task cancels straight away.
  const requestCancel = (targets) => {
    if (targets.length === 1 && !targets[0].isUpload) { targets[0].cancel(); return; }
    setConfirm({
      show: true,
      keys: targets.map(taskKey),
      count: targets.length,
      hasUpload: targets.some(t => t.isUpload),
    });
  };

  const confirmCancel = () => {
    confirmTargets.forEach(t => t.cancel());
    closeConfirm();
  };

  const confirmModal = (
    <ConfirmModal
      show={confirmOpen}
      title={confirm.count > 1 ? 'Cancel All Tasks' : 'Cancel Upload'}
      message={<>
        {confirm.count > 1
          ? `Are you sure you want to cancel all ${confirm.count} running tasks?`
          : 'Are you sure you want to cancel this upload?'}
        {confirm.hasUpload && <><br /><br />Files that have already finished uploading will be kept.</>}
      </>}
      onConfirm={confirmCancel}
      onCancel={closeConfirm}
    />
  );

  const errorBanner = state.opError && (
    <OpErrorBanner key={state.opError.id} error={state.opError} onDismiss={dismissOpError} />
  );

  if (tasks.length === 0) return <>{errorBanner}{confirmModal}</>;

  const multi = tasks.length > 1;
  let percent, message, showInfo, cancelLabel, onCancel;
  if (multi) {
    const known = tasks.filter(t => t.percent !== null);
    percent = known.length ? known.reduce((sum, t) => sum + t.percent, 0) / known.length : 0;
    message = `${tasks.length} tasks running…`;
    showInfo = true;
    cancelLabel = cancelable.length > 1 ? 'Cancel all' : 'Cancel';
    onCancel = cancelable.length === 0 ? null : () => requestCancel(cancelable);
  } else {
    const [task] = tasks;
    percent = task.percent ?? 0;
    message = task.message;
    showInfo = task.files.length > 0;
    cancelLabel = 'Cancel';
    onCancel = task.cancel ? () => requestCancel([task]) : null;
  }

  const openTooltip = () => {
    clearTimeout(hideTimerRef.current);
    setTooltipVisible(true);
  };
  const closeTooltipSoon = () => {
    hideTimerRef.current = setTimeout(() => setTooltipVisible(false), 150);
  };

  return (
    <>
    {errorBanner}
    <div className="long-op-status-bar show">
      <div className="long-op-progress-fill" style={{ width: `${(percent || 0).toFixed(1)}%` }}></div>
      <div className="long-op-content">
        <div className="long-op-status-left">
          <div className="loader"></div>
          <span>{message}</span>
          {showInfo && (
            <div
              className="upload-info-container"
              style={{ display: 'block' }}
              onMouseEnter={openTooltip}
              onMouseLeave={closeTooltipSoon}
            >
              {/* Click toggles too, for touch screens with no hover. */}
              <div className="upload-info-icon" onClick={() => setTooltipVisible(v => !v)}>i</div>
              <div
                className={`upload-tooltip${tooltipVisible ? ' show' : ''}`}
                onMouseEnter={() => clearTimeout(hideTimerRef.current)}
                onMouseLeave={() => setTooltipVisible(false)}
              >
                {multi ? (
                  <ul className="upload-tooltip-list">
                    {tasks.map(t => (
                      <li key={t.id} className="long-op-task">
                        <div className="long-op-task-row">
                          <span className="long-op-task-message" title={t.message}>{t.message}</span>
                          {t.percent !== null && (
                            <span className="tooltip-file-progress">{Math.floor(t.percent)}%</span>
                          )}
                          {t.cancel && (
                            <button type="button" className="long-op-task-cancel" onClick={() => requestCancel([t])}>Cancel</button>
                          )}
                        </div>
                        {t.files.length > 0 && (
                          <ul className="long-op-task-files">
                            <FileRows files={t.files} className="long-op-task-file" max={MAX_NESTED_FILES} />
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <ul className="upload-tooltip-list">
                    <FileRows files={tasks[0].files} className="upload-tooltip-item" max={MAX_TOOLTIP_FILES} />
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
        {onCancel && (
          <button className="long-op-cancel-btn" style={{ display: 'block' }} onClick={onCancel}>{cancelLabel}</button>
        )}
      </div>
    </div>
    {confirmModal}
    </>
  );
}
