import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { isArchiveItem } from '../utils/format';

export default function UtilityBar({ onMassDelete, onMassShare, onMassDownload, onMassInfo, onMassExtract, onMassCompress, onMassDuplicate, onMassCopyTo, onMassMoveTo }) {
  const { state } = useAppContext();
  const count = state.selectedItems.size;
  // Hide the selection bar while choosing a copy/move destination so the two bars never stack.
  const show = count > 0 && !state.transferOp;

  // Extract applies to the selected archives. Compress bundles several items (archives included)
  // into one archive, but like the single-item menu isn't offered for a lone archive.
  const selected = Array.from(state.selectedItems, ([name, obj]) => isArchiveItem(name, obj.type));
  const hasArchives = selected.some(Boolean);
  const canCompress = count > 1 || selected.some(isArchive => !isArchive);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [menuOpen]);

  useEffect(() => {
    if (!show) setMenuOpen(false);
  }, [show]);

  return (
    <div className={`utility-bar${show ? ' show' : ''}`}>
      <span id="selection-count">{count} {count === 1 ? 'item' : 'items'} selected</span>
      <div className="utility-actions">
        <div className="utility-menu-container" ref={menuRef}>
          <button
            className="utility-menu-btn"
            aria-label="More actions"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="19" cy="12" r="1"></circle>
              <circle cx="5" cy="12" r="1"></circle>
            </svg>
          </button>
          <div className={`actions-menu utility-menu${menuOpen ? ' show' : ''}`}>
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassShare(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"></circle>
                <circle cx="6" cy="12" r="3"></circle>
                <circle cx="18" cy="19" r="3"></circle>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
              </svg>
              Share
            </div>
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassDownload(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 5 17 10"></polyline>
                <line x1="12" y1="5" x2="12" y2="15"></line>
              </svg>
              Download
            </div>
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassInfo(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              Info
            </div>
            {hasArchives && (
              <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassExtract(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m14-7l-5-5-5 5m5-5v12" />
                </svg>
                Extract
              </div>
            )}
            {canCompress && (
              <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassCompress(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                  <polyline points="7.5 4.21 12 6.81 16.5 4.21"></polyline>
                  <polyline points="12 22.79 12 12 12 22.79"></polyline>
                  <polyline points="12 12 3.26 7.39 12 12"></polyline>
                  <polyline points="20.74 7.39 12 12 20.74 7.39"></polyline>
                </svg>
                Compress
              </div>
            )}
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassDuplicate(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              Create Copy
            </div>
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassCopyTo(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                <line x1="12" y1="11" x2="12" y2="17"></line>
                <polyline points="9 14 12 17 15 14"></polyline>
              </svg>
              Copy to
            </div>
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassMoveTo(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                <line x1="8" y1="14" x2="16" y2="14"></line>
                <polyline points="13 11 16 14 13 17"></polyline>
              </svg>
              Move to
            </div>
          </div>
        </div>
        <button className="utility-delete-btn" onClick={onMassDelete}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Delete Selected
        </button>
      </div>
    </div>
  );
}
