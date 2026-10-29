import { useState } from 'react';
import { useModalTransition } from '../../hooks/useModalTransition';

export default function DeleteModal({ show, name, path, drive, isMass, selectedItems, startOperation, onClose }) {
  const [loading, setLoading] = useState(false);

  const { mounted, visible } = useModalTransition(show);

  if (!mounted) return null;

  const handleDelete = async () => {
    const items = isMass
      ? Array.from(selectedItems, ([n, obj]) => ({ name: n, sourcePath: obj.path, sourceDrive: obj.drive }))
      : [{ name, sourcePath: path, sourceDrive: drive }];

    if (items.length === 0) return;
    setLoading(true);

    try {
      // The dashboard refreshes when polling sees the operation finish.
      await startOperation({
        type: 'delete',
        destDrive: items[0].sourceDrive || drive || 'internal',
        destPath: items[0].sourcePath || path || '/',
        items,
      });
      onClose();
    } catch (error) {
      // Refused up front (e.g. read-only drive): close so the red banner explaining why shows.
      if (error.handled) { onClose(); return; }
      console.error('Error starting delete:', error);
      alert('An error occurred starting the delete.');
    } finally {
      setLoading(false);
    }
  };

  const title = isMass ? 'Delete Selected Items' : 'Delete Item';
  const message = isMass
    ? <>Are you sure you want to permanently delete these <span className="modal-filename">{selectedItems.size} items</span>?<br /><br />This action cannot be undone.</>
    : <>Are you sure you want to delete <span className="modal-filename">{name}</span>?<br /><br />This action cannot be undone.</>;

  return (
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </div>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-message">{message}</p>
        <div className="modal-buttons">
          <button className="modal-button modal-button-cancel" disabled={loading} onClick={onClose}>Cancel</button>
          <button className="modal-button modal-button-delete" disabled={loading} onClick={handleDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}
