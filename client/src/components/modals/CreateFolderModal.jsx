import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../../context/AppContext';

export default function CreateFolderModal({ show, startOperation, onClose }) {
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
    const folderName = value.trim();
    if (!folderName) { alert('Please enter a folder name'); return; }
    try {
      await startOperation({
        type: 'create-folder',
        destDrive: state.currentDrive,
        destPath: state.currentPath,
        items: [{ name: folderName, sourceDrive: state.currentDrive, sourcePath: state.currentPath, itemType: 'folder' }],
      });
      onClose();
    } catch (error) {
      // Refused up front (e.g. read-only drive): close so the red banner explaining why shows.
      if (error.handled) { onClose(); return; }
      console.error('Error creating folder:', error);
      alert('Error creating folder');
    }
  };

  return (
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="create-folder-modal">
        <div className="folder-modal-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
          </svg>
        </div>
        <h3 className="modal-title">Create New Folder</h3>
        <input
          ref={inputRef}
          type="text"
          className="folder-input"
          placeholder="Enter folder name..."
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
