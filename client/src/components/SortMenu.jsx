import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';

const sortOptions = [
  { value: 'name-asc', label: 'Name (A-Z)' },
  { value: 'date-desc', label: 'Date (Newest)' },
  { value: 'date-asc', label: 'Date (Oldest)' },
  { value: 'size-desc', label: 'Size (Largest)' },
  { value: 'size-asc', label: 'Size (Smallest)' },
  { value: 'type-asc', label: 'Type' },
];

export default function SortMenu() {
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

  const currentLabel = sortOptions.find(o => o.value === state.currentSort)?.label || 'Name (A-Z)';

  return (
    <div className="sort-container" ref={containerRef}>
      <button className={`sort-button${open ? ' active' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h18M3 10h12M3 16h6"/></svg>
        <span>{currentLabel}</span>
        <svg viewBox="0 0 24 24" className="chevron" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </button>
      <div className={`sort-menu${open ? ' show' : ''}`}>
        {sortOptions.map(opt => (
          <div
            key={opt.value}
            className="sort-menu-item"
            onClick={() => {
              dispatch({ type: 'SET_SORT', payload: opt.value });
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
