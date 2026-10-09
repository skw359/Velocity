import { useState, useEffect } from 'react';

// Upload name conflicts, one at a time; "Do this for all" applies the next choice to the rest.
export default function ConflictModal({ show, conflicts, onResolve, onCancel }) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState({});
  const [applyAll, setApplyAll] = useState(false);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (show) {
      setIndex(0);
      setDecisions({});
      setApplyAll(false);
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 250);
      return () => clearTimeout(t);
    }
  }, [show]);

  if (!mounted) return null;

  const total = conflicts?.length || 0;
  const current = conflicts?.[index];
  if (!current) return null;

  const remaining = total - index; // current conflict + everything after it
  const isFolder = current.type === 'folder';

  const choose = (action) => {
    const next = { ...decisions };
    if (applyAll) {
      for (let i = index; i < total; i++) next[conflicts[i].name] = action;
      onResolve(next);
      return;
    }
    next[current.name] = action;
    if (index + 1 >= total) {
      onResolve(next);
    } else {
      setDecisions(next);
      setIndex(index + 1);
    }
  };

  return (
    <div
      className={`modal-overlay${visible ? ' show' : ''}`}
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="modal conflict-modal">
        <div className="modal-icon conflict-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        <h3 className="modal-title">{isFolder ? 'Folder already exists' : 'File already exists'}</h3>
        <p className="modal-message">
          A {isFolder ? 'folder' : 'file'} named{' '}
          <span className="modal-filename">{current.name}</span> already exists in this location.
          <br />What would you like to do?
        </p>

        {total > 1 && <div className="conflict-progress">Conflict {index + 1} of {total}</div>}

        <div className="conflict-actions">
          <button className="modal-button modal-button-cancel conflict-action" onClick={() => choose('rename')}>
            Keep both
          </button>
          <button className="modal-button modal-button-cancel conflict-action" onClick={() => choose('skip')}>
            Skip
          </button>
          <button className="modal-button modal-button-delete conflict-action" onClick={() => choose('replace')}>
            Replace
          </button>
        </div>

        {remaining > 1 && (
          <label className="conflict-checkbox">
            <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
            <span>Do this for all {remaining} conflicts</span>
          </label>
        )}

        <div className="conflict-cancel-row">
          <button className="modal-button modal-button-cancel conflict-cancel" onClick={onCancel}>
            Cancel upload
          </button>
        </div>
      </div>
    </div>
  );
}
