import { clampChartPanelScale, DEFAULT_CHART_PANEL_SCALE } from './chartPanelZoom';

/** Which chart/signal surfaces can appear together on the Signals desk. */
export type SignalsPanelId = 'spot' | 'dual' | 'now' | 'plm';

export type SignalsMultiPanelState = {
  v: 2;
  /** When true, checked panels render in one grid instead of single-tab switching. */
  enabled: boolean;
  panels: Record<SignalsPanelId, boolean>;
  /** Per-tile zoom — in-app only, not browser zoom. */
  panelScale: Record<SignalsPanelId, number>;
};

const LS_KEY = 'pm-signals-multi-panel-v2';

export const SIGNALS_PANEL_LABELS: Record<SignalsPanelId, string> = {
  spot: 'Spot vs PTB',
  dual: 'Dual PTB',
  now: 'Now price signals',
  plm: 'PLM',
};

const DEFAULT_PANELS: Record<SignalsPanelId, boolean> = {
  spot: true,
  dual: true,
  now: true,
  plm: false,
};

const DEFAULT_PANEL_SCALE: Record<SignalsPanelId, number> = {
  spot: DEFAULT_CHART_PANEL_SCALE,
  dual: DEFAULT_CHART_PANEL_SCALE,
  now: DEFAULT_CHART_PANEL_SCALE,
  plm: DEFAULT_CHART_PANEL_SCALE,
};

const DEFAULT: SignalsMultiPanelState = {
  v: 2,
  enabled: false,
  panels: DEFAULT_PANELS,
  panelScale: DEFAULT_PANEL_SCALE,
};

function readPanelScale(raw: Partial<SignalsMultiPanelState> | null | undefined): Record<SignalsPanelId, number> {
  const src = raw?.panelScale;
  return {
    spot: clampChartPanelScale(typeof src?.spot === 'number' ? src.spot : DEFAULT_CHART_PANEL_SCALE),
    dual: clampChartPanelScale(typeof src?.dual === 'number' ? src.dual : DEFAULT_CHART_PANEL_SCALE),
    now: clampChartPanelScale(typeof src?.now === 'number' ? src.now : DEFAULT_CHART_PANEL_SCALE),
    plm: clampChartPanelScale(typeof src?.plm === 'number' ? src.plm : DEFAULT_CHART_PANEL_SCALE),
  };
}

function readPanels(raw: Partial<SignalsMultiPanelState> | null | undefined): Record<SignalsPanelId, boolean> {
  const p = raw?.panels;
  return {
    spot: p?.spot !== false,
    dual: p?.dual !== false,
    now: p?.now !== false,
    plm: !!p?.plm,
  };
}

export function readSignalsMultiPanel(): SignalsMultiPanelState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT, panels: { ...DEFAULT.panels }, panelScale: { ...DEFAULT.panelScale } };
    const o = JSON.parse(raw) as Partial<SignalsMultiPanelState>;
    if (typeof o.enabled !== 'boolean' || !o.panels) {
      return { ...DEFAULT, panels: { ...DEFAULT.panels }, panelScale: { ...DEFAULT.panelScale } };
    }
    return {
      v: 2,
      enabled: o.enabled,
      panels: readPanels(o),
      panelScale: readPanelScale(o),
    };
  } catch {
    return { ...DEFAULT, panels: { ...DEFAULT.panels }, panelScale: { ...DEFAULT.panelScale } };
  }
}

export function saveSignalsMultiPanel(state: SignalsMultiPanelState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function visibleSignalsPanels(
  state: SignalsMultiPanelState,
  opts: { hasDual: boolean; bookOnlyDesk: boolean; showNow: boolean },
): SignalsPanelId[] {
  const out: SignalsPanelId[] = [];
  if (state.panels.spot && !opts.bookOnlyDesk) out.push('spot');
  if (state.panels.dual && opts.hasDual) out.push('dual');
  if (state.panels.now && opts.showNow) out.push('now');
  if (state.panels.plm && opts.showNow) out.push('plm');
  return out;
}

/** Grid placement + min heights tuned for chart aspect (wider top row, signals strip below). */
export function multiPanelTileClass(id: SignalsPanelId, visible: SignalsPanelId[]): string {
  const n = visible.length;
  if (n <= 1) return 'col-span-full';
  const i = visible.indexOf(id);
  if (n === 2) {
    return i === 0 ? 'xl:col-span-7' : 'xl:col-span-5';
  }
  if (n === 3) {
    if (id === 'spot') return 'xl:col-span-7';
    if (id === 'dual') return 'xl:col-span-5';
    return 'xl:col-span-full';
  }
  // four panels: 2×2 on xl
  if (id === 'spot') return 'xl:col-span-7';
  if (id === 'dual') return 'xl:col-span-5';
  if (id === 'now') return 'xl:col-span-7';
  return 'xl:col-span-5';
}

export function multiPanelMinH(id: SignalsPanelId): string {
  switch (id) {
    case 'spot':
      return 'min-h-[min(40vh,460px)]';
    case 'dual':
      return 'min-h-[min(34vh,400px)]';
    case 'now':
      return 'min-h-[min(30vh,360px)]';
    case 'plm':
      return 'min-h-[min(26vh,320px)]';
  }
}
