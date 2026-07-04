import { createContext, useContext } from 'react';

/** Per-tile +/− zoom from Signals chart chrome (1 = 100%). */
export const ChartPanelScaleContext = createContext(1);

export function useChartPanelScale(): number {
  return useContext(ChartPanelScaleContext);
}
