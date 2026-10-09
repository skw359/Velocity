export default function SearchBar({ searchInputRef, onSearch }) {
  return (
    <div className="search-container">
      <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input
        type="search"
        id="search-input"
        ref={searchInputRef}
        placeholder="Search everything..."
        autoComplete="off"
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSearch(e.target.value.trim());
        }}
        onInput={(e) => {
          if (e.target.value.trim() === '') onSearch('');
        }}
      />
    </div>
  );
}
