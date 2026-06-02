/**
 * Track how stable the trade directive is over time, so the user can see whether
 * a call has been holding for a while ("STABLE 45s") or just flipped this tick
 * ("FRESH FLIP — wait for confirmation").
 *
 * Pure store: each `updateStability` call returns the next state. The chart
 * holds a `useRef`/`useState` and feeds in the current directive on every tick.
 *
 * Stability state:
 *   - `forming`     — < 10s since last change
 *   - `consolidating` — 10–30s since change
 *   - `stable`      — ≥ 30s since change
 *   - `whipsaw`     — flipsPerMin ≥ 4 (the directive is jumping around)
 */

import type { DirectiveAction, TradeDirective } from './tradeDirective';

export type StabilityTier = 'forming' | 'consolidating' | 'stable' | 'whipsaw';

export type DirectiveSnapshot = {
  ts: number;
  action: DirectiveAction;
  lane: 'up' | 'down' | null;
};

export type DirectiveStability = {
  /** Tier label for UI (chip color). */
  tier: StabilityTier;
  /** ms since the last *meaningful* change (action OR lane). */
  msSinceChange: number;
  /** Number of meaningful changes in the last 60 seconds. */
  flipsLastMin: number;
  /** Most recent snapshot (current directive). */
  current: DirectiveSnapshot | null;
  /** Snapshot of the previous directive (immediately before the current one). */
  previous: DirectiveSnapshot | null;
  /** Recent change history (capped to ~30 entries). */
  history: DirectiveSnapshot[];
  /** True when fresh enough that the user should wait for confirmation. */
  warnFresh: boolean;
  /** True when the directive is whipsawing. */
  whipsaw: boolean;
  /** Short, user-facing summary. */
  summary: string;
  /**
   * True when this is a high-conviction transition (STAND_DOWN/HOLD → INITIATE/ADD HIGH).
   * Downstream consumers can use this to skip additional debounce gates.
   */
  rapidConviction: boolean;
};

const MAX_HISTORY = 30;

const EMPTY: DirectiveStability = {
  tier: 'forming',
  msSinceChange: 0,
  flipsLastMin: 0,
  current: null,
  previous: null,
  history: [],
  warnFresh: false,
  whipsaw: false,
  summary: 'No directive yet.',
  rapidConviction: false,
};

function snapshotKey(s: DirectiveSnapshot): string {
  return `${s.action}|${s.lane ?? '-'}`;
}

function snapshotFromDirective(directive: TradeDirective | null, nowMs: number): DirectiveSnapshot | null {
  if (!directive) return null;
  return { ts: nowMs, action: directive.action, lane: directive.lane };
}

/** High-conviction transitions (STAND_DOWN→INITIATE with HIGH conf) use a faster forming window. */
const FAST_FORMING_MS = 4_000;
const NORMAL_FORMING_MS = 10_000;

function tierFor(msSinceChange: number, flipsLastMin: number, rapidConviction = false): StabilityTier {
  if (flipsLastMin >= 4) return 'whipsaw';
  const formingThreshold = rapidConviction ? FAST_FORMING_MS : NORMAL_FORMING_MS;
  if (msSinceChange < formingThreshold) return 'forming';
  if (msSinceChange < 30_000) return 'consolidating';
  return 'stable';
}

function summaryFor(state: Omit<DirectiveStability, 'summary'>, current: DirectiveSnapshot | null): string {
  if (!current) return 'No directive yet.';
  const sec = Math.round(state.msSinceChange / 1000);
  if (state.whipsaw) {
    return `WHIPSAW — ${state.flipsLastMin} flips in 60s; wait for the tape to commit.`;
  }
  if (state.tier === 'forming') {
    return `Fresh ${current.action} — only ${sec}s old; let it confirm.`;
  }
  if (state.tier === 'consolidating') {
    return `${current.action} consolidating — ${sec}s stable; building reliability.`;
  }
  return `${current.action} stable — held for ${sec}s+ across the last several ticks.`;
}

/** Detect high-conviction transition: STAND_DOWN/HOLD → INITIATE/ADD with HIGH confidence. */
function isRapidConvictionTransition(
  prevSnap: DirectiveSnapshot | null,
  current: DirectiveSnapshot,
  directive: TradeDirective | null,
): boolean {
  if (!directive || directive.confidence !== 'HIGH') return false;
  if (current.action !== 'INITIATE' && current.action !== 'ADD' && current.action !== 'FLIP') return false;
  if (!prevSnap) return true;
  return prevSnap.action === 'STAND_DOWN' || prevSnap.action === 'HOLD';
}

/**
 * Update the stability state given the latest directive at `nowMs`.
 */
export function updateStability(
  prev: DirectiveStability | null,
  directive: TradeDirective | null,
  nowMs: number,
): DirectiveStability {
  const current = snapshotFromDirective(directive, nowMs);
  if (!current) {
    return prev ?? EMPTY;
  }

  // First-ever snapshot.
  if (!prev || !prev.current) {
    const rapidConviction = isRapidConvictionTransition(null, current, directive);
    const state = {
      ...EMPTY,
      tier: 'forming' as StabilityTier,
      msSinceChange: 0,
      flipsLastMin: 0,
      current,
      previous: null,
      history: [current],
      warnFresh: !rapidConviction,
      whipsaw: false,
      rapidConviction,
    };
    return { ...state, summary: summaryFor(state, current) };
  }

  const prevSnap = prev.current;
  const isMeaningfulChange = snapshotKey(prevSnap) !== snapshotKey(current);

  let history = prev.history;
  let previous = prev.previous;
  let lastChangeTs: number;

  if (isMeaningfulChange) {
    history = [...prev.history, current].slice(-MAX_HISTORY);
    previous = prevSnap;
    lastChangeTs = nowMs;
  } else {
    lastChangeTs = prev.history.length > 0 ? prev.history[prev.history.length - 1]!.ts : nowMs;
    if (history[history.length - 1]?.action !== current.action || history[history.length - 1]?.lane !== current.lane) {
      history = [...history, current].slice(-MAX_HISTORY);
    }
  }

  const msSinceChange = Math.max(0, nowMs - lastChangeTs);
  const oneMinAgo = nowMs - 60_000;
  const flipsLastMin = Math.max(0, history.filter((h) => h.ts >= oneMinAgo).length - 1);

  const rapidConviction = isMeaningfulChange
    ? isRapidConvictionTransition(prevSnap, current, directive)
    : prev.rapidConviction;

  const tier = tierFor(msSinceChange, flipsLastMin, rapidConviction);
  const whipsaw = tier === 'whipsaw';
  const warnFresh = (tier === 'forming' && !rapidConviction) || whipsaw;

  const next: Omit<DirectiveStability, 'summary'> = {
    tier,
    msSinceChange,
    flipsLastMin,
    current,
    previous,
    history,
    warnFresh,
    whipsaw,
    rapidConviction,
  };

  return { ...next, summary: summaryFor(next, current) };
}
