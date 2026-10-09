import { useEffect, useCallback, useRef, useState } from 'react';
import { useMatch } from 'react-router-dom';
import { AppProvider, useAppContext } from '../context/AppContext';
import { StatsProvider } from '../context/StatsContext';
import { useWebSocket } from '../hooks/useWebSocket';
import { usePolling, useLoadStorage } from '../hooks/usePolling';
import { useOperations } from '../hooks/useOperations';
import { useUpload, traverseFileTree } from '../hooks/useUpload';
import { apiListFiles, apiGetDrives, apiCheckConflicts } from '../api/fetch';
import { cancelBackgroundTasks } from '../utils/requestQueue';
import { applyConflictResolutions, samePath } from '../utils/conflicts';
import Header from '../components/Header';
import NavBar from '../components/NavBar';
import Breadcrumb from '../components/Breadcrumb';
import FileList from '../components/FileList';
import UtilityBar from '../components/UtilityBar';
import TransferBar from '../components/TransferBar';
import FloatingActions from '../components/FloatingActions';
import DropZone from '../components/DropZone';
import LongOpStatusBar from '../components/LongOpStatusBar';
import GlobalLoader from '../components/GlobalLoader';
import DeleteModal from '../components/modals/DeleteModal';
import CreateFolderModal from '../components/modals/CreateFolderModal';
import CreateFileModal from '../components/modals/CreateFileModal';
import RenameModal from '../components/modals/RenameModal';
import InfoModal from '../components/modals/InfoModal';
import PreviewModal from '../components/modals/PreviewModal';
import ShareModal from '../components/modals/ShareModal';
import ConflictModal from '../components/modals/ConflictModal';
import SettingsPage from './SettingsPage';
import '../styles/global.css';

function DashboardContent({ account }) {
  const isSettingsPage = !!useMatch('/app/settings');
  const { state, dispatch, longOpStop } = useAppContext();
  const { loadStorageInfo } = useLoadStorage();
  usePolling();

  // Both views stay mounted and a `hidden` flip can't animate, so shownPage lags the route by one fade-out.
  const [shownPage, setShownPage] = useState(isSettingsPage ? 'settings' : 'files');
  const [pageFading, setPageFading] = useState(false);
  const settingsVisible = shownPage === 'settings';

  useEffect(() => {
    const target = isSettingsPage ? 'settings' : 'files';
    if (target === shownPage) return;
    setPageFading(true);
    const swap = setTimeout(() => {
      setShownPage(target);
      // Give the un-hidden page a frame to lay out before it fades in.
      requestAnimationFrame(() => requestAnimationFrame(() => setPageFading(false)));
    }, 250); // matches .content's 0.25s opacity transition
    return () => clearTimeout(swap);
  }, [isSettingsPage, shownPage]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const isSearchCancelledRef = useRef(false);
  const topLoaderRef = useRef(null);
  const contentRef = useRef(null);
  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const loadAbortRef = useRef(null);

  const [deleteModal, setDeleteModal] = useState({ show: false, name: '', path: '', drive: 'internal', isMass: false });
  const [folderModal, setFolderModal] = useState(false);
  const [fileModal, setFileModal] = useState(false);
  const [renameModal, setRenameModal] = useState({ show: false, name: '', path: '', drive: 'internal' });
  const [infoModal, setInfoModal] = useState({ show: false, name: '', path: '', drive: 'internal' });
  const [previewModal, setPreviewModal] = useState({ show: false, name: '', path: '' });
  const [shareModal, setShareModal] = useState({ show: false, name: '', type: 'file', path: '', drive: 'internal' });
  const [conflictModal, setConflictModal] = useState({ show: false, conflicts: [], entries: [], existingNames: [], drive: 'internal', path: '/' });
  const [transferConflict, setTransferConflict] = useState({ show: false, conflicts: [], mode: 'copy', items: [], destPath: '/', destDrive: 'internal', autoDecisions: {} });

  const onSearchResult = useCallback((data) => {
    if (isSearchCancelledRef.current) return;
    setSearchResults(prev => {
      const newResults = [...prev, data];
      dispatch({ type: 'SET_SEARCH_RESULT_COUNT', payload: newResults.length });
      return newResults;
    });
  }, [dispatch]);

  const onSearchComplete = useCallback(() => {
    if (isSearchCancelledRef.current) return;
    longOpStop('search');
  }, [longOpStop]);

  const onSearchError = useCallback((message) => {
    if (isSearchCancelledRef.current) return;
    longOpStop('search');
  }, [longOpStop]);

  const { startSearch, stopSearch } = useWebSocket({
    onSearchResult,
    onSearchComplete,
    onSearchError,
  });

  const loadFiles = useCallback(async () => {
    dispatch({ type: 'SET_SEARCH_MODE', payload: false });
    dispatch({ type: 'SET_SELECTED_ITEMS', payload: new Map() });
    dispatch({ type: 'SET_LAST_CLICKED_INDEX', payload: -1 });
    setSearchQuery('');
    setSearchResults([]);
    if (searchInputRef.current) searchInputRef.current.value = '';

    // Cancel the previous folder's pending work so the new request isn't queued behind it
    // and a late response can't overwrite this one.
    cancelBackgroundTasks();
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const path = state.currentPath;
    const drive = state.currentDrive;

    const tl = topLoaderRef.current;
    if (tl) {
      tl.style.transition = 'none';
      tl.style.transform = 'scaleX(0)';
      tl.style.opacity = '1';
      // Force a reflow so the reset is committed before the grow animation.
      void tl.offsetWidth;
      tl.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
      tl.style.transform = 'scaleX(0.70)';
      setTimeout(() => {
        const currentScale = parseFloat(tl.style.transform.replace(/scaleX\(|\)/, ''));
        if (currentScale < 0.95) {
          tl.style.transition = 'transform 15s linear';
          tl.style.transform = 'scaleX(0.85)';
        }
      }, 500);
    }

    // Fade out while the fetch runs; content swaps only after the full fade-out.
    const cd = contentRef.current;
    if (cd) cd.classList.add('fading');
    const fadeOut = new Promise(r => setTimeout(r, 250)); // matches .content's 0.25s opacity transition

    try {
      const data = await apiListFiles(path, drive, controller.signal);
      if (controller.signal.aborted) return; // a newer navigation superseded this load
      await fadeOut;
      if (controller.signal.aborted) return;
      dispatch({ type: 'SET_FILE_DATA', payload: data || [] });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      console.error('Error loading files:', error);
      await fadeOut;
      if (controller.signal.aborted) return;
      dispatch({ type: 'SET_FILE_DATA', payload: [] });
    } finally {
      // A superseded load must leave the newer load's animation untouched.
      if (!controller.signal.aborted) {
        if (tl) {
          tl.style.transition = 'transform 0.1s ease-in';
          tl.style.transform = 'scaleX(1)';
          setTimeout(() => {
            tl.style.transition = 'opacity 0.4s ease-out';
            tl.style.opacity = '0';
          }, 100);
        }
        if (cd) cd.classList.remove('fading');
        setTimeout(() => {
          if (tl) {
            tl.style.transition = 'none';
            tl.style.transform = 'scaleX(0)';
          }
        }, 500);
      }
    }
  }, [state.currentPath, state.currentDrive, dispatch]);

  const refreshOperationsRef = useRef(null);
  const refreshAfterUpload = useCallback(() => {
    loadFiles();
    loadStorageInfo();
    // Operations are only polled every 2s; refresh now so the bar doesn't briefly
    // fall back to the last polled figure after the upload has finished.
    refreshOperationsRef.current?.();
  }, [loadFiles, loadStorageInfo]);

  const { addEntries: uploadEntries, cancelAll: cancelUpload } = useUpload(refreshAfterUpload);

  const performSearch = useCallback((query) => {
    setSearchQuery(query);
    if (!query) {
      isSearchCancelledRef.current = true;
      dispatch({ type: 'SET_SEARCH_MODE', payload: false });
      longOpStop('search');
      stopSearch();
      loadFiles();
      return;
    }

    isSearchCancelledRef.current = false;
    dispatch({ type: 'SET_SEARCH_MODE', payload: true });
    dispatch({ type: 'SET_SEARCH_RESULT_COUNT', payload: 0 });
    setSearchResults([]);

    dispatch({ type: 'SET_LOCAL_OP', payload: { key: 'search', message: `Searching for '${query}'...`, showCancel: false, showUploadInfo: false } });

    if (!startSearch(query, state.currentDrive)) {
      alert('Search unavailable.');
    }
  }, [dispatch, state.currentDrive, startSearch, stopSearch, longOpStop, loadFiles]);

  const navigateToFolder = useCallback((folderName, basePath) => {
    const path = basePath || state.currentPath;
    dispatch({ type: 'SET_PATH', payload: path === '/' ? `/${folderName}` : `${path}/${folderName}` });
  }, [state.currentPath, dispatch]);

  // A finished operation may have changed the current folder, so refresh the view.
  const handleOpComplete = useCallback(() => {
    if (state.isSearchMode && searchQuery) performSearch(searchQuery);
    else loadFiles();
    loadStorageInfo();
  }, [state.isSearchMode, searchQuery, performSearch, loadFiles, loadStorageInfo]);
  const { startOperation, refreshOperations } = useOperations({ onComplete: handleOpComplete });
  // refreshAfterUpload is defined before useOperations (it feeds useUpload), so it
  // reaches the refresher through a ref.
  useEffect(() => { refreshOperationsRef.current = refreshOperations; }, [refreshOperations]);

  useEffect(() => {
    (async () => {
      try {
        const drives = await apiGetDrives();
        dispatch({ type: 'SET_DRIVES', payload: drives });
      } catch {
        dispatch({ type: 'SET_DRIVES', payload: [{ id: 'internal', label: 'Internal Storage', type: 'internal' }] });
      }
      loadStorageInfo();
    })();
  }, []);

  useEffect(() => {
    loadFiles();
  }, [state.currentPath, state.currentDrive]);

  const switchDrive = useCallback((driveId) => {
    dispatch({ type: 'SET_DRIVE', payload: driveId });
    loadStorageInfo(driveId);
  }, [dispatch, loadStorageInfo]);

  const navigateToPath = useCallback((path) => {
    dispatch({ type: 'SET_PATH', payload: path });
  }, [dispatch]);

  const processAndUploadEntries = useCallback(async (items) => {
    if (!items || items.length === 0) return;
    let fileEntries = [];
    try {
      if (items[0] && items[0].webkitGetAsEntry) {
        const promises = Array.from(items).map(item => traverseFileTree(item.webkitGetAsEntry()));
        const results = await Promise.all(promises);
        fileEntries = results.flat();
      } else {
        fileEntries = Array.from(items).map(file => ({ file, path: file.webkitRelativePath || file.name }));
      }
    } catch (e) {
      console.error(e);
      alert('Could not process items.');
      return;
    }
    if (fileEntries.length === 0) return;

    const drive = state.currentDrive;
    const path = state.currentPath;

    // Let the user resolve top-level name collisions instead of silently overwriting.
    const topNames = [...new Set(fileEntries.map(e => e.path.split('/')[0]))];
    let conflicts = [];
    let existingNames = [];
    try {
      const result = await apiCheckConflicts(path, drive, topNames);
      conflicts = result.conflicts || [];
      existingNames = result.existingNames || [];
    } catch (err) {
      // A failed check shouldn't block the upload.
      console.error('Conflict check failed:', err);
    }

    if (conflicts.length === 0) {
      uploadEntries(fileEntries, drive, path);
      return;
    }
    setConflictModal({ show: true, conflicts, entries: fileEntries, existingNames, drive, path });
  }, [state.currentDrive, state.currentPath, uploadEntries]);

  const handleConflictResolve = useCallback((decisions) => {
    const { entries, existingNames, drive, path } = conflictModal;
    setConflictModal(prev => ({ ...prev, show: false }));

    const { finalEntries, toDelete } = applyConflictResolutions(entries, decisions, existingNames);

    if (finalEntries.length) {
      // The uploader deletes replaced items itself (handling file<->folder type changes),
      // only after the server confirms the upload fits.
      uploadEntries(finalEntries, drive, path, { replace: toDelete });
    } else {
      refreshAfterUpload();
    }
  }, [conflictModal, uploadEntries, refreshAfterUpload]);

  const handleConflictCancel = useCallback(() => {
    setConflictModal(prev => ({ ...prev, show: false }));
  }, []);

  const handleRefresh = useCallback(async () => {
    if (state.isSearchMode && searchQuery) {
      performSearch(searchQuery);
    } else {
      await loadFiles();
    }
    loadStorageInfo();
  }, [state.isSearchMode, searchQuery, performSearch, loadFiles, loadStorageInfo]);

  const handleTransferCancel = useCallback(() => {
    dispatch({ type: 'CANCEL_TRANSFER' });
  }, [dispatch]);

  // decisions: { [name]: 'replace' | 'skip' | 'rename' }; a name without one has no clash.
  const runTransfer = useCallback(async (mode, items, destPath, destDrive, decisions = {}) => {
    const toRun = items.filter(item => decisions[item.name] !== 'skip');
    dispatch({ type: 'CANCEL_TRANSFER' });
    if (toRun.length === 0) {
      await loadFiles();
      loadStorageInfo();
      return;
    }

    try {
      await startOperation({
        type: mode,
        destPath,
        destDrive,
        items: toRun.map(item => ({
          name: item.name,
          sourceDrive: item.sourceDrive,
          sourcePath: item.sourcePath,
          conflict: decisions[item.name],
        })),
      });
    } catch (e) {
      // A refusal (space, drive access) is already shown in the long-op bar's spot.
      if (!e.handled) alert(`Could not start ${mode === 'copy' ? 'copy' : 'move'}: ${e.message}`);
    }
  }, [dispatch, startOperation, loadFiles, loadStorageInfo]);

  const handleTransferConfirm = useCallback(async () => {
    const op = state.transferOp;
    if (!op || op.items.length === 0) return;
    const destPath = state.currentPath;
    const destDrive = state.currentDrive;

    // Moving an item into its own folder is a no-op.
    let items = op.items;
    if (op.mode === 'move') {
      items = items.filter(it => !(it.sourceDrive === destDrive && samePath(it.sourcePath, destPath)));
      if (items.length === 0) { dispatch({ type: 'CANCEL_TRANSFER' }); return; }
    }

    let conflicts = [];
    try {
      const result = await apiCheckConflicts(destPath, destDrive, items.map(it => it.name));
      conflicts = result.conflicts || [];
    } catch (err) {
      console.error('Transfer conflict check failed:', err);
    }

    // A same-folder copy clashes with itself; treat it as a deliberate duplicate (rename).
    const autoDecisions = {};
    if (op.mode === 'copy') {
      for (const it of items) {
        if (it.sourceDrive === destDrive && samePath(it.sourcePath, destPath)) {
          autoDecisions[it.name] = 'rename';
        }
      }
    }
    const promptable = conflicts.filter(c => !(c.name in autoDecisions));

    if (promptable.length === 0) {
      runTransfer(op.mode, items, destPath, destDrive, autoDecisions);
      return;
    }
    setTransferConflict({ show: true, conflicts: promptable, mode: op.mode, items, destPath, destDrive, autoDecisions });
  }, [state.transferOp, state.currentPath, state.currentDrive, dispatch, runTransfer]);

  const handleTransferConflictResolve = useCallback((decisions) => {
    const { mode, items, destPath, destDrive, autoDecisions } = transferConflict;
    setTransferConflict(prev => ({ ...prev, show: false }));
    runTransfer(mode, items, destPath, destDrive, { ...autoDecisions, ...decisions });
  }, [transferConflict, runTransfer]);

  const handleTransferConflictCancel = useCallback(() => {
    setTransferConflict(prev => ({ ...prev, show: false }));
    dispatch({ type: 'CANCEL_TRANSFER' });
  }, [dispatch]);

  // Snapshot the selection now; START_TRANSFER clears it.
  const beginMassTransfer = useCallback((mode) => {
    if (state.selectedItems.size === 0) return;
    const items = Array.from(state.selectedItems, ([name, obj]) => ({
      name,
      sourcePath: obj.path,
      sourceDrive: obj.drive,
    }));
    dispatch({ type: 'START_TRANSFER', payload: { mode, items } });
  }, [state.selectedItems, dispatch]);

  return (
    <>
      <Header onRefresh={handleRefresh} />
      <div className="main-container">
        <div className="top-loader" ref={topLoaderRef}></div>
        {/* The chrome swaps mid-crossfade, while the content is transparent. */}
        <NavBar
          searchInputRef={searchInputRef}
          onSearch={performSearch}
          onSwitchDrive={switchDrive}
          settingsPage={settingsVisible}
        />
        <Breadcrumb
          onNavigate={navigateToPath}
          isSearchMode={state.isSearchMode}
          searchResultCount={state.searchResultCount}
          searchQuery={searchQuery}
          settingsPage={settingsVisible}
        />
        <LongOpStatusBar />
        {/* Retain both views so navigation preserves search and transfers. */}
        <div className={`content settings-content${pageFading ? ' fading' : ''}`} hidden={!settingsVisible}>
          <SettingsPage account={account} active={settingsVisible && !pageFading} />
        </div>
        <div className={`content${pageFading ? ' fading' : ''}`} ref={contentRef} hidden={settingsVisible}>
          <TransferBar onConfirm={handleTransferConfirm} onCancel={handleTransferCancel} />
          <UtilityBar
            onMassDelete={() => setDeleteModal({ show: true, name: '', path: '', drive: '', isMass: true })}
            onMassCopyTo={() => beginMassTransfer('copy')}
            onMassMoveTo={() => beginMassTransfer('move')}
          />
          <FileList
            searchResults={searchResults}
            startOperation={startOperation}
            onNavigateFolder={navigateToFolder}
            onPreview={(name, path) => setPreviewModal({ show: true, name, path })}
            onDelete={(name, path, drive) => setDeleteModal({ show: true, name, path, drive, isMass: false })}
            onRename={(name, path, drive) => setRenameModal({ show: true, name, path, drive })}
            onInfo={(name, path, drive) => setInfoModal({ show: true, name, path, drive })}
            onShare={(name, type, path, drive) => setShareModal({ show: true, name, type, path, drive })}
            onRefresh={loadFiles}
            onRefreshStorage={loadStorageInfo}
          />
        </div>
        {!settingsVisible && <FloatingActions
          onCreateFolder={() => setFolderModal(true)}
          onCreateFile={() => setFileModal(true)}
          onUpload={() => fileInputRef.current?.click()}
        />}
        {!settingsVisible && <DropZone onDrop={processAndUploadEntries} />}
        <input
          type="file"
          className="file-input"
          ref={fileInputRef}
          multiple
          onChange={(e) => processAndUploadEntries(e.target.files)}
        />
      </div>

      <DeleteModal
        {...deleteModal}
        selectedItems={state.selectedItems}
        startOperation={startOperation}
        onClose={() => setDeleteModal({ ...deleteModal, show: false })}
      />
      <CreateFolderModal
        show={folderModal}
        startOperation={startOperation}
        onClose={() => setFolderModal(false)}
      />
      <CreateFileModal
        show={fileModal}
        startOperation={startOperation}
        onClose={() => setFileModal(false)}
      />
      <RenameModal
        {...renameModal}
        startOperation={startOperation}
        onClose={() => setRenameModal({ ...renameModal, show: false })}
      />
      <InfoModal
        {...infoModal}
        onClose={() => setInfoModal({ ...infoModal, show: false })}
      />
      <PreviewModal
        {...previewModal}
        onClose={() => setPreviewModal({ ...previewModal, show: false })}
      />
      <ShareModal
        {...shareModal}
        onClose={() => setShareModal({ ...shareModal, show: false })}
      />
      <ConflictModal
        show={conflictModal.show}
        conflicts={conflictModal.conflicts}
        onResolve={handleConflictResolve}
        onCancel={handleConflictCancel}
      />
      <ConflictModal
        show={transferConflict.show}
        conflicts={transferConflict.conflicts}
        onResolve={handleTransferConflictResolve}
        onCancel={handleTransferConflictCancel}
      />
      <GlobalLoader />
    </>
  );
}

export default function DashboardPage({ account }) {
  return (
    <AppProvider>
      <StatsProvider>
        <DashboardContent account={account} />
      </StatsProvider>
    </AppProvider>
  );
}
