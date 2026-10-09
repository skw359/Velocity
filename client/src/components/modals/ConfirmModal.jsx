import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

// In-app window.confirm(), portaled to <body> so the caller's UI can't style or clip it.
export default function ConfirmModal({ show, title, message, confirmLabel = 'Yes', cancelLabel = 'No', onConfirm, onCancel }) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (show) { setMounted(true); requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true))); }
    else { setVisible(false); const t = setTimeout(() => setMounted(false), 250); return () => clearTimeout(t); }
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const handler = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [show, onCancel]);

  if (!mounted) return null;

  return createPortal(
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title">
        <div className="modal-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h3 className="modal-title" id="confirm-modal-title">{title}</h3>
        <p className="modal-message">{message}</p>
        <div className="modal-buttons">
          <button className="modal-button modal-button-cancel" disabled={!show} onClick={onCancel}>{cancelLabel}</button>
          <button className="modal-button modal-button-delete" disabled={!show} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
