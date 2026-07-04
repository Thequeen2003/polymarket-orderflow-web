import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_VIEWPORT_ZOOM,
  estimateBrowserZoomRatio,
  formatViewportScalePct,
  loadViewportZoom,
  resolveEffectiveViewportScale,
  saveViewportZoom,
  zoomInManualScale,
  zoomOutManualScale,
  type ViewportZoomState,
} from './viewportZoom';

function readViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: VIEWPORT_REF_FALLBACK.width, height: VIEWPORT_REF_FALLBACK.height };
  return { width: window.innerWidth, height: window.innerHeight };
}

const VIEWPORT_REF_FALLBACK = { width: 1280, height: 900 };
const RESIZE_DEBOUNCE_MS = 150;

export function useViewportZoom() {
  const [state, setState] = useState<ViewportZoomState>(() => loadViewportZoom());
  const [viewport, setViewport] = useState(readViewportSize);
  const [browserZoomRatio, setBrowserZoomRatio] = useState(() =>
    typeof window !== 'undefined' ? estimateBrowserZoomRatio(window.innerWidth) : 1,
  );
  const scaleRef = useRef(1);

  useEffect(() => {
    saveViewportZoom(state);
  }, [state]);

  useEffect(() => {
    let timer: number | undefined;
    const sync = () => {
      setViewport(readViewportSize());
      setBrowserZoomRatio(estimateBrowserZoomRatio(window.innerWidth));
    };
    const debouncedSync = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, RESIZE_DEBOUNCE_MS);
    };
    sync();
    window.addEventListener('resize', debouncedSync);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', debouncedSync);
    return () => {
      window.removeEventListener('resize', debouncedSync);
      vv?.removeEventListener('resize', debouncedSync);
      window.clearTimeout(timer);
    };
  }, []);

  const scale = useMemo(
    () => resolveEffectiveViewportScale(state, viewport, browserZoomRatio),
    [state, viewport, browserZoomRatio],
  );
  const scaleLabel = useMemo(() => formatViewportScalePct(scale), [scale]);

  /** Chrome/Safari `zoom` on <html> breaks click hit-testing on long pages — scale the app shell instead. */
  useEffect(() => {
    if (Math.abs(scaleRef.current - scale) < 0.001) return;
    scaleRef.current = scale;
    document.documentElement.style.setProperty('--app-viewport-scale', String(scale));
  }, [scale]);

  useEffect(() => {
    return () => {
      document.documentElement.style.removeProperty('--app-viewport-scale');
    };
  }, []);

  const zoomIn = useCallback(() => {
    setState((prev) => {
      const base = resolveEffectiveViewportScale(prev, viewport, browserZoomRatio);
      return { ...prev, mode: 'manual', manualScale: zoomInManualScale(base) };
    });
  }, [viewport, browserZoomRatio]);

  const zoomOut = useCallback(() => {
    setState((prev) => {
      const base = resolveEffectiveViewportScale(prev, viewport, browserZoomRatio);
      return { ...prev, mode: 'manual', manualScale: zoomOutManualScale(base) };
    });
  }, [viewport, browserZoomRatio]);

  const setAutoFit = useCallback(() => {
    setState((prev) => ({ ...prev, mode: 'auto' }));
  }, []);

  const resetZoom = useCallback(() => {
    setState((prev) => ({ ...DEFAULT_VIEWPORT_ZOOM, floatingVisible: prev.floatingVisible }));
  }, []);

  const hideFloatingDock = useCallback(() => {
    setState((prev) => ({ ...prev, floatingVisible: false }));
  }, []);

  const showFloatingDock = useCallback(() => {
    setState((prev) => ({ ...prev, floatingVisible: true }));
  }, []);

  return {
    scale,
    scaleLabel,
    mode: state.mode,
    floatingVisible: state.floatingVisible,
    zoomIn,
    zoomOut,
    setAutoFit,
    resetZoom,
    hideFloatingDock,
    showFloatingDock,
  };
}
