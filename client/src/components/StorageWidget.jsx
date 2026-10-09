import { useStats } from '../context/StatsContext';
import { formatBytes } from '../utils/format';

export default function StorageWidget() {
  const { state } = useStats();
  const percentage = state.storageTotal > 0 ? (state.storageUsed / state.storageTotal) * 100 : 0;

  return (
    <div className="storage-widget">
      <div className="storage-info">
        <span className="storage-label">Storage</span>
        <span className="storage-text">
          {state.storageTotal > 0
            ? `${formatBytes(state.storageUsed)} / ${formatBytes(state.storageTotal)}`
            : 'Loading...'}
        </span>
      </div>
      <div className="storage-bar-container">
        <div className="storage-bar" style={{ width: `${percentage.toFixed(2)}%` }}></div>
      </div>
    </div>
  );
}
