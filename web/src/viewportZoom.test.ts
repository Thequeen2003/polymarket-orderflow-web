import { describe, expect, it } from 'vitest';
import {
  computeAutoFitScale,
  resolveEffectiveViewportScale,
  resolveViewportScale,
  zoomInManualScale,
  zoomOutManualScale,
  VIEWPORT_COMFORT_MAX,
  VIEWPORT_ZOOM_MAX,
  VIEWPORT_ZOOM_MIN,
} from './viewportZoom';

describe('viewportZoom', () => {
  it('auto-fit boosts slightly on narrow multi-window viewports', () => {
    const scale = computeAutoFitScale({ width: 640, height: 800 });
    expect(scale).toBeGreaterThan(VIEWPORT_ZOOM_MIN);
    expect(scale).toBeLessThanOrEqual(VIEWPORT_COMFORT_MAX);
  });

  it('auto-fit caps scale on large viewports', () => {
    const scale = computeAutoFitScale({ width: 2560, height: 1440 });
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThanOrEqual(VIEWPORT_COMFORT_MAX);
  });

  it('manual mode uses stored scale', () => {
    expect(resolveViewportScale({ mode: 'manual', manualScale: 1.3 }, { width: 800, height: 600 })).toBe(1.3);
  });

  it('auto-fit never shrinks below normal size', () => {
    const scale = computeAutoFitScale({ width: 800, height: 600 });
    expect(scale).toBeGreaterThanOrEqual(VIEWPORT_ZOOM_MIN);
  });

  it('auto mode ignores manual scale', () => {
    const scale = resolveViewportScale({ mode: 'auto', manualScale: 1.5 }, { width: 1280 + 32, height: 900 + 32 });
    expect(scale).toBeCloseTo(1, 2);
  });

  it('zoom out stops at normal size floor', () => {
    expect(zoomOutManualScale(VIEWPORT_ZOOM_MIN)).toBe(VIEWPORT_ZOOM_MIN);
    expect(VIEWPORT_ZOOM_MIN).toBe(1);
  });

  it('zoom in still clamps at upper bound', () => {
    expect(zoomInManualScale(VIEWPORT_ZOOM_MAX)).toBe(VIEWPORT_ZOOM_MAX);
  });

  it('compensates browser zoom-out without exceeding comfort cap in auto mode', () => {
    const scale = resolveEffectiveViewportScale({ mode: 'auto', manualScale: 1 }, { width: 900, height: 700 }, 1.33);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThanOrEqual(VIEWPORT_COMFORT_MAX);
  });
});
