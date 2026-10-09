import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../../context/AppContext';
import MediaPlayer from '../MediaPlayer';
import CodeEditor from '../CodeEditor';
import { fetchWithAuthCheck, apiGetRawPreview, apiGetVideoPreview, apiSaveFile } from '../../api/fetch';
import { getFileExtension, getContentBaseUrl, languageMap, imageExtensions, heicExtensions, videoExtensions, movExtensions, pdfExtensions, rawImageExtensions, audioExtensions } from '../../utils/format';
import Prism from 'prismjs';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-swift';
import 'prismjs/themes/prism-tomorrow.css';

export default function PreviewModal({ show, name, path, onClose }) {
  const { state, dispatch } = useAppContext();
  const [content, setContent] = useState(null);
  const [contentType, setContentType] = useState('loading');
  const [galleryItems, setGalleryItems] = useState([]);
  const [galleryIndex, setGalleryIndex] = useState(-1);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | unsaved | saving | saved | error
  const [manualSaving, setManualSaving] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const objectUrlRef = useRef(null);
  const previewAreaRef = useRef(null);
  const lastSavedRef = useRef('');
  const savingBarRef = useRef(null);
  const savingRef = useRef(false);

  const driveId = state.currentDrive;

  useEffect(() => {
    if (!show) return;
    const items = [];
    const allFileItems = document.querySelectorAll('.file-item');
    allFileItems.forEach(el => {
      const itemName = el.dataset.name;
      const itemType = el.dataset.type;
      const itemPath = el.dataset.path;
      if (!itemName || itemType !== 'file') return;
      const ext = getFileExtension(itemName);
      if (imageExtensions.includes(ext) || heicExtensions.includes(ext) || rawImageExtensions.includes(ext) || videoExtensions.includes(ext) || movExtensions.includes(ext)) {
        items.push({ name: itemName, path: itemPath });
      }
    });
    setGalleryItems(items);
    const idx = items.findIndex(item => item.name === name && item.path === path);
    setGalleryIndex(idx);
  }, [show, name, path]);

  useEffect(() => {
    if (!show || !name) return;
    loadPreview(name, path);
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [show, name, path]);

  // Arrow-key gallery nav; videos keep the arrows for seeking.
  useEffect(() => {
    if (!show || galleryItems.length <= 1 || contentType === 'video') return;
    const handler = (e) => {
      if (e.key === 'ArrowRight') showNext();
      else if (e.key === 'ArrowLeft') showPrev();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [show, galleryItems, galleryIndex, contentType]);

  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (show) { setMounted(true); requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true))); }
    else { setVisible(false); const t = setTimeout(() => setMounted(false), 250); return () => clearTimeout(t); }
  }, [show]);


  const persist = useCallback(async (text) => {
    const res = await apiSaveFile(name, path, driveId, text);
    if (!res.ok) throw new Error('save failed');
    lastSavedRef.current = text;
  }, [name, path, driveId]);

  // Mirrors .top-loader: jump to 70%, creep toward 85%, then snap to 100% and fade.
  const startSavingBar = useCallback(() => {
    const tl = savingBarRef.current;
    if (!tl) return;
    tl.style.transition = 'none';
    tl.style.transform = 'scaleX(0)';
    tl.style.opacity = '1';
    void tl.offsetWidth; // force reflow so the reset is committed before animating
    tl.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    tl.style.transform = 'scaleX(0.70)';
    setTimeout(() => {
      const currentScale = parseFloat(tl.style.transform.replace(/scaleX\(|\)/, ''));
      if (currentScale < 0.95) {
        tl.style.transition = 'transform 15s linear';
        tl.style.transform = 'scaleX(0.85)';
      }
    }, 500);
  }, []);

  const finishSavingBar = useCallback(() => {
    const tl = savingBarRef.current;
    if (!tl) return;
    tl.style.transition = 'transform 0.1s ease-in';
    tl.style.transform = 'scaleX(1)';
    setTimeout(() => {
      tl.style.transition = 'opacity 0.4s ease-out';
      tl.style.opacity = '0';
    }, 100);
    setTimeout(() => {
      tl.style.transition = 'none';
      tl.style.transform = 'scaleX(0)';
    }, 500);
  }, []);

  const doSave = useCallback(async (text) => {
    if (text === lastSavedRef.current || savingRef.current) return;
    savingRef.current = true;
    setManualSaving(true);
    setSaveStatus('saving');
    startSavingBar();
    try {
      await persist(text);
      setContent(prev => (prev ? { ...prev, text } : prev));
      setSaveStatus('saved');
    } catch {
      setSaveStatus('error');
    } finally {
      savingRef.current = false;
      setManualSaving(false);
      finishSavingBar();
    }
  }, [persist, startSavingBar, finishSavingBar]);

  const handleStartEdit = useCallback(() => {
    const text = content?.text ?? '';
    setEditText(text);
    lastSavedRef.current = text;
    setSaveStatus('idle');
    setEditing(true);
  }, [content]);

  const forceClose = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setContent(null);
    setContentType('loading');
    setGalleryItems([]);
    setGalleryIndex(-1);
    setEditing(false);
    setEditText('');
    setSaveStatus('idle');
    setManualSaving(false);
    setShowUnsavedConfirm(false);
    setConfirmVisible(false);
    onClose();
  }, [onClose]);

  const handleClose = useCallback(() => {
    // Changes are only saved via the Save button; warn before discarding.
    if (editing && editText !== lastSavedRef.current) {
      setShowUnsavedConfirm(true);
      return;
    }
    forceClose();
  }, [editing, editText, forceClose]);

  const cancelClose = useCallback(() => {
    setConfirmVisible(false);
    setTimeout(() => setShowUnsavedConfirm(false), 250);
  }, []);

  useEffect(() => {
    if (showUnsavedConfirm) {
      requestAnimationFrame(() => requestAnimationFrame(() => setConfirmVisible(true)));
    }
  }, [showUnsavedConfirm]);

  useEffect(() => {
    if (!show) return;
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (showUnsavedConfirm) cancelClose();
      else handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [show, handleClose, showUnsavedConfirm, cancelClose]);

  const showNext = useCallback(() => {
    if (galleryItems.length <= 1) return;
    const nextIdx = (galleryIndex + 1) % galleryItems.length;
    const next = galleryItems[nextIdx];
    setGalleryIndex(nextIdx);
    loadPreview(next.name, next.path);
  }, [galleryItems, galleryIndex]);

  const showPrev = useCallback(() => {
    if (galleryItems.length <= 1) return;
    const prevIdx = (galleryIndex - 1 + galleryItems.length) % galleryItems.length;
    const prev = galleryItems[prevIdx];
    setGalleryIndex(prevIdx);
    loadPreview(prev.name, prev.path);
  }, [galleryItems, galleryIndex]);

  const loadPreview = async (previewName, previewPath) => {
    setContentType('loading');
    setContent(null);
    setEditing(false);
    setEditText('');
    setSaveStatus('idle');
    setManualSaving(false);
    savingRef.current = false;
    lastSavedRef.current = '';

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    const ext = getFileExtension(previewName);
    const originalFilePath = `${previewPath === '/' ? '' : previewPath}/${previewName}`;
    const baseUrl = getContentBaseUrl(driveId);
    const webFilePath = `${baseUrl}${originalFilePath}`;

    try {
      if (languageMap[ext]) {
        const res = await fetchWithAuthCheck(webFilePath);
        if (!res.ok) throw new Error('Failed to fetch text file');
        const textContent = await res.text();
        const language = languageMap[ext];
        const usable = Prism.languages[language] ? language : 'plaintext';
        setContent({ text: textContent, language: usable });
        setContentType('text');
      } else if (imageExtensions.includes(ext)) {
        setContent({ src: webFilePath });
        setContentType('image');
      } else if (audioExtensions.includes(ext)) {
        setContent({ src: webFilePath });
        setContentType('audio');
      } else if (heicExtensions.includes(ext)) {
        try {
          const heic2any = (await import('heic2any')).default;
          const res = await fetchWithAuthCheck(webFilePath);
          if (!res.ok) throw new Error('Failed to fetch HEIC file');
          const blob = await res.blob();
          const conversionResult = await heic2any({ blob, toType: 'image/jpeg', quality: 0.9 });
          objectUrlRef.current = URL.createObjectURL(conversionResult);
          setContent({ src: objectUrlRef.current });
          setContentType('image');
        } catch {
          setContentType('unsupported');
          setContent({ message: 'HEIC preview library not loaded.' });
        }
      } else if (videoExtensions.includes(ext)) {
        setContent({ src: webFilePath });
        setContentType('video');
      } else if (movExtensions.includes(ext)) {
        try {
          const data = await apiGetVideoPreview(originalFilePath, driveId);
          setContent({ src: data.previewUrl });
          setContentType('video');
        } catch (e) {
          setContentType('unsupported');
          setContent({ message: e.message || 'Preview not yet available.' });
        }
      } else if (rawImageExtensions.includes(ext)) {
        try {
          const data = await apiGetRawPreview(originalFilePath, driveId);
          setContent({ src: data.previewUrl });
          setContentType('image');
        } catch (e) {
          setContentType('unsupported');
          setContent({ message: e.message || 'Could not fetch RAW image preview.' });
        }
      } else if (pdfExtensions.includes(ext)) {
        setContent({ src: webFilePath });
        setContentType('pdf');
      } else {
        setContentType('unsupported');
        setContent({ message: 'Preview not available for this file type.' });
      }
    } catch (error) {
      setContentType('error');
      setContent({ message: 'Error: Could not load file preview.' });
    }
  };

  if (!mounted) return null;

  const currentName = galleryIndex >= 0 && galleryItems[galleryIndex] ? galleryItems[galleryIndex].name : name;
  const currentPath = galleryIndex >= 0 && galleryItems[galleryIndex] ? galleryItems[galleryIndex].path : path;
  const isGalleryActive = galleryItems.length > 1 && (contentType === 'image' || contentType === 'video');

  const handleDownload = () => {
    window.location.href = `/api/download?name=${encodeURIComponent(currentName)}&path=${encodeURIComponent(currentPath)}&drive=${encodeURIComponent(driveId)}`;
  };

  return (
   <>
    <div className={`modal-overlay${visible ? ' show' : ''}${isGalleryActive ? ' gallery-active' : ''}`} onClick={(e) => e.target === e.currentTarget && handleClose()}>
      <div className="preview-nav-arrow" id="preview-prev" onClick={showPrev}>&#10094;</div>
      <div className="preview-nav-arrow" id="preview-next" onClick={showNext}>&#10095;</div>
      <div className="modal preview-modal-content">
        <div className="preview-saving-bar" ref={savingBarRef} />
        {contentType !== 'audio' && (
          <h3 className="modal-title">
            {currentName}
            {editing && (
              <span className={`edit-status edit-status-${saveStatus}`}>
                {saveStatus === 'saving' && 'Saving…'}
                {saveStatus === 'saved' && 'All changes saved'}
                {saveStatus === 'unsaved' && 'Unsaved changes…'}
                {saveStatus === 'error' && 'Save failed'}
              </span>
            )}
          </h3>
        )}
        <div className={`preview-area${contentType === 'image' || contentType === 'video' || contentType === 'audio' ? ' image-mode' : ''}`} ref={previewAreaRef}>
          {contentType === 'loading' && <div className="loader"></div>}
          {contentType === 'text' && content && !editing && (
            content.language === 'plaintext'
              ? <pre className="plaintext"><code>{content.text}</code></pre>
              : <pre className={`language-${content.language}`}><code dangerouslySetInnerHTML={{ __html: Prism.highlight(content.text, Prism.languages[content.language], content.language) }}></code></pre>
          )}
          {contentType === 'text' && content && editing && (
            <CodeEditor value={editText} onChange={setEditText} language={content.language} />
          )}
          {contentType === 'image' && content && (
            <img
              src={content.src}
              alt={currentName}
              onError={() => { setContentType('error'); setContent({ message: 'Error loading image.' }); }}
            />
          )}
          {contentType === 'video' && content && (
            <MediaPlayer
              key={content.src}
              type="video"
              src={content.src}
              title={currentName}
              onError={() => { setContentType('error'); setContent({ message: 'Error loading video.' }); }}
            />
          )}
          {contentType === 'audio' && content && (
            <MediaPlayer
              key={content.src}
              type="audio"
              src={content.src}
              title={currentName}
              onError={(e) => {
                setContentType('error');
                // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED: no codec for this format.
                const code = e?.target?.error?.code;
                const ext = getFileExtension(currentName).toUpperCase();
                const unsupported = code === 3 || code === 4;
                setContent({ message: unsupported
                  ? `Your browser can't play this ${ext} file. The format isn't supported by its built-in audio codecs. Download it to play in a desktop app.`
                  : 'Error loading audio file.' });
              }}
            />
          )}
          {contentType === 'pdf' && content && (
            <iframe src={content.src} title="PDF Preview" />
          )}
          {(contentType === 'unsupported' || contentType === 'error') && content && (
            <p style={{ textAlign: 'center' }}>{content.message}</p>
          )}
          {contentType === 'text' && editing && (
            <div className={`preview-save-overlay${manualSaving ? ' show' : ''}`}>
              <div className="loader"></div>
            </div>
          )}
        </div>
        <div className="modal-buttons">
          <button className="modal-button modal-button-cancel" onClick={handleClose}>Close</button>
          {contentType === 'text' && !editing && (
            <button className="modal-button modal-button-cancel" onClick={handleStartEdit}>Edit</button>
          )}
          {contentType === 'text' && editing && (
            <button
              className="modal-button modal-button-delete"
              onClick={() => doSave(editText)}
              disabled={saveStatus === 'saving' || editText === lastSavedRef.current}
            >
              {saveStatus === 'saving' ? <span className="loader button-loader"></span> : 'Save'}
            </button>
          )}
          <button className="modal-button modal-button-delete" onClick={handleDownload}>Download</button>
        </div>
      </div>
    </div>

    {showUnsavedConfirm && (
      <div className={`modal-overlay${confirmVisible ? ' show' : ''}`} onClick={(e) => e.target === e.currentTarget && cancelClose()}>
        <div className="modal">
          <div className="modal-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h3 className="modal-title">Unsaved Changes</h3>
          <p className="modal-message">
            You have unsaved changes to <span className="modal-filename">{currentName}</span>.<br /><br />
            If you close now, your changes will be lost.
          </p>
          <div className="modal-buttons">
            <button className="modal-button modal-button-cancel" onClick={cancelClose}>Back</button>
            <button className="modal-button modal-button-delete" onClick={forceClose}>Discard</button>
          </div>
        </div>
      </div>
    )}
   </>
  );
}
