/** Per-chart tile zoom — independent of browser (Chrome) zoom and global viewport zoom. */

export const CHART_PANEL_ZOOM_MIN = 0.75;
export const CHART_PANEL_ZOOM_MAX = 2.5;
export const CHART_PANEL_ZOOM_STEP = 0.1;
export const DEFAULT_CHART_PANEL_SCALE = 1;

function roundScale(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampChartPanelScale(n: number): number {
  return Math.min(CHART_PANEL_ZOOM_MAX, Math.max(CHART_PANEL_ZOOM_MIN, roundScale(n)));
}

export function zoomInChartPanelScale(current: number): number {
  return clampChartPanelScale(current + CHART_PANEL_ZOOM_STEP);
}

export function zoomOutChartPanelScale(current: number): number {
  return clampChartPanelScale(current - CHART_PANEL_ZOOM_STEP);
}

export function formatChartPanelScalePct(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
