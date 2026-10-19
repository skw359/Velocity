import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';

export default function UtilityBar({ onMassDelete, onMassDownload, onMassCopyTo, onMassMoveTo }) {
  const { state } = useAppContext();
  const count = state.selectedItems.size;
  // Hide the selection bar while choosing a copy/move destination so the two bars never stack.
  const show = count > 0 && !state.transferOp;

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
            <div className="add-menu-item actions-menu-item" onClick={() => { setMenuOpen(false); onMassDownload(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 5 17 10"></polyline>
                <line x1="12" y1="5" x2="12" y2="15"></line>
              </svg>
              Download
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
