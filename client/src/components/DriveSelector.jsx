import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { formatBytes } from '../utils/format';

// Font Awesome classes (stylesheet served locally from /vendor/fontawesome).
const DRIVE_ICON_CLASSES = {
  internal: 'fa-solid fa-hard-drive',
  removable: 'fa-brands fa-usb',
  local: 'fa-solid fa-compact-disc',
};

function driveIconClass(type) {
  return DRIVE_ICON_CLASSES[type] || DRIVE_ICON_CLASSES.internal;
}

export default function DriveSelector({ onSwitchDrive }) {
  const { state } = useAppContext();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const currentDriveObj = state.availableDrives.find(d => d.id === state.currentDrive);
  const iconClass = driveIconClass(currentDriveObj?.type);
  const label = currentDriveObj?.label || 'Internal Storage';

  return (
    <div className="drive-selector-container" ref={containerRef}>
      <button
        className={`drive-selector-button${open ? ' active' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <span className="drive-icon"><i className={iconClass} aria-hidden="true"></i></span>
        <span>{label}</span>
        <svg viewBox="0 0 24 24" className="chevron" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      <div className={`drive-menu${open ? ' show' : ''}`}>
        {state.availableDrives.map(drive => {
          const driveIconClassName = driveIconClass(drive.type);
          const meta = drive.size ? `${formatBytes(drive.size - (drive.freeSpace || 0))} / ${formatBytes(drive.size)}` : '';
          return (
            <div
              key={drive.id}
              className={`drive-menu-item${drive.id === state.currentDrive ? ' selected' : ''}`}
              onClick={() => { onSwitchDrive(drive.id); setOpen(false); }}
            >
              <span className="drive-icon"><i className={driveIconClassName} aria-hidden="true"></i></span>
              <div className="drive-info">
                <span className="drive-label">{drive.label}{drive.letter ? ` (${drive.letter})` : ''}</span>
                {meta && <span className="drive-meta">{meta}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
