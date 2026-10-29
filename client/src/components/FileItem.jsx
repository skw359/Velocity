import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { apiGetSize } from '../api/fetch';
import { scheduleBackgroundTask } from '../utils/requestQueue';
import { formatBytes, formatDate, getFileExtension, getContentBaseUrl, imageExtensions, audioExtensions, videoExtensions, movExtensions, pdfExtensions, archiveExtensions, rawImageExtensions } from '../utils/format';
import FileActions from './FileActions';

const ICON_COLORS = {
  folder: '#7189ed',
  audio: '#c084fc',
  image: '#34d399',
  pdf: '#f87171',
  video: '#60a5fa',
  archive: '#fbbf24',
  file: '#9ca3af',
};

function FileTypeIcon({ type }) {
  const svgProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
  let paths;
  switch (type) {
    case 'folder':
      paths = <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />;
      break;
    case 'audio':
      paths = <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>;
      break;
    case 'image':
      paths = <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>;
      break;
    case 'pdf':
      paths = <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></>;
      break;
    case 'video':
      paths = <><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></>;
      break;
    case 'archive':
      paths = <><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></>;
      break;
    default:
      paths = <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>;
  }
  return <svg {...svgProps} style={{ color: ICON_COLORS[type] || ICON_COLORS.file }}>{paths}</svg>;
}

export default function FileItem({ item, itemPath, drive, isSearch, index, visibleItems, onNavigateFolder, onPreview, onDelete, onRename, onInfo, onExtract, onCompress, onCopy, onCopyTo, onMoveTo, onDownload, onShare }) {
  const { state, dispatch } = useAppContext();
  const [actionsOpen, setActionsOpen] = useState(false);

  const extension = getFileExtension(item.name);
  const isSelected = state.selectedItems.has(item.name);
  const apiImagePath = `${itemPath === '/' ? '' : itemPath}/${item.name}`;

  // Files arrive with their size; folders (and size-less search hits) are fetched lazily below.
  // The fetched value is tagged with its item so a reused row never shows another item's size.
  const knownSize = item.size != null ? formatBytes(item.size) : null;
  const itemKey = `${drive}:${itemPath}:${item.name}`;
  const [fetchedSize, setFetchedSize] = useState({ key: null, text: null });
  const sizeText = knownSize ?? (fetchedSize.key === itemKey ? fetchedSize.text : null);

  useEffect(() => {
    if (item.size != null) return;
    let cancelled = false;
    const { promise, cancel } = scheduleBackgroundTask(
      (signal) => apiGetSize(item.name, itemPath, drive, signal)
    );
    promise.then(
      (data) => {
        if (cancelled) return;
        setFetchedSize({ key: itemKey, text: formatBytes(data.size) });
        dispatch({ type: 'UPDATE_FILE_SIZE', payload: { name: item.name, size: data.size } });
      },
      (err) => {
        // Aborted by navigation/unmount: not a real failure.
        if (cancelled || err?.name === 'AbortError') return;
        setFetchedSize({ key: itemKey, text: '---' });
      }
    );
    return () => { cancelled = true; cancel(); };
  }, [item.name, item.size, itemPath, drive, itemKey, dispatch]);

  // Thumbnails go through the background queue, never a bare <img src>, so a navigation can
  // abort them instead of leaving the next listing stuck behind them.
  const isImageThumb = item.type !== 'folder' && imageExtensions.includes(extension);
  const [thumb, setThumb] = useState({ key: null, url: null });
  const thumbUrl = thumb.key === itemKey ? thumb.url : null;
  useEffect(() => {
    if (!isImageThumb) return;
    let objectUrl = null;
    let cancelled = false;
    const { promise, cancel } = scheduleBackgroundTask(async (signal) => {
      // Plain fetch: a thumbnail's stray 403 must not bounce the app to the login page.
      const res = await fetch(
        `/api/thumbnail?path=${encodeURIComponent(apiImagePath)}&drive=${encodeURIComponent(drive)}`,
        { signal }
      );
      if (!res.ok) throw new Error('thumbnail unavailable');
      return res.blob();
    });
    promise.then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setThumb({ key: itemKey, url: objectUrl });
      },
      () => { /* aborted or failed: keep the type icon */ }
    );
    return () => {
      cancelled = true;
      cancel();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImageThumb, apiImagePath, drive, itemKey]);

  let iconHtml;
  if (item.type === 'folder') {
    iconHtml = <FileTypeIcon type="folder" />;
  } else if (isImageThumb) {
    iconHtml = thumbUrl ? <img src={thumbUrl} alt={item.name} /> : <FileTypeIcon type="image" />;
  } else if (audioExtensions.includes(extension)) {
    iconHtml = <FileTypeIcon type="audio" />;
  } else if (rawImageExtensions.includes(extension)) {
    iconHtml = <FileTypeIcon type="image" />;
  } else if (pdfExtensions.includes(extension)) {
    iconHtml = <FileTypeIcon type="pdf" />;
  } else if (videoExtensions.includes(extension) || movExtensions.includes(extension)) {
    iconHtml = <FileTypeIcon type="video" />;
  } else if (archiveExtensions.includes(extension)) {
    iconHtml = <FileTypeIcon type="archive" />;
  } else {
    iconHtml = <FileTypeIcon type="file" />;
  }

  const handleSelectionClick = useCallback((e) => {
    e.preventDefault(); // Prevent native checkbox toggle; we manage state ourselves

    const newSelected = new Map(state.selectedItems);
    const isChecking = !isSelected;

    if (e.shiftKey && state.lastClickedIndex !== -1 && index !== undefined && visibleItems) {
      const start = Math.min(state.lastClickedIndex, index);
      const end = Math.max(state.lastClickedIndex, index);
      for (let i = start; i <= end; i++) {
        const rangeItem = visibleItems[i];
        if (rangeItem) {
          const rangePath = isSearch ? rangeItem.path : itemPath;
          if (isChecking) {
            newSelected.set(rangeItem.name, { path: rangePath, drive, type: rangeItem.type });
          } else {
            newSelected.delete(rangeItem.name);
          }
        }
      }
    } else {
      if (isChecking) {
        newSelected.set(item.name, { path: itemPath, drive, type: item.type });
      } else {
        newSelected.delete(item.name);
      }
    }

    dispatch({ type: 'SET_SELECTED_ITEMS', payload: newSelected });
    if (index !== undefined) dispatch({ type: 'SET_LAST_CLICKED_INDEX', payload: index });
  }, [state.selectedItems, state.lastClickedIndex, isSelected, item.name, item.type, itemPath, drive, index, visibleItems, isSearch, dispatch]);

  const isGrid = state.viewMode === 'grid';

  const open = useCallback(() => {
    if (item.type === 'folder') onNavigateFolder(item.name, itemPath);
    else onPreview(item.name, itemPath);
  }, [item.type, item.name, itemPath, onNavigateFolder, onPreview]);

  // Grid view has no checkboxes: click selects, double click opens. The single click is
  // deferred so a double click can cancel it.
  const clickTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(clickTimerRef.current), []);

  const handleCardClick = useCallback((e) => {
    if (!isGrid) { open(); return; }            // list view: click opens (selection is via the checkbox)
    if (e.shiftKey) { handleSelectionClick(e); return; }
    if (clickTimerRef.current) return;
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      handleSelectionClick(e);
    }, 220);
  }, [isGrid, open, handleSelectionClick]);

  const handleCardDoubleClick = useCallback((e) => {
    if (!isGrid) return;
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
    open();
  }, [isGrid, open]);

  const handleInfoClick = useCallback(() => onInfo(item.name, itemPath, drive), [item.name, itemPath, drive, onInfo]);
  const handleDeleteClick = useCallback(() => onDelete(item.name, itemPath, drive), [item.name, itemPath, drive, onDelete]);
  const handleRenameClick = useCallback(() => onRename(item.name, itemPath, drive), [item.name, itemPath, drive, onRename]);

  return (
    <li className={`file-item${isSelected ? ' selected' : ''}${state.viewMode === 'grid' ? ' view-grid' : ''}`} data-name={item.name} data-type={item.type} data-path={itemPath} data-drive={drive}>
      <div className="selection-box">
        <label className="custom-checkbox-label" onClick={handleSelectionClick}>
          <input
            type="checkbox"
            className="file-checkbox"
            data-name={item.name}
            checked={isSelected}
            readOnly
          />
          <span className="custom-checkbox-box"></span>
        </label>
      </div>
      <div
        className="file-info"
        onClick={handleCardClick}
        onDoubleClick={handleCardDoubleClick}
      >
        <div className="file-icon">{iconHtml}</div>
        <div className="file-details">
          <span className="file-name">{item.name}</span>
          {isSearch && <span className="search-result-path">in: {item.path}</span>}
        </div>
      </div>
      <div className="file-meta">
        <span className="file-modified">{formatDate(item.mtime)}</span>
        <span className="file-size">
          {sizeText === null ? <div className="loader"></div> : sizeText}
        </span>
      </div>
      <FileActions
        name={item.name}
        type={item.type}
        path={itemPath}
        drive={drive}
        extension={extension}
        isGrid={isGrid}
        open={actionsOpen}
        onToggle={() => setActionsOpen(!actionsOpen)}
        onClose={() => setActionsOpen(false)}
        onShare={() => onShare(item.name, item.type, itemPath, drive)}
        onDownload={() => onDownload(item.name, item.type, itemPath, drive)}
        onInfo={handleInfoClick}
        onExtract={() => onExtract(item.name, itemPath)}
        onCompress={() => onCompress(item.name, item.type, itemPath)}
        onCopy={() => onCopy(item.name, itemPath)}
        onCopyTo={() => onCopyTo(item.name, item.type, itemPath, drive)}
        onMoveTo={() => onMoveTo(item.name, item.type, itemPath, drive)}
        onRename={handleRenameClick}
        onDelete={handleDeleteClick}
      />
    </li>
  );
}
