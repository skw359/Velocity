import { useStats } from '../context/StatsContext';
import { useBandwidthWidgetEnabled } from '../utils/uiPrefs';
import { formatBytes } from '../utils/format';

// Lifetime bytes sent to (Uploads) and pulled from (Downloads) the server.
export default function BandwidthWidget() {
  const { state } = useStats();
  const enabled = useBandwidthWidgetEnabled();

  if (!enabled) return null;

  return (
    <div className="bandwidth-widget">
      <div className="bandwidth-info">
        <span className="bandwidth-label">Uploads &bull;</span>
        <span className="bandwidth-text">{formatBytes(state.bytesUploaded)}</span>
      </div>
      <div className="bandwidth-info">
        <span className="bandwidth-label">Downloads &bull;</span>
        <span className="bandwidth-text">{formatBytes(state.bytesDownloaded)}</span>
      </div>
    </div>
  );
}
