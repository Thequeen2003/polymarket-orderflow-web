import { describe, expect, it } from 'vitest';
import {
  clampChartPanelScale,
  zoomInChartPanelScale,
  zoomOutChartPanelScale,
  CHART_PANEL_ZOOM_MIN,
  CHART_PANEL_ZOOM_MAX,
} from './chartPanelZoom';

describe('chartPanelZoom', () => {
  it('clamps scale to configured bounds', () => {
    expect(clampChartPanelScale(0.5)).toBe(CHART_PANEL_ZOOM_MIN);
    expect(clampChartPanelScale(3)).toBe(CHART_PANEL_ZOOM_MAX);
    expect(clampChartPanelScale(1.15)).toBe(1.15);
  });

  it('steps zoom in and out', () => {
    expect(zoomInChartPanelScale(1)).toBe(1.1);
    expect(zoomOutChartPanelScale(1)).toBe(0.9);
    expect(zoomOutChartPanelScale(CHART_PANEL_ZOOM_MIN)).toBe(CHART_PANEL_ZOOM_MIN);
    expect(zoomInChartPanelScale(CHART_PANEL_ZOOM_MAX)).toBe(CHART_PANEL_ZOOM_MAX);
  });
});
