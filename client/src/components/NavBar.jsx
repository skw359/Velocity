import { Link } from 'react-router-dom';
import DriveSelector from './DriveSelector';
import SearchBar from './SearchBar';
import SortMenu from './SortMenu';
import TypeFilter from './TypeFilter';
import ViewToggle from './ViewToggle';
import StorageWidget from './StorageWidget';
import NetworkWidget from './NetworkWidget';
import BandwidthWidget from './BandwidthWidget';

export default function NavBar({ searchInputRef, onSearch, onSwitchDrive, settingsPage = false }) {
  return (
    <div className="nav-bar">
      {settingsPage && (
        <Link to="/app" className="sort-button back-to-files" aria-label="Back to files">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m12 19-7-7 7-7M5 12h14" />
          </svg>
          Back to files
        </Link>
      )}
      {/* Retain the uncontrolled search input and file controls between pages. */}
      <div className="nav-left-content" hidden={settingsPage}>
        <DriveSelector onSwitchDrive={onSwitchDrive} />
        <SearchBar searchInputRef={searchInputRef} onSearch={onSearch} />
        <SortMenu />
        <TypeFilter />
        <ViewToggle />
      </div>
      <div className="nav-right-content">
        <BandwidthWidget />
        <StorageWidget />
        <NetworkWidget />
      </div>
    </div>
  );
}
