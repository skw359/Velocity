import { useAppContext } from '../context/AppContext';

export default function ViewToggle() {
  const { state, dispatch } = useAppContext();

  return (
    <div className="view-toggle" role="group" aria-label="View mode">
      <button
        className={state.viewMode === 'list' ? 'active' : ''}
        aria-label="List view"
        aria-pressed={state.viewMode === 'list'}
        onClick={() => dispatch({ type: 'SET_VIEW_MODE', payload: 'list' })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>
      <button
        className={state.viewMode === 'grid' ? 'active' : ''}
        aria-label="Grid view"
        aria-pressed={state.viewMode === 'grid'}
        onClick={() => dispatch({ type: 'SET_VIEW_MODE', payload: 'grid' })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
      </button>
    </div>
  );
}
