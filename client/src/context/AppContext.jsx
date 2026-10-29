import { createContext, useContext, useReducer, useCallback, useRef } from 'react';

const AppContext = createContext(null);

const initialState = {
  currentPath: '/',
  currentDrive: 'internal',
  availableDrives: [],
  fileData: [],
  selectedItems: new Map(),
  currentSort: 'name-asc',
  viewMode: 'list',   // 'list' | 'grid'
  typeFilter: 'all',  // 'all' | 'folder' | 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'file'
  isSearchMode: false,
  searchResultCount: 0,
  galleryItems: [],
  currentGalleryIndex: -1,
  currentPage: 1,
  lastClickedIndex: -1,

  // Copy/move destination selection, null when inactive:
  // { mode: 'copy' | 'move', items: [{ name, sourcePath, sourceDrive }, ...] }
  transferOp: null,

  // Live server stats live in StatsContext so their frequent polling doesn't re-render the file list.

  globalLoaderVisible: false,

  // Long-running work only this tab knows about (search, its own upload, zip-for-download), keyed by slot:
  //   { [key]: { message, percent?, showCancel, showUploadInfo, tooltipFiles?, startedAt } }
  localOps: {},

  // Backend operation records, so the bar survives reloads and shows other tabs' work.
  activeOperations: [],

  // A refused operation, shown until dismissed or the next one starts: { id, title, detail } | null.
  opError: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_PATH':
      return { ...state, currentPath: action.payload };
    case 'SET_DRIVE':
      return { ...state, currentDrive: action.payload, currentPath: '/' };
    case 'SET_DRIVES':
      return { ...state, availableDrives: action.payload };
    case 'SET_FILE_DATA':
      return { ...state, fileData: action.payload, currentPage: 1 };
    case 'UPDATE_FILE_SIZE': {
      const updated = state.fileData.map(f =>
        f.name === action.payload.name ? { ...f, size: action.payload.size } : f
      );
      return { ...state, fileData: updated };
    }
    case 'SET_SELECTED_ITEMS':
      return { ...state, selectedItems: action.payload };
    case 'SET_SORT':
      return { ...state, currentSort: action.payload };
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.payload };
    case 'SET_TYPE_FILTER':
      return { ...state, typeFilter: action.payload, currentPage: 1 };
    case 'SET_SEARCH_MODE':
      return { ...state, isSearchMode: action.payload };
    case 'SET_SEARCH_RESULT_COUNT':
      return { ...state, searchResultCount: action.payload };
    case 'SET_GALLERY':
      return { ...state, galleryItems: action.payload.items, currentGalleryIndex: action.payload.index };
    case 'SET_GALLERY_INDEX':
      return { ...state, currentGalleryIndex: action.payload };
    case 'CLEAR_GALLERY':
      return { ...state, galleryItems: [], currentGalleryIndex: -1 };
    case 'SET_PAGE':
      return { ...state, currentPage: action.payload };
    case 'SET_LAST_CLICKED_INDEX':
      return { ...state, lastClickedIndex: action.payload };
    case 'START_TRANSFER':
      // Clear any multi-selection so only the destination bar is shown.
      return { ...state, transferOp: action.payload, selectedItems: new Map() };
    case 'CANCEL_TRANSFER':
      return { ...state, transferOp: null };
    case 'SET_GLOBAL_LOADER':
      return { ...state, globalLoaderVisible: action.payload };
    case 'SET_LOCAL_OP': {
      // Replace the fields wholesale but keep the original start time so the bar's ordering is stable.
      const { key, ...fields } = action.payload;
      const prev = state.localOps[key];
      return {
        ...state,
        localOps: { ...state.localOps, [key]: { ...fields, startedAt: prev?.startedAt ?? Date.now() } },
      };
    }
    case 'CLEAR_LOCAL_OP': {
      if (!(action.payload in state.localOps)) return state;
      const localOps = { ...state.localOps };
      delete localOps[action.payload];
      return { ...state, localOps };
    }
    case 'SHOW_OP_ERROR':
      return { ...state, opError: action.payload };
    case 'DISMISS_OP_ERROR':
      return state.opError ? { ...state, opError: null } : state;
    case 'SET_OPERATIONS':
      return { ...state, activeOperations: Array.isArray(action.payload) ? action.payload : [] };
    case 'UPSERT_OPERATION': {
      // Instant feedback right after enqueue, before the next poll arrives.
      const others = state.activeOperations.filter(o => o.id !== action.payload.id);
      return { ...state, activeOperations: [action.payload, ...others] };
    }
    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const pendingTimersRef = useRef(new Map());
  const cancelHandlersRef = useRef(new Map());

  const showGlobalLoader = useCallback(() => {
    dispatch({ type: 'SET_GLOBAL_LOADER', payload: true });
  }, []);

  const hideGlobalLoader = useCallback(() => {
    dispatch({ type: 'SET_GLOBAL_LOADER', payload: false });
  }, []);

  // The full-screen loader is shared by every waiting slot, so only the last one hides it.
  const clearPending = useCallback((key) => {
    const timers = pendingTimersRef.current;
    if (!timers.has(key)) return;
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (timers.size === 0) hideGlobalLoader();
  }, [hideGlobalLoader]);

  // Show the full-screen loader now; promote to a bar entry if still running after 5s.
  const longOpStart = useCallback((key, message = 'Processing...') => {
    clearPending(key);
    dispatch({ type: 'CLEAR_LOCAL_OP', payload: key });
    showGlobalLoader();
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(key);
      if (pendingTimersRef.current.size === 0) hideGlobalLoader();
      dispatch({ type: 'SET_LOCAL_OP', payload: { key, message, showCancel: false, showUploadInfo: false } });
    }, 5000);
    pendingTimersRef.current.set(key, timer);
  }, [clearPending, showGlobalLoader, hideGlobalLoader]);

  const longOpStartImmediate = useCallback((key, message, onCancel) => {
    clearPending(key);
    cancelHandlersRef.current.set(key, onCancel);
    dispatch({
      type: 'SET_LOCAL_OP',
      payload: { key, message, showCancel: true, showUploadInfo: true, percent: 0, tooltipFiles: [] },
    });
  }, [clearPending]);

  const longOpStop = useCallback((key) => {
    clearPending(key);
    cancelHandlersRef.current.delete(key);
    dispatch({ type: 'CLEAR_LOCAL_OP', payload: key });
  }, [clearPending]);

  const longOpCancel = useCallback((key) => {
    const onCancel = cancelHandlersRef.current.get(key);
    if (onCancel) onCancel();
    longOpStop(key);
  }, [longOpStop]);

  // A fresh id per call, so repeating the same refusal still re-renders as new.
  const opErrorSeqRef = useRef(0);
  const showOpError = useCallback((title, detail = '') => {
    opErrorSeqRef.current += 1;
    dispatch({ type: 'SHOW_OP_ERROR', payload: { id: opErrorSeqRef.current, title, detail } });
  }, []);
  const dismissOpError = useCallback(() => dispatch({ type: 'DISMISS_OP_ERROR' }), []);

  return (
    <AppContext.Provider
      value={{
        state,
        dispatch,
        showGlobalLoader,
        hideGlobalLoader,
        longOpStart,
        longOpStartImmediate,
        longOpStop,
        longOpCancel,
        showOpError,
        dismissOpError,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

// Kept beside its provider; editing this file does a full reload instead of a fast refresh.
// eslint-disable-next-line react-refresh/only-export-components
export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
