import { useEffect } from 'react';
import { apiGetNetworkStats, apiGetCpuUtilization, apiGetDrives, apiGetStorage, apiGetBandwidth } from '../api/fetch';
import { useAppContext } from '../context/AppContext';
import { useStats } from '../context/StatsContext';
import { bandwidthWidgetEnabled } from '../utils/uiPrefs';

export function usePolling() {
  // Stats go to StatsContext so frequent ticks don't re-render the file list.
  const { dispatch: appDispatch } = useAppContext();
  const { dispatch: statsDispatch } = useStats();

  useEffect(() => {
    const networkInterval = setInterval(async () => {
      try {
        const stats = await apiGetNetworkStats();
        statsDispatch({ type: 'SET_NETWORK_STATS', payload: stats });
      } catch {}
    }, 1500);

    const cpuInterval = setInterval(async () => {
      try {
        const data = await apiGetCpuUtilization();
        statsDispatch({ type: 'SET_CPU', payload: Math.round(data.utilization) });
      } catch {}
    }, 500);

    const driveInterval = setInterval(async () => {
      try {
        const drives = await apiGetDrives();
        appDispatch({ type: 'SET_DRIVES', payload: drives });
      } catch {}
    }, 10000);

    // Skipped while the widget is hidden; checked each tick so re-enabling resumes polling.
    const pollBandwidth = async () => {
      if (!bandwidthWidgetEnabled()) return;
      try {
        const data = await apiGetBandwidth();
        statsDispatch({ type: 'SET_BANDWIDTH', payload: data });
      } catch {}
    };
    pollBandwidth();
    const bandwidthInterval = setInterval(pollBandwidth, 2000);

    return () => {
      clearInterval(networkInterval);
      clearInterval(cpuInterval);
      clearInterval(driveInterval);
      clearInterval(bandwidthInterval);
    };
  }, [appDispatch, statsDispatch]);
}

export function useLoadStorage() {
  const { state } = useAppContext();
  const { dispatch: statsDispatch } = useStats();

  const loadStorageInfo = async (drive) => {
    try {
      const data = await apiGetStorage(drive || state.currentDrive);
      statsDispatch({ type: 'SET_STORAGE', payload: data });
    } catch {}
  };

  return { loadStorageInfo };
}
