import { createContext, useContext, useReducer } from 'react';

// Kept separate from AppContext so frequent stat polls re-render only the
// widgets, not the file list.

const StatsContext = createContext(null);

const initialState = {
  storageUsed: 0,
  storageTotal: 0,
  networkSendSpeed: 0,
  networkReceiveSpeed: 0,
  totalSent: 0,
  totalReceived: 0,
  cpuUtilization: 0,
  // Lifetime bandwidth totals (bytes), persisted server-side across restarts.
  bytesUploaded: 0,
  bytesDownloaded: 0,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_STORAGE':
      return { ...state, storageUsed: action.payload.used, storageTotal: action.payload.total };
    case 'SET_NETWORK_STATS':
      return {
        ...state,
        networkSendSpeed: action.payload.sendSpeed,
        networkReceiveSpeed: action.payload.receiveSpeed,
        totalSent: action.payload.totalSent,
        totalReceived: action.payload.totalReceived,
      };
    case 'SET_CPU':
      return { ...state, cpuUtilization: action.payload };
    case 'SET_BANDWIDTH':
      return { ...state, bytesUploaded: action.payload.uploaded, bytesDownloaded: action.payload.downloaded };
    default:
      return state;
  }
}

export function StatsProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StatsContext.Provider value={{ state, dispatch }}>
      {children}
    </StatsContext.Provider>
  );
}

export function useStats() {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error('useStats must be used within StatsProvider');
  return ctx;
}
