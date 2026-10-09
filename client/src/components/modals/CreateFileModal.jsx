import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../../context/AppContext';

export default function CreateFileModal({ show, startOperation, onClose }) {
  const { state } = useAppContext();
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (show) {
      setValue('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [show]);

  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (show) { setMounted(true); requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true))); }
    else { setVisible(false); const t = setTimeout(() => setMounted(false), 250); return () => clearTimeout(t); }
  }, [show]);

  if (!mounted) return null;

  const handleCreate = async () => {
    const fileName = value.trim();
    if (!fileName) { alert('Please enter a file name'); return; }
    try {
      await startOperation({
        type: 'create-file',
        destDrive: state.currentDrive,
        destPath: state.currentPath,
        items: [{ name: fileName, sourceDrive: state.currentDrive, sourcePath: state.currentPath, itemType: 'file' }],
      });
      onClose();
    } catch (error) {
      // Refused up front (e.g. read-only drive): close so the red banner explaining why shows.
      if (error.handled) { onClose(); return; }
      console.error('Error creating file:', error);
      alert('Error creating file');
    }
  };

  return (
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="create-file-modal">
        <div className="file-modal-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14,2 14,8 20,8" />
          </svg>
        </div>
        <h3 className="modal-title">Create New File</h3>
        <input
          ref={inputRef}
          type="text"
          className="file-input-field"
          placeholder="Enter file name (e.g., document.txt)..."
          maxLength={50}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
        />
        <div className="modal-buttons">
          <button className="modal-button modal-button-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-button modal-button-delete" onClick={handleCreate}>Create</button>
        </div>
      </div>
    </div>
  );
}
