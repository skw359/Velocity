import { useState, useRef, useEffect } from 'react';
import { useModalTransition } from '../../hooks/useModalTransition';

export default function RenameModal({ show, name, path, drive, startOperation, onClose }) {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (show) {
      setValue(name);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [show, name]);


  const { mounted, visible } = useModalTransition(show);

  if (!mounted) return null;

  const handleRename = async () => {
    const newName = value.trim();
    if (!newName) { alert('Please enter a name.'); return; }
    if (newName.includes('/') || newName.includes('\\')) { alert('Name cannot contain slashes.'); return; }
    if (newName === name) { onClose(); return; }

    setLoading(true);

    try {
      await startOperation({
        type: 'rename',
        destDrive: drive,
        destPath: path,
        items: [{ name, sourceDrive: drive, sourcePath: path, targetName: newName }],
      });
      onClose();
    } catch (error) {
      // Refused up front (e.g. read-only drive): close so the red banner explaining why shows.
      if (error.handled) { onClose(); return; }
      console.error('Error starting rename:', error);
      alert('An error occurred starting the rename.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="create-file-modal">
        <div className="file-modal-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </div>
        <h3 className="modal-title">Rename Item</h3>
        <input
          ref={inputRef}
          type="text"
          className="file-input-field"
          placeholder="Enter new name..."
          maxLength={255}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleRename(); } }}
        />
        <div className="modal-buttons">
          <button className="modal-button modal-button-cancel" disabled={loading} onClick={onClose}>Cancel</button>
          <button className="modal-button modal-button-delete" disabled={loading} onClick={handleRename}>Rename</button>
        </div>
      </div>
    </div>
  );
}
