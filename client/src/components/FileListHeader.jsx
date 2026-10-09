import { useAppContext } from '../context/AppContext';

export default function FileListHeader() {
  const { state } = useAppContext();
  if (state.viewMode === 'grid') return null;

  return (
    <div className="file-list-header" aria-hidden="true">
      <span className="header-name">Name</span>
      <div className="header-meta">
        <span className="header-modified">Date Modified</span>
        <span className="header-size">Size</span>
      </div>
      <span className="header-actions-spacer"></span>
    </div>
  );
}
