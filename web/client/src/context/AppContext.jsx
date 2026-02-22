import { createContext, useContext } from "react";

/**
 * AppContext provides cross-cutting state used by multiple pages:
 * - theme: UI theme preference
 * - refreshIntervalMs: polling interval for stats
 * - syncStatus: sync role/state for replica detection
 * Reduces prop drilling for these shared values.
 */
const AppContext = createContext(null);

export function AppProvider({ value, children }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  return ctx;
}
