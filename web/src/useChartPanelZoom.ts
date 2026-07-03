import { useCallback, useEffect, useState } from 'react';
import {
  clampChartPanelScale,
  DEFAULT_CHART_PANEL_SCALE,
  zoomInChartPanelScale,
  zoomOutChartPanelScale,
} from './chartPanelZoom';

const LS_KEY = 'pm-chart-panel-zoom-v1';

type ChartZoomMap = Record<string, number>;

function loadMap(): ChartZoomMap {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ChartZoomMap;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveMap(map: ChartZoomMap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Standalone per-chart zoom (Book tab, etc.) — separate from Signals multi-panel state. */
export function useChartPanelZoom(chartId: string) {
  const [scale, setScale] = useState(() => {
    const map = loadMap();
    const v = map[chartId];
    return typeof v === 'number' ? clampChartPanelScale(v) : DEFAULT_CHART_PANEL_SCALE;
  });

  useEffect(() => {
    const map = loadMap();
    map[chartId] = scale;
    saveMap(map);
  }, [chartId, scale]);

  const zoomIn = useCallback(() => setScale((s) => zoomInChartPanelScale(s)), []);
  const zoomOut = useCallback(() => setScale((s) => zoomOutChartPanelScale(s)), []);
  const resetZoom = useCallback(() => setScale(DEFAULT_CHART_PANEL_SCALE), []);

  return { scale, zoomIn, zoomOut, resetZoom };
}
