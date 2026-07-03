/** In-app viewport scale — independent of browser (Chrome) zoom. */

export type ViewportZoomMode = 'auto' | 'manual';

export type ViewportZoomState = {
  mode: ViewportZoomMode;
  /** Applied scale when mode is `manual`. */
  manualScale: number;
  /** Bottom-left floating zoom dock — inline header controls stay available when false. */
  floatingVisible: boolean;
};

export const VIEWPORT_ZOOM_LS_KEY = 'pm-viewport-zoom-v1';

/** Design reference used for auto-fit (matches `max-w-7xl` + typical desk height). */
export const VIEWPORT_REF_WIDTH = 1280;
export const VIEWPORT_REF_HEIGHT = 900;

/** Never shrink below normal readable size when using view zoom out. */
export const VIEWPORT_ZOOM_MIN = 1;
export const VIEWPORT_ZOOM_MAX = 2.5;
export const VIEWPORT_ZOOM_STEP = 0.1;
/** Auto-fit ceiling — keeps multi-window panes readable without blowing layout / scroll. */
export const VIEWPORT_COMFORT_MAX = 1.32;

/** Default: auto-fit for multi-window; manual baseline is 100%. */
export const DEFAULT_VIEWPORT_ZOOM: ViewportZoomState = {
  mode: 'auto',
  manualScale: 1,
  floatingVisible: true,
};

function clampScale(n: number): number {
  return Math.min(VIEWPORT_ZOOM_MAX, Math.max(VIEWPORT_ZOOM_MIN, n));
}

function roundScale(n: number): number {
  return Math.round(n * 100) / 100;
}

export function loadViewportZoom(): ViewportZoomState {
  try {
    const raw = localStorage.getItem(VIEWPORT_ZOOM_LS_KEY);
    if (!raw) return DEFAULT_VIEWPORT_ZOOM;
    const parsed = JSON.parse(raw) as Partial<ViewportZoomState>;
    const mode = parsed.mode === 'manual' ? 'manual' : 'auto';
    const manualScale =
      typeof parsed.manualScale === 'number' && Number.isFinite(parsed.manualScale)
        ? clampScale(roundScale(parsed.manualScale))
        : DEFAULT_VIEWPORT_ZOOM.manualScale;
    const state: ViewportZoomState = {
      mode,
      manualScale,
      floatingVisible: parsed.floatingVisible !== false,
    };
    if (mode === 'manual' && manualScale < VIEWPORT_ZOOM_MIN) {
      return DEFAULT_VIEWPORT_ZOOM;
    }
    return state;
  } catch {
    return DEFAULT_VIEWPORT_ZOOM;
  }
}

export function saveViewportZoom(state: ViewportZoomState): void {
  try {
    localStorage.setItem(
      VIEWPORT_ZOOM_LS_KEY,
      JSON.stringify({
        mode: state.mode,
        manualScale: clampScale(roundScale(state.manualScale)),
        floatingVisible: state.floatingVisible,
      }),
    );
  } catch {
    /* ignore */
  }
}

export type ViewportSize = { width: number; height: number };

/** Fit the reference desk layout into the visible window (with padding). */
export function computeAutoFitScale(viewport: ViewportSize, padding = 32): number {
  const w = Math.max(320, viewport.width - padding);
  const h = Math.max(480, viewport.height - padding);
  const scaleW = w / VIEWPORT_REF_WIDTH;
  const scaleH = h / VIEWPORT_REF_HEIGHT;
  const fit = Math.min(scaleW, scaleH);

  if (fit < 1) {
    // Narrow multi-window pane: nudge above 100% so text stays normal-sized.
    const boost = 1 + (1 - fit) * 0.42;
    return clampScale(roundScale(Math.min(VIEWPORT_COMFORT_MAX, boost)));
  }

  // Roomy viewport: mild scale-up, still capped so layout does not balloon.
  return clampScale(roundScale(Math.min(VIEWPORT_COMFORT_MAX, Math.max(VIEWPORT_ZOOM_MIN, fit))));
}

/**
 * Browser page zoom below 100% (common in multi-window) shrinks UI — estimate and compensate.
 * Returns 1 when unknown or already ~100%.
 */
export function estimateBrowserZoomRatio(viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0): number {
  if (typeof window === 'undefined' || viewportWidth <= 0) return 1;
  const vv = window.visualViewport;
  if (!vv || vv.width <= 0) return 1;
  const ratio = viewportWidth / vv.width;
  if (!Number.isFinite(ratio) || ratio < 1.05 || ratio > 2.5) return 1;
  return roundScale(ratio);
}

/** Final scale applied to the app — includes optional browser-zoom compensation. */
export function resolveEffectiveViewportScale(
  state: ViewportZoomState,
  viewport: ViewportSize,
  browserZoomRatio = 1,
): number {
  let base = resolveViewportScale(state, viewport);
  if (browserZoomRatio > 1.04) {
    const boost = Math.min(browserZoomRatio, VIEWPORT_COMFORT_MAX);
    base = clampScale(roundScale(base * boost));
  }
  if (state.mode === 'auto') {
    base = Math.min(base, VIEWPORT_COMFORT_MAX);
  }
  return base;
}

export function resolveViewportScale(state: ViewportZoomState, viewport: ViewportSize): number {
  if (state.mode === 'manual') return clampScale(state.manualScale);
  return computeAutoFitScale(viewport);
}

export function zoomInManualScale(current: number): number {
  return clampScale(roundScale(current + VIEWPORT_ZOOM_STEP));
}

export function zoomOutManualScale(current: number): number {
  return clampScale(roundScale(current - VIEWPORT_ZOOM_STEP));
}

export function formatViewportScalePct(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
