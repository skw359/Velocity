// Per-browser display prefs in localStorage; never sent to the server.
// A custom event lets a Settings toggle update the nav bar immediately.
import { useSyncExternalStore } from 'react';

const CHANGE_EVENT = 'velocity-uiprefs-change';
const BANDWIDTH_KEY = 'velocity-show-bandwidth';

function subscribe(callback) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener('storage', callback); // keeps other tabs in sync
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

// Defaults to on, so existing installs keep the widget they already had.
export function bandwidthWidgetEnabled() {
  try { return localStorage.getItem(BANDWIDTH_KEY) !== '0'; } catch { return true; }
}

export function setBandwidthWidgetEnabled(enabled) {
  try { localStorage.setItem(BANDWIDTH_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function useBandwidthWidgetEnabled() {
  return useSyncExternalStore(subscribe, bandwidthWidgetEnabled, () => true);
}
