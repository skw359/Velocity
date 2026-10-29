import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { apiShareMeta, apiShareList, shareRawUrl, shareDownloadUrl } from '../api/fetch';
import {
  formatBytes, formatDate, getFileExtension,
  imageExtensions, videoExtensions, audioExtensions, pdfExtensions,
} from '../utils/format';
import '../styles/global.css';

const TEXT_EXTS = [
  'txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'html', 'xml', 'svg', 'css',
  'sh', 'yaml', 'yml', 'ini', 'cfg', 'log', 'c', 'cpp', 'h', 'cs', 'py', 'java',
];

function joinSub(base, name) {
  return base ? `${base}/${name}` : name;
}

function FilePreview({ token, subpath, name }) {
  const ext = getFileExtension(name);
  const url = shareRawUrl(token, subpath);
  const [text, setText] = useState(null);
  const [textErr, setTextErr] = useState(false);

  const isText = TEXT_EXTS.includes(ext);

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    setText(null);
    setTextErr(false);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('failed');
        const body = await res.text();
        if (!cancelled) setText(body.length > 500000 ? body.slice(0, 500000) + '\n\n… (truncated)' : body);
      } catch {
        if (!cancelled) setTextErr(true);
      }
    })();
    return () => { cancelled = true; };
  }, [url, isText]);

  if (imageExtensions.includes(ext)) {
    return <img className="share-preview-media" src={url} alt={name} />;
  }
  if (videoExtensions.includes(ext)) {
    return <video className="share-preview-media" src={url} controls autoPlay />;
  }
  if (audioExtensions.includes(ext)) {
    return <audio className="share-preview-audio" src={url} controls autoPlay />;
  }
  if (pdfExtensions.includes(ext)) {
    return <iframe className="share-preview-frame" src={url} title={name} />;
  }
  if (isText) {
    if (textErr) return <p className="share-status">Couldn't load a preview for this file.</p>;
    if (text === null) return <p className="share-status">Loading preview…</p>;
    return <pre className="share-preview-text">{text}</pre>;
  }
  return (
    <div className="share-nopreview">
      <p className="share-status">No preview available for this file type.</p>
      <a className="modal-button modal-button-delete" href={shareDownloadUrl(token, subpath)}>Download</a>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 5 17 10"></polyline>
      <line x1="12" y1="5" x2="12" y2="15"></line>
    </svg>
  );
}

function FolderView({ token, rootName }) {
  const [subpath, setSubpath] = useState('');
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState(null); // { subpath, name }

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(false);
    (async () => {
      try {
        const data = await apiShareList(token, subpath);
        if (!cancelled) setEntries(data);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token, subpath]);

  const segments = subpath ? subpath.split('/') : [];
  const goToSegment = useCallback((i) => {
    setSubpath(i < 0 ? '' : segments.slice(0, i + 1).join('/'));
  }, [segments]);

  const sorted = entries ? [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  }) : [];

  return (
    <div className="share-folder">
      <div className="share-breadcrumb">
        <button className="share-crumb" onClick={() => goToSegment(-1)}>{rootName}</button>
        {segments.map((seg, i) => (
          <span key={i} className="share-crumb-group">
            <span className="share-crumb-sep">/</span>
            <button className="share-crumb" onClick={() => goToSegment(i)}>{seg}</button>
          </span>
        ))}
      </div>

      {error ? (
        <p className="share-status">Couldn't load this folder.</p>
      ) : entries === null ? (
        <p className="share-status">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="share-status">This folder is empty.</p>
      ) : (
        <ul className="share-list">
          {sorted.map((entry) => {
            const entrySub = joinSub(subpath, entry.name);
            return (
              <li key={entry.name} className="share-list-item">
                <button
                  className="share-item-main"
                  onClick={() => entry.type === 'folder'
                    ? setSubpath(entrySub)
                    : setPreview({ subpath: entrySub, name: entry.name })}
                >
                  <span className={`share-item-icon ${entry.type}`}>
                    {entry.type === 'folder' ? <FolderIcon /> : <FileIcon />}
                  </span>
                  <span className="share-item-name">{entry.name}</span>
                </button>
                <span className="share-item-meta">{formatDate(entry.mtime)}</span>
                <span className="share-item-size">
                  {entry.type === 'file' && entry.size !== undefined ? formatBytes(entry.size) : ''}
                </span>
                <a
                  className="share-item-download"
                  href={shareDownloadUrl(token, entrySub)}
                  title={entry.type === 'folder' ? 'Download as .zip' : 'Download'}
                  onClick={(e) => e.stopPropagation()}
                >
                  <DownloadIcon />
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {preview && (
        <div className="modal-overlay show" onClick={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="share-lightbox">
            <div className="share-lightbox-head">
              <span className="share-lightbox-name">{preview.name}</span>
              <div className="share-lightbox-actions">
                <a className="modal-button modal-button-delete" href={shareDownloadUrl(token, preview.subpath)}>Download</a>
                <button className="modal-button modal-button-cancel" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
            <div className="share-lightbox-body">
              <FilePreview token={token} subpath={preview.subpath} name={preview.name} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SharePage() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: null, meta: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ok, status, data } = await apiShareMeta(token);
        if (cancelled) return;
        if (ok) {
          setState({ loading: false, error: null, meta: data });
        } else if (status === 403) {
          setState({ loading: false, error: 'login_required', meta: null });
        } else if (data && data.error === 'gone') {
          setState({ loading: false, error: 'gone', meta: null });
        } else {
          setState({ loading: false, error: 'not_found', meta: null });
        }
      } catch {
        if (!cancelled) setState({ loading: false, error: 'failed', meta: null });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const { loading, error, meta } = state;

  return (
    <div className="share-page">
      <header className="share-page-header">
        <a className="share-brand" href="/">Velocity</a>
      </header>

      <main className="share-page-main">
        {loading ? (
          <div className="share-card"><p className="share-status">Loading…</p></div>
        ) : error === 'login_required' ? (
          <div className="share-card share-message">
            <h2>This link is private</h2>
            <p className="share-status">The owner limited this link to signed-in users. Sign in to view it.</p>
            <a className="modal-button modal-button-delete" href="/">Sign in</a>
          </div>
        ) : error === 'gone' ? (
          <div className="share-card share-message">
            <h2>This item is no longer available</h2>
            <p className="share-status">The shared file or folder may have been moved, renamed, or deleted.</p>
          </div>
        ) : error ? (
          <div className="share-card share-message">
            <h2>Link not found</h2>
            <p className="share-status">This share link is invalid or has been removed.</p>
          </div>
        ) : meta.type !== 'file' ? (
          // A multi-item share ('selection') browses like a folder holding the shared items.
          <div className="share-card share-card-wide">
            <div className="share-head">
              <div className="share-head-info">
                <h2 className="share-head-name">{meta.name}</h2>
                <span className="share-head-sub">{meta.type === 'selection' ? 'Shared items' : 'Shared folder'}</span>
              </div>
              <a className="modal-button modal-button-delete" href={shareDownloadUrl(token)}>Download all (.zip)</a>
            </div>
            <FolderView token={token} rootName={meta.name} />
          </div>
        ) : (
          <div className="share-card share-card-wide">
            <div className="share-head">
              <div className="share-head-info">
                <h2 className="share-head-name">{meta.name}</h2>
                <span className="share-head-sub">Shared file</span>
              </div>
              <a className="modal-button modal-button-delete" href={shareDownloadUrl(token)}>Download</a>
            </div>
            <div className="share-file-preview">
              <FilePreview token={token} subpath="" name={meta.name} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
