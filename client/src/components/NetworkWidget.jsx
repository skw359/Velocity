import { useStats } from '../context/StatsContext';
import { formatSpeed, formatBytes } from '../utils/format';

export default function NetworkWidget() {
  const { state } = useStats();

  return (
    <div className="network-widget">
<div className="network-info">
        <span className="network-label">CPU &bull;</span>
        <span className="network-text">{state.cpuUtilization}%</span>
      </div>
    </div>
  );
}
