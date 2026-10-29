import { useState, useEffect } from 'react';
import { apiGetInfo, apiGetSelectionInfo } from '../../api/fetch';
import { formatBytes, formatDateTime } from '../../utils/format';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// `items` ([{ name, path, drive }]) shows combined totals for a multi-selection instead of one item.
export default function InfoModal({ show, name, path, drive, items, onClose }) {
  const [info, setInfo] = useState(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (show) { setMounted(true); requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true))); }
    else { setVisible(false); const t = setTimeout(() => setMounted(false), 250); return () => clearTimeout(t); }
  }, [show]);

  useEffect(() => {
    if (!show || (!name && !items)) return;
    setInfo(null);
    (async () => {
      try {
        const data = items ? await apiGetSelectionInfo(items) : await apiGetInfo(name, path, drive);
        setInfo(data);
      } catch (error) {
        console.error(error);
        setInfo({ error: true });
      }
    })();
  }, [show, name, path, drive, items]);

  if (!mounted) return null;

  return (
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="info-modal-content">
        <div className="info-header">
          <div className="info-icon-large">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </div>
          <div className="info-filename">{items ? `${items.length} items selected` : name}</div>
        </div>

        {items ? (
        <div className="info-grid">
          <div className="info-label">Items</div>
          <div className="info-value">{info ? (info.error ? 'Error' : [info.files && plural(info.files, 'file'), info.folders && plural(info.folders, 'folder')].filter(Boolean).join(', ')) : <span className="loading-text">Loading...</span>}</div>

          <div className="info-label">Total Size</div>
          <div className="info-value">{info ? (info.error ? 'Error' : formatBytes(info.size)) : <span className="loading-text">Calculating...</span>}</div>

          <div className="info-label">Contains</div>
          <div className="info-value">{info ? (info.error ? 'Error' : plural(info.count, 'file')) : <span className="loading-text">Counting...</span>}</div>

          <div className="info-label">Last Modified</div>
          <div className="info-value">{info ? (info.error ? 'Error' : formatDateTime(info.modified)) : <span className="loading-text">Fetching...</span>}</div>
        </div>
        ) : (
        <div className="info-grid">
          <div className="info-label">Type</div>
          <div className="info-value">{info ? (info.error ? 'Error' : info.type === 'folder' ? 'Folder' : 'File') : <span className="loading-text">Loading...</span>}</div>

          <div className="info-label">Total Size</div>
          <div className="info-value">{info ? (info.error ? 'Error' : formatBytes(info.size)) : <span className="loading-text">Calculating...</span>}</div>

          <div className="info-label">Contains</div>
          <div className="info-value">{info ? (info.error ? 'Error' : `${info.count} ${info.type === 'folder' ? 'files/folders' : 'file'}`) : <span className="loading-text">Counting...</span>}</div>

          <div className="info-label">Created</div>
          <div className="info-value">{info ? (info.error ? 'Error' : formatDateTime(info.created)) : <span className="loading-text">Fetching...</span>}</div>

          <div className="info-label">Last Modified</div>
          <div className="info-value">{info ? (info.error ? 'Error' : formatDateTime(info.modified)) : <span className="loading-text">Fetching...</span>}</div>
        </div>
        )}

        <div className="modal-buttons">
          <button className="modal-button modal-button-cancel" style={{ width: '100%' }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
