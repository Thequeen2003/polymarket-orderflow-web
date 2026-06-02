/** Which trade shells are visible — slide-in panel vs docked sidebar. */

export type TradeUiPreferences = {
  /** Sticky right-column trade panel on xl (full default layout). */
  embedded: boolean;
  /** Slide-in trade panel from the right edge (Trade button). */
  slide: boolean;
};

const LS_KEY = 'pm-trade-ui-prefs-v2';

const DEFAULT_PREFS: TradeUiPreferences = {
  embedded: false,
  slide: true,
};

function migrateLegacy(raw: Record<string, unknown>): TradeUiPreferences {
  if (typeof raw.slide === 'boolean') {
    return {
      embedded: raw.embedded !== false,
      slide: raw.slide,
    };
  }
  // v1 used `floating` for the trade overlay
  const floating = raw.floating !== false;
  return {
    embedded: raw.embedded !== false,
    slide: floating,
  };
}

export function loadTradeUiPreferences(): TradeUiPreferences {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return migrateLegacy(parsed);
    }
    const legacy = localStorage.getItem('pm-trade-ui-prefs-v1');
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, unknown>;
      const migrated = migrateLegacy(parsed);
      saveTradeUiPreferences(migrated);
      return migrated;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_PREFS;
}

export function saveTradeUiPreferences(prefs: TradeUiPreferences): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
