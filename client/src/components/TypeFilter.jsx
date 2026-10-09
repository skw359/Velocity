import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';

const typeOptions = [
  { value: 'all', label: 'All types' },
  { value: 'folder', label: 'Folders' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'archive', label: 'Archives' },
  { value: 'file', label: 'Other files' },
];

export default function TypeFilter() {
  const { state, dispatch } = useAppContext();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const currentLabel = typeOptions.find(o => o.value === state.typeFilter)?.label || 'All types';

  return (
    <div className="sort-container" ref={containerRef}>
      <button className={`sort-button${open ? ' active' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
        <span>{currentLabel}</span>
        <svg viewBox="0 0 24 24" className="chevron" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div className={`sort-menu${open ? ' show' : ''}`}>
        {typeOptions.map(opt => (
          <div
            key={opt.value}
            className={`sort-menu-item${state.typeFilter === opt.value ? ' selected' : ''}`}
            onClick={() => {
              dispatch({ type: 'SET_TYPE_FILTER', payload: opt.value });
              setOpen(false);
            }}
          >
            {opt.label}
          </div>
        ))}
      </div>
    </div>
  );
}
