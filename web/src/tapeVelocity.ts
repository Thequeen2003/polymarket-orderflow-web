/**
 * Aggressor / tape-velocity sensor.
 *
 * Momentum scalpers don't care about quoted size — they care about *who is
 * actually trading right now*. This module ingests recent prints (per outcome,
 * timestamped, side = 'buy' | 'sell', size in shares) and produces:
 *
 *   - Buy-volume vs sell-volume in two windows (recent vs baseline)
 *   - Net pressure score (-100..100) — positive = buyers in control
 *   - Burst detection (1: aggressive, 2: extreme) — recent volume vs baseline
 *   - Side dominance: 'buy' | 'sell' | 'mixed' | 'idle'
 *
 * Pure module: takes an array of `TapePrint`, returns `TapeVelocity`. Easy to
 * unit-test, no React, no fetches.
 */

export type TapePrint = {
  /** Epoch ms. Caller normalizes whatever the API provides into ms. */
  ts: number;
  side: 'buy' | 'sell';
  /** Shares (or notional — caller picks one and stays consistent). */
  size: number;
};

export type TapeWindow = {
  /** Sum of buy size in window. */
  buyVol: number;
  /** Sum of sell size in window. */
  sellVol: number;
  /** Total prints (count). */
  count: number;
  /** Net = buy − sell. */
  net: number;
};

export type TapeBurst = 'idle' | 'normal' | 'aggressive' | 'extreme';
export type TapeDominance = 'buy' | 'sell' | 'mixed' | 'idle';

export type TapeVelocity = {
  /** Window we react to (default 30s). */
  recent: TapeWindow;
  /** Baseline window for ratio comparison (default last 5min, recent excluded). */
  baseline: TapeWindow;
  /** Recent total / baseline-per-recent-duration. >1 = burst. */
  burstRatio: number;
  /** Bucketed burst label. */
  burst: TapeBurst;
  /** Recent net buy pressure: buy − sell over total volume in -1..1, scaled to -100..100. */
  netPressure: number;
  /** Side dominance label for chips. */
  dominance: TapeDominance;
  /** True when recent has at least `minPrints` so callers can ignore noise. */
  reliable: boolean;
  /** Concise human summary for tooltips / banner. */
  summary: string;
};

const EMPTY: TapeVelocity = {
  recent: { buyVol: 0, sellVol: 0, count: 0, net: 0 },
  baseline: { buyVol: 0, sellVol: 0, count: 0, net: 0 },
  burstRatio: 0,
  burst: 'idle',
  netPressure: 0,
  dominance: 'idle',
  reliable: false,
  summary: 'Tape idle — no recent prints.',
};

function aggregate(prints: TapePrint[]): TapeWindow {
  let buyVol = 0;
  let sellVol = 0;
  for (const p of prints) {
    if (!Number.isFinite(p.size) || p.size <= 0) continue;
    if (p.side === 'buy') buyVol += p.size;
    else if (p.side === 'sell') sellVol += p.size;
  }
  return { buyVol, sellVol, count: prints.length, net: buyVol - sellVol };
}

function classifyBurst(ratio: number, recentCount: number): TapeBurst {
  if (recentCount === 0) return 'idle';
  if (ratio >= 4) return 'extreme';
  if (ratio >= 2) return 'aggressive';
  return 'normal';
}

function classifyDominance(net: number, total: number): TapeDominance {
  if (total <= 0) return 'idle';
  const skew = net / total; // -1..1
  if (skew >= 0.4) return 'buy';
  if (skew <= -0.4) return 'sell';
  return 'mixed';
}

function summarize(state: Omit<TapeVelocity, 'summary'>): string {
  if (state.recent.count === 0) return 'Tape idle — no recent prints.';
  const dom =
    state.dominance === 'buy'
      ? 'BUYERS'
      : state.dominance === 'sell'
        ? 'SELLERS'
        : 'mixed';
  const burst =
    state.burst === 'extreme'
      ? '⚡ EXTREME burst'
      : state.burst === 'aggressive'
        ? '⚡ aggressive burst'
        : state.burst === 'normal'
          ? 'normal volume'
          : 'idle';
  const net = state.netPressure >= 0 ? `+${state.netPressure.toFixed(0)}` : `${state.netPressure.toFixed(0)}`;
  return `Tape: ${dom} ${net} · ${burst} (×${state.burstRatio.toFixed(1)} baseline, ${state.recent.count} prints).`;
}

/**
 * @param prints   List of recent prints sorted newest-last is fine; we filter by ts.
 * @param now      Epoch ms — caller can pass `Date.now()` or a fixture in tests.
 * @param recentMs Default 30s — the "now" window scalpers care about.
 * @param baselineMs Default 5 min — for ratio normalization.
 * @param minPrints Threshold below which `reliable` is false.
 */
export function computeTapeVelocity(
  prints: TapePrint[] | null | undefined,
  opts: { now: number; recentMs?: number; baselineMs?: number; minPrints?: number },
): TapeVelocity {
  if (!prints || prints.length === 0) return EMPTY;
  const recentMs = opts.recentMs ?? 30_000;
  const baselineMs = opts.baselineMs ?? 300_000;
  const minPrints = opts.minPrints ?? 4;
  const recentCutoff = opts.now - recentMs;
  const baselineCutoff = opts.now - baselineMs;

  const recentPrints: TapePrint[] = [];
  const baselinePrints: TapePrint[] = [];
  for (const p of prints) {
    if (!Number.isFinite(p.ts)) continue;
    if (p.ts >= recentCutoff) recentPrints.push(p);
    else if (p.ts >= baselineCutoff) baselinePrints.push(p);
  }

  const recent = aggregate(recentPrints);
  const baseline = aggregate(baselinePrints);

  const recentTotal = recent.buyVol + recent.sellVol;
  const baselineTotal = baseline.buyVol + baseline.sellVol;
  // Normalize baseline to a per-recent-window rate.
  const baselineWindowsInBaseline = Math.max(1, (baselineMs - recentMs) / recentMs);
  const baselineRatePerRecent = baselineTotal / baselineWindowsInBaseline;
  const burstRatio = baselineRatePerRecent > 0 ? recentTotal / baselineRatePerRecent : recentTotal > 0 ? 5 : 0;

  const burst = classifyBurst(burstRatio, recent.count);
  const netPressure = recentTotal > 0 ? Math.max(-100, Math.min(100, (recent.net / recentTotal) * 100)) : 0;
  const dominance = classifyDominance(recent.net, recentTotal);

  const state: Omit<TapeVelocity, 'summary'> = {
    recent,
    baseline,
    burstRatio,
    burst,
    netPressure,
    dominance,
    reliable: recent.count >= minPrints,
  };

  return { ...state, summary: summarize(state) };
}
