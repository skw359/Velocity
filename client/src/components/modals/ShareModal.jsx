import { useState, useEffect, useRef } from 'react';
import { apiGetShare, apiCreateShare, apiSetShareAccess, apiRevokeShare } from '../../api/fetch';

// The Clipboard API needs a secure context; on plain-http LANs fall back to execCommand.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function ShareModal({ show, name, type, path, drive, onClose }) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  useEffect(() => {
    if (show) { setMounted(true); requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true))); }
    else { setVisible(false); const t = setTimeout(() => setMounted(false), 250); return () => clearTimeout(t); }
  }, [show]);

  // On open, look up whether this item already has a share link.
  useEffect(() => {
    if (!show || !name) return;
    setShare(null);
    setCopied(false);
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const { share } = await apiGetShare(name, path, drive);
        if (!cancelled) setShare(share);
      } catch (e) {
        if (!cancelled) console.error('Share lookup failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [show, name, path, drive]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  if (!mounted) return null;

  const fullUrl = share ? `${window.location.origin}${share.url}` : '';
  const isPublic = share?.access === 'public';
  const noun = type === 'folder' ? 'folder' : 'file';

  const handleCreate = async () => {
    setBusy(true);
    try {
      const { share } = await apiCreateShare(name, path, drive);
      setShare(share);
    } catch (e) {
      alert(e.message || 'Could not create share link.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    const ok = await copyText(fullUrl);
    if (ok) {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } else {
      alert('Could not copy automatically. Select the link and copy it manually.');
    }
  };

  const handleToggleAccess = async (e) => {
    const access = e.target.checked ? 'public' : 'restricted';
    const prev = share;
    setShare({ ...share, access }); // optimistic
    try {
      const { share: updated } = await apiSetShareAccess(share.token, access);
      setShare(updated);
    } catch (err) {
      setShare(prev);
      alert(err.message || 'Could not update link access.');
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await apiRevokeShare(share.token);
      setShare(null);
      setCopied(false);
    } catch (e) {
      alert(e.message || 'Could not remove share link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`modal-overlay${visible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="share-modal">
        <div className="file-modal-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
        </div>
        <h3 className="modal-title">Share</h3>
        <p className="share-subtitle">{name}</p>

        {loading ? (
          <p className="share-status">Loading…</p>
        ) : !share ? (
          <>
            <p className="share-status">
              Create a link to share this {noun}. You control who can open it.
            </p>
            <div className="modal-buttons">
              <button className="modal-button modal-button-cancel" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="modal-button modal-button-delete" disabled={busy} onClick={handleCreate}>
                {busy ? 'Creating…' : 'Create share link'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="share-link-row">
              <input
                className="share-link-input"
                type="text"
                readOnly
                value={fullUrl}
                onFocus={(e) => e.target.select()}
              />
              <button className="share-copy-btn" onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div className="share-access-row">
              <div className="share-access-info">
                <span className="share-access-label">Anyone with the link can view</span>
                <span className="share-access-desc">
                  {isPublic
                    ? `Anyone with this link can open and view this ${noun}, no account needed.`
                    : `Only signed-in users can open this link. Turn on to let anyone view this ${noun}.`}
                </span>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" checked={isPublic} onChange={handleToggleAccess} />
                <span className="toggle-slider"></span>
              </label>
            </div>

            <div className="share-footer">
              <button className="share-revoke-btn" disabled={busy} onClick={handleRevoke}>
                {busy ? 'Removing…' : 'Remove link'}
              </button>
              <button className="modal-button modal-button-delete" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
