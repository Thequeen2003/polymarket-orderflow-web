import type { SeriesPoint } from './MomentumChart';
import type { BookSnapshot } from './orderflowMetrics';

/** % change from first to last point in the trailing window (for implied-prob style mids). */
export function seriesWindowDelta(
  pts: SeriesPoint[],
  maxPoints = 100,
): { deltaPct: number | null; last: number | null; first: number | null; label: string } {
  const arr = pts.filter((p) => p.v != null).slice(-maxPoints) as { t: number; v: number }[];
  if (arr.length < 2) {
    const only = arr[0]?.v ?? null;
    return { deltaPct: null, last: only, first: only, label: 'Need 2+ points' };
  }
  const first = arr[0]!.v;
  const last = arr[arr.length - 1]!.v;
  const deltaPct = Math.abs(first) > 1e-9 ? ((last - first) / first) * 100 : null;
  const label =
    deltaPct == null
      ? '—'
      : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}% over chart window`;
  return { deltaPct, last, first, label };
}

/** One paragraph interpreting the stacked order-flow chart. */
export function orderFlowPlainRead(series: BookSnapshot[]): string {
  const s = series.filter((p) => p.mid != null).slice(-15);
  if (s.length < 3) {
    return 'Collect a few more samples (book polls about every 5s) before reading short-term direction.';
  }
  const m0 = s[0]!.mid!;
  const m1 = s[s.length - 1]!.mid!;
  const up = m1 > m0 + 0.002;
  const down = m1 < m0 - 0.002;
  const imb = s[s.length - 1]!.imbalance;
  const churnNow = s[s.length - 1]!.churn;
  const churnPrev = s[s.length - 2]?.churn ?? null;
  const parts: string[] = [];
  if (up) parts.push('Top panel: mid is creeping up — the market is paying up on this outcome in this window.');
  else if (down) parts.push('Top panel: mid is slipping — this outcome is being marked down vs a few samples ago.');
  else parts.push('Top panel: mid is roughly flat — no strong drift in the last few samples.');
  if (imb != null) {
    if (imb > 0.12) parts.push('Bottom: green bar up = more size on bids than asks in the ~12 levels we track (support stack).');
    else if (imb < -0.12) parts.push('Bottom: red bar down = more size on asks than bids (overhang on the offer side).');
    else parts.push('Bottom: imbalance is near neutral — neither side dominates depth in the tracked band.');
  }
  if (churnNow != null && churnPrev != null && churnNow > churnPrev * 1.35) {
    parts.push('Amber ticks: churn jumped — liquidity is moving (adds/pulls), not necessarily trades.');
  }
  return parts.join(' ');
}

/** Plain framing for how bid/ask relate to “entry” and “exit” on this outcome token. */
export function outcomeEntryExitHints(params: {
  label: string;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
}): string[] {
  const { label, mid, bestBid, bestAsk } = params;
  const lines: string[] = [];
  lines.push(
    `This ladder is for “${label}”. Mid ≈ midpoint of best bid and best ask (not a trade print).`,
  );
  if (bestAsk != null) {
    lines.push(
      `Adding risk on this outcome: you lift offers — first print is near the best ask (${bestAsk.toFixed(4)}).`,
    );
  }
  if (bestBid != null) {
    lines.push(
      `Reducing risk: you hit bids — first print is near the best bid (${bestBid.toFixed(4)}).`,
    );
  }
  if (mid != null && bestBid != null && bestAsk != null) {
    const spr = bestAsk - bestBid;
    lines.push(
      `Spread ${spr.toFixed(4)} · mid ${mid.toFixed(4)}. Tighter spread + stable mids usually reads “two-sided”; wide spread reads thin or uncertain.`,
    );
  }
  return lines;
}

/** Interprets synthetic spot candles + optional CLOB flow for continuation vs fragile move. */
export function spotStructureVsLevelRead(params: {
  maxExtAboveUsd: number;
  maxProbeBelowUsd: number;
  lastBodyFrac: number | null;
  lastCloseVsLevel: number | null;
  flowHint: 'lift' | 'drift' | 'fade' | 'neutral' | null;
}): string {
  const { maxExtAboveUsd, maxProbeBelowUsd, lastBodyFrac, lastCloseVsLevel, flowHint } = params;
  const parts: string[] = [];
  if (maxExtAboveUsd > 1e-6) {
    parts.push(`Max extension above the level in this window ≈ $${maxExtAboveUsd.toFixed(2)} (how far momentum carried spot).`);
  } else {
    parts.push('No sustained trade above the level in this window yet.');
  }
  if (maxProbeBelowUsd > 1e-6) {
    parts.push(
      `Deepest probe below the level ≈ $${maxProbeBelowUsd.toFixed(2)} — if spot reverses, that’s the “air” / weak-support pocket under the line.`,
    );
  } else {
    parts.push('Spot has not meaningfully traded under the level in this window (no clear void below).');
  }
  if (lastBodyFrac != null && lastCloseVsLevel != null) {
    const solid = lastBodyFrac >= 0.35;
    const side = lastCloseVsLevel >= 0 ? 'above' : 'below';
    parts.push(
      solid
        ? `Latest bucket: solid body vs wicks (${(lastBodyFrac * 100).toFixed(0)}% body) while ${side} the line — reads more like a push than a stray wick.`
        : `Latest bucket: long wicks vs small body (${(lastBodyFrac * 100).toFixed(0)}% body) — fragile structure; easy to mean-revert.`,
    );
  }
  if (flowHint && flowHint !== 'neutral') {
    const map: Record<string, string> = {
      lift:
        'Polymarket leg (same time bucket): mid rose with elevated book churn — consistent with repricing / lifting offers, not a dead drift.',
      drift: 'Polymarket leg: slow mid drift with little churn — more “marking” than an aggressive sweep.',
      fade: 'Polymarket leg: mid slipped with activity — offer side leaning in this window.',
    };
    parts.push(map[flowHint] ?? '');
  }
  return parts.filter(Boolean).join(' ');
}

/** Spot vs price-to-beat in words (above/below markets). */
export function spotVsLevelSentence(spot: number | null, priceToBeat: number | null): string {
  if (spot == null || priceToBeat == null) return '';
  const d = spot - priceToBeat;
  const mag = Math.abs(d);
  if (mag < 0.25) return `Spot is essentially at the level (${d >= 0 ? '+' : ''}${d.toFixed(2)} vs price-to-beat).`;
  if (d > 0) return `Spot is ${d.toFixed(2)} above the level — “above” resolutions lean on spot staying there through the window.`;
  return `Spot is ${Math.abs(d).toFixed(2)} below the level — “below” resolutions lean on spot staying under through the window.`;
}
