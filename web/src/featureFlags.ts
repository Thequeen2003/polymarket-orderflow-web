/**
 * Tiny persisted feature-flag layer. Stored in `localStorage` under one key so
 * a user can flip experimental behaviors without a redeploy. Centralized here
 * so consumers don't sprinkle `localStorage.getItem` checks around the app.
 *
 * Keep flags **boolean** and **default-off-when-experimental / default-on-when-polished**
 * — never gate critical safety code behind a flag.
 */

const STORAGE_KEY = 'polyof:flags:v1';

/** Add a new flag here, default value, and short docstring. */
export const FEATURE_FLAGS_DEFAULTS = {
  /** Play a short audio chime when BOOM fires. Off by default (sound is intrusive). */
  boomSound: false,
  /** Show the operator-note input above the chart. */
  pinnedNote: true,
  /** Show the keyboard-shortcuts help. */
  keyboardShortcuts: true,
  /** Show the No-Trade composite stand-down banner when score is high. */
  noTradeBanner: true,
  /** Show the volume / aggressor tape-velocity strip on the chart. */
  tapeVelocity: true,
  /** Show CSV export button on the directive card. */
  journalExport: true,
  /** Use reason-tagged cool-downs (longer for negative-edge events). */
  reasonCooldowns: true,
  /** Respect prefers-reduced-motion when set; turns off pulse/animations. */
  respectReducedMotion: true,
} as const;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS_DEFAULTS;
export type FeatureFlags = Record<FeatureFlagKey, boolean>;

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(): Partial<FeatureFlags> {
  const s = safeStorage();
  if (!s) return {};
  try {
    const v = s.getItem(STORAGE_KEY);
    if (!v) return {};
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === 'object') return parsed as Partial<FeatureFlags>;
    return {};
  } catch {
    return {};
  }
}

export function readFeatureFlags(): FeatureFlags {
  const overrides = readRaw();
  return { ...FEATURE_FLAGS_DEFAULTS, ...overrides };
}

export function setFeatureFlag(key: FeatureFlagKey, value: boolean): FeatureFlags {
  const s = safeStorage();
  const next = { ...readFeatureFlags(), [key]: value };
  if (s) {
    try {
      s.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode — silently drop */
    }
  }
  // Notify listeners (other tabs / hooks) within this tab.
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('polyof:flags-changed', { detail: next }));
    } catch {
      /* ignore */
    }
  }
  return next;
}

export function resetFeatureFlags(): FeatureFlags {
  const s = safeStorage();
  if (s) {
    try {
      s.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(
        new CustomEvent('polyof:flags-changed', { detail: { ...FEATURE_FLAGS_DEFAULTS } }),
      );
    } catch {
      /* ignore */
    }
  }
  return { ...FEATURE_FLAGS_DEFAULTS };
}
