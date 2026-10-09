import { useAppContext } from '../context/AppContext';

// Takes the UtilityBar's place while picking a copy/move destination.
export default function TransferBar({ onConfirm, onCancel }) {
  const { state } = useAppContext();
  const op = state.transferOp;
  if (!op) return null;

  const count = op.items.length;
  const actionLabel = op.mode === 'copy' ? 'Copying' : 'Moving';
  const confirmLabel = op.mode === 'copy' ? 'Copy here' : 'Move here';
  const targetLabel = count === 1 ? `"${op.items[0].name}"` : `${count} items`;

  return (
    <div className="transfer-bar show">
      <div className="transfer-bar-info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          <line x1="12" y1="11" x2="12" y2="17"></line>
          <polyline points="9 14 12 17 15 14"></polyline>
        </svg>
        <span className="transfer-bar-label">
          {actionLabel} <span className="transfer-bar-filename">{targetLabel}</span>
        </span>
      </div>
      <div className="transfer-bar-actions">
        <button className="transfer-cancel-btn" onClick={onCancel}>Cancel</button>
        <button className="transfer-confirm-btn" onClick={onConfirm}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
