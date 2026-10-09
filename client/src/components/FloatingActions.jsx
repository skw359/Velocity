import { useState, useRef, useEffect } from 'react';

export default function FloatingActions({ onCreateFolder, onCreateFile, onUpload }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  return (
    <div ref={containerRef}>
      <div className={`add-button${open ? ' active' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14m-7-7h14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className={`add-menu${open ? ' show' : ''}`}>
        <div className="add-menu-item" onClick={() => { setOpen(false); onCreateFolder(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
            <path d="M12 11v6m-3-3h6" />
          </svg>
          Create Folder
        </div>
        <div className="add-menu-item" onClick={() => { setOpen(false); onCreateFile(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <polyline points="14,2 14,8 20,8" />
            <line x1="12" y1="12" x2="12" y2="18" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
          Create File
        </div>
        <div className="add-menu-item" onClick={() => { setOpen(false); onUpload(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7,10 12,5 17,10" />
            <line x1="12" y1="5" x2="12" y2="15" />
          </svg>
          Upload Files/Folders
        </div>
      </div>
    </div>
  );
}
