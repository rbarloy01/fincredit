import { createContext, useContext } from 'react';

// true = active client (alerts and breach marks allowed); false = dormant/closed (monitoring paused).
const MonitoringContext = createContext<boolean>(true);
export const MonitoringProvider = MonitoringContext.Provider;
export const useClientMonitored = () => useContext(MonitoringContext);
