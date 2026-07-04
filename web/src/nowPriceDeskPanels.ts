/** Persisted open/close state for Now Price desk hero strips. */

export type NowPriceDeskPanelId = 'catch' | 'signal' | 'context';

export type NowPriceDeskPanelsState = Record<NowPriceDeskPanelId, boolean>;

const STORAGE_KEY = 'pm_now_price_desk_panels_v1';

export const DEFAULT_NOW_PRICE_DESK_PANELS: NowPriceDeskPanelsState = {
  catch: true,
  signal: true,
  context: true,
};

const PANEL_IDS: NowPriceDeskPanelId[] = ['catch', 'signal', 'context'];

export function readNowPriceDeskPanels(): NowPriceDeskPanelsState {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_NOW_PRICE_DESK_PANELS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NOW_PRICE_DESK_PANELS };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_NOW_PRICE_DESK_PANELS };
    const o = parsed as Record<string, unknown>;
    const next = { ...DEFAULT_NOW_PRICE_DESK_PANELS };
    for (const id of PANEL_IDS) {
      if (typeof o[id] === 'boolean') next[id] = o[id];
    }
    return next;
  } catch {
    return { ...DEFAULT_NOW_PRICE_DESK_PANELS };
  }
}

export function writeNowPriceDeskPanels(state: NowPriceDeskPanelsState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

export function toggleNowPriceDeskPanel(
  state: NowPriceDeskPanelsState,
  id: NowPriceDeskPanelId,
): NowPriceDeskPanelsState {
  return { ...state, [id]: !state[id] };
}
