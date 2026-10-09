import { useAppContext } from '../context/AppContext';

export default function Breadcrumb({ onNavigate, isSearchMode, searchResultCount, searchQuery, settingsPage }) {
  const { state } = useAppContext();

  // Settings keeps this row; it gives the header its height and divider.
  if (settingsPage) {
    return (
      <div className="navigation-content-header">
        <div className="breadcrumb">
          <span className="breadcrumb-item breadcrumb-current">Settings</span>
        </div>
      </div>
    );
  }

  if (isSearchMode) {
    const text = searchResultCount > 0
      ? `Found ${searchResultCount} result${searchResultCount === 1 ? '' : 's'} for "${searchQuery}"`
      : searchQuery
        ? `Searching for "${searchQuery}"...`
        : '';
    return (
      <div className="navigation-content-header">
        <div className="breadcrumb">
          <span className="breadcrumb-item" style={{ cursor: 'default', color: 'rgba(255, 255, 255, 0.8)' }}>{text}</span>
        </div>
      </div>
    );
  }

  const drive = state.availableDrives.find(d => d.id === state.currentDrive);
  const rootName = state.currentDrive === 'internal' ? 'content' : (drive?.label || state.currentDrive);
  const pathParts = state.currentPath.split('/').filter(p => p);

  const items = [{ label: rootName, path: '/' }];
  let builtPath = '';
  pathParts.forEach(part => {
    builtPath += '/' + part;
    items.push({ label: part, path: builtPath });
  });

  return (
    <div className="navigation-content-header">
      <div className="breadcrumb">
        {items.map((item, i) => (
          <span key={item.path}>
            {i > 0 && <span className="breadcrumb-separator">/</span>}
            <span className="breadcrumb-item" onClick={() => onNavigate(item.path)}>
              {item.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
