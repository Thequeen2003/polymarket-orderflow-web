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
};

function snapshotKey(s: DirectiveSnapshot): string {
  return `${s.action}|${s.lane ?? '-'}`;
}

function snapshotFromDirective(directive: TradeDirective | null, nowMs: number): DirectiveSnapshot | null {
  if (!directive) return null;
  return { ts: nowMs, action: directive.action, lane: directive.lane };
}

function tierFor(msSinceChange: number, flipsLastMin: number): StabilityTier {
  if (flipsLastMin >= 4) return 'whipsaw';
  if (msSinceChange < 10_000) return 'forming';
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
    const state = {
      ...EMPTY,
      tier: 'forming' as StabilityTier,
      msSinceChange: 0,
      flipsLastMin: 0,
      current,
      previous: null,
      history: [current],
      warnFresh: true,
      whipsaw: false,
    };
    return { ...state, summary: summaryFor(state, current) };
  }

  const prevSnap = prev.current;
  const isMeaningfulChange = snapshotKey(prevSnap) !== snapshotKey(current);

  let history = prev.history;
  let previous = prev.previous;
  let lastChangeTs: number;

  if (isMeaningfulChange) {
    // Stamp the change into history.
    history = [...prev.history, current].slice(-MAX_HISTORY);
    previous = prevSnap;
    lastChangeTs = nowMs;
  } else {
    // Same directive — keep history (don't append duplicates).
    lastChangeTs = prev.history.length > 0 ? prev.history[prev.history.length - 1]!.ts : nowMs;
    if (history[history.length - 1]?.action !== current.action || history[history.length - 1]?.lane !== current.lane) {
      // First snapshot path; ensure we have at least one entry.
      history = [...history, current].slice(-MAX_HISTORY);
    }
  }

  const msSinceChange = Math.max(0, nowMs - lastChangeTs);
  // Flips in last 60s: count history entries within window minus 1 (initial state isn't a "flip").
  const oneMinAgo = nowMs - 60_000;
  const flipsLastMin = Math.max(0, history.filter((h) => h.ts >= oneMinAgo).length - 1);

  const tier = tierFor(msSinceChange, flipsLastMin);
  const whipsaw = tier === 'whipsaw';
  const warnFresh = tier === 'forming' || whipsaw;

  const next: Omit<DirectiveStability, 'summary'> = {
    tier,
    msSinceChange,
    flipsLastMin,
    current,
    previous,
    history,
    warnFresh,
    whipsaw,
  };

  return { ...next, summary: summaryFor(next, current) };
}
