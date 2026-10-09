import { useEffect, useCallback, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { fetchWithAuthCheck } from '../api/fetch';
import { formatBytes, formatDate, getFileExtension, getContentBaseUrl, getFileCategory, imageExtensions, audioExtensions, videoExtensions, movExtensions, pdfExtensions, archiveExtensions, rawImageExtensions } from '../utils/format';
import FileItem from './FileItem';
import FileListHeader from './FileListHeader';

// One shared collator: localeCompare with options builds a new Intl.Collator per comparison,
// which freezes the main thread when sorting thousands of files.
const nameCollator = new Intl.Collator(undefined, { numeric: true });

const ITEMS_PER_PAGE = 100;

export default function FileList({ searchResults, startOperation, onNavigateFolder, onPreview, onDelete, onRename, onInfo, onShare, onRefresh, onRefreshStorage }) {
  const { state, dispatch, longOpStart, longOpStop } = useAppContext();

  const enqueueItemOp = useCallback((type, name, path, itemType) => {
    startOperation({
      type,
      destDrive: state.currentDrive,
      destPath: path,
      items: [{ name, sourceDrive: state.currentDrive, sourcePath: path, itemType }],
    }).catch(e => { if (!e.handled) alert(e.message); }); // handled: shown in the long-op bar's spot
  }, [startOperation, state.currentDrive]);

  const beginTransfer = useCallback((mode, name, type, path, drive) => {
    dispatch({ type: 'START_TRANSFER', payload: { mode, items: [{ name, sourcePath: path, sourceDrive: drive }] } });
  }, [dispatch]);
  const handleCopyTo = useCallback((name, type, path, drive) => beginTransfer('copy', name, type, path, drive), [beginTransfer]);
  const handleMoveTo = useCallback((name, type, path, drive) => beginTransfer('move', name, type, path, drive), [beginTransfer]);

  const matchesType = useCallback(
    (item) => state.typeFilter === 'all' || getFileCategory(item) === state.typeFilter,
    [state.typeFilter]
  );

  // Memoized so re-renders (e.g. while leaving a folder) don't re-sort a possibly huge listing.
  const sortedData = useMemo(() => {
    const data = state.fileData;
    if (!data || data.length === 0) return [];
    const matches = (item) => state.typeFilter === 'all' || getFileCategory(item) === state.typeFilter;
    const cmp = (a, b) => {
      switch (state.currentSort) {
        case 'date-desc': return new Date(b.mtime) - new Date(a.mtime);
        case 'date-asc': return new Date(a.mtime) - new Date(b.mtime);
        case 'size-desc': return (b.size ?? -1) - (a.size ?? -1);
        case 'size-asc': return (a.size ?? -1) - (b.size ?? -1);
        case 'type-asc': {
          const extCompare = nameCollator.compare(getFileExtension(a.name), getFileExtension(b.name));
          return extCompare !== 0 ? extCompare : nameCollator.compare(a.name, b.name);
        }
        default: return nameCollator.compare(a.name, b.name);
      }
    };
    const folders = data.filter(item => item.type === 'folder' && matches(item)).sort(cmp);
    const files = data.filter(item => item.type === 'file' && matches(item)).sort(cmp);
    return [...folders, ...files];
  }, [state.fileData, state.currentSort, state.typeFilter]);

  const listClass = `file-list${state.viewMode === 'grid' ? ' view-grid' : ''}`;

  if (state.isSearchMode) {
    const filteredResults = searchResults.filter(matchesType);
    if (filteredResults.length === 0) {
      return (
        <>
          <ul className="file-list" id="file-list">
            <div className="empty-state">
              <h3>No results found</h3>
              <p>{state.typeFilter === 'all' ? 'Try a different search term.' : 'No results match this type filter.'}</p>
            </div>
          </ul>
        </>
      );
    }
    return (
      <>
      <FileListHeader />
      <ul className={listClass} id="file-list">
        {filteredResults.map((item, i) => (
          <FileItem
            key={`${item.name}-${item.path}-${i}`}
            item={item}
            itemPath={item.path}
            drive={state.currentDrive}
            isSearch={true}
            index={i}
            visibleItems={filteredResults}
            onNavigateFolder={onNavigateFolder}
            onPreview={onPreview}
            onDelete={onDelete}
            onRename={onRename}
            onInfo={onInfo}
            onExtract={(name, path) => enqueueItemOp('extract', name, path)}
            onCompress={(name, type, path) => enqueueItemOp('compress', name, path, type)}
            onCopy={(name, path) => enqueueItemOp('duplicate', name, path)}
            onCopyTo={handleCopyTo}
            onMoveTo={handleMoveTo}
            onDownload={(name, type, path, drive) => downloadItem(name, type, path, drive, longOpStart, longOpStop)}
            onShare={onShare}
          />
        ))}
      </ul>
      </>
    );
  }

  if (!state.fileData || state.fileData.length === 0) {
    return (
      <>
        <ul className="file-list" id="file-list">
          <div className="empty-state">
            <h3>No files or folders yet</h3>
            <p>Click the + button or drag and drop to add content</p>
          </div>
        </ul>
      </>
    );
  }

  if (sortedData.length === 0) {
    return (
      <ul className="file-list" id="file-list">
        <div className="empty-state">
          <h3>Nothing to show</h3>
          <p>No items in this folder match the selected type.</p>
        </div>
      </ul>
    );
  }

  const visibleData = sortedData.slice(0, state.currentPage * ITEMS_PER_PAGE);
  const hasMore = sortedData.length > state.currentPage * ITEMS_PER_PAGE;

  return (
    <>
      <FileListHeader />
      <ul className={listClass} id="file-list">
        {visibleData.map((item, i) => (
          <FileItem
            key={`${item.name}-${i}`}
            item={item}
            itemPath={state.currentPath}
            drive={state.currentDrive}
            isSearch={false}
            index={i}
            visibleItems={visibleData}
            onNavigateFolder={onNavigateFolder}
            onPreview={onPreview}
            onDelete={onDelete}
            onRename={onRename}
            onInfo={onInfo}
            onExtract={(name, path) => enqueueItemOp('extract', name, path)}
            onCompress={(name, type, path) => enqueueItemOp('compress', name, path, type)}
            onCopy={(name, path) => enqueueItemOp('duplicate', name, path)}
            onCopyTo={handleCopyTo}
            onMoveTo={handleMoveTo}
            onDownload={(name, type, path, drive) => downloadItem(name, type, path, drive, longOpStart, longOpStop)}
            onShare={onShare}
          />
        ))}
      </ul>
      <div id="load-more-container" style={{ display: hasMore ? 'flex' : 'none' }}>
        <button
          id="load-more-btn"
          className="modal-button modal-button-delete"
          onClick={() => dispatch({ type: 'SET_PAGE', payload: state.currentPage + 1 })}
        >
          Load More
        </button>
      </div>
    </>
  );
}

async function downloadItem(name, type, path, drive, longOpStart, longOpStop) {
  const downloadUrl = `/api/download?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`;
  if (type === 'file') {
    window.location.href = downloadUrl;
  } else {
    // One slot per folder so two concurrent zips each keep their own bar entry.
    const opKey = `download:${drive}:${path}/${name}`;
    longOpStart(opKey, `Zipping '${name}'...`);
    try {
      const response = await fetchWithAuthCheck(downloadUrl);
      if (!response.ok) throw new Error(`Download failed: ${await response.text()}`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Download error:', error);
      alert(error.message);
    } finally {
      longOpStop(opKey);
    }
  }
}
