import type { BookIntel } from './bookIntel';
import type { SeriesPoint } from './MomentumChart';
import type { SpotPoint } from './SpotLevelChart';
import { describeMomentum } from './liveContext';

function slopeLastWindowProbPerSec(pts: SpotPoint[], windowMs: number): number | null {
  if (pts.length < 2) return null;
  const end = pts[pts.length - 1]!.t;
  const slice = pts.filter((p) => p.t >= end - windowMs && Number.isFinite(p.v));
  if (slice.length < 2) return null;
  const a = slice[slice.length - 1]!;
  const b = slice[0]!;
  const dt = Math.max(1e-6, (a.t - b.t) / 1000);
  return (a.v - b.v) / dt;
}

export type BracketMomentumUi = {
  /** Short lines for SL/TP panel (prob + book context). */
  lines: string[];
};

/**
 * Prob-path momentum (15s window) plus optional book microstructure for bracket UX.
 */
export function buildBracketMomentumUi(args: {
  probUp?: SpotPoint[] | null;
  probDown?: SpotPoint[] | null;
  lane: 'up' | 'down';
  upLabel: string;
  downLabel: string;
  bookIntel: BookIntel | null;
}): BracketMomentumUi | null {
  const up = args.probUp ?? [];
  const dn = args.probDown ?? [];
  const lines: string[] = [];

  if (up.length >= 2 || dn.length >= 2) {
    const ctx = describeMomentum({ a: up as SeriesPoint[], b: dn as SeriesPoint[] });
    lines.push(ctx.read);
    const lanePts = args.lane === 'up' ? up : dn;
    const laneLab = args.lane === 'up' ? args.upLabel : args.downLabel;
    const oppLab = args.lane === 'up' ? args.downLabel : args.upLabel;
    const slopePs = slopeLastWindowProbPerSec(lanePts, 15_000);
    if (slopePs != null && Number.isFinite(slopePs)) {
      const cpp = slopePs * 100;
      const arrow = cpp >= 0 ? '↑' : '↓';
      lines.push(
        `${laneLab} tape · ${arrow}${Math.abs(cpp).toFixed(2)}¢/s (~${Math.abs(cpp * 60).toFixed(1)}¢/min) vs ${oppLab}`,
      );
    }
    if (ctx.spikePp15s != null && ctx.spikePp15s >= 1) {
      lines.push(`15s spike ≤ ${ctx.spikePp15s.toFixed(1)}¢ (either outcome)`);
    }
  }

  const bi = args.bookIntel;
  if (bi) {
    const parts: string[] = [];
    if (bi.mid != null && bi.microprice != null && bi.microSkew != null && Number.isFinite(bi.microSkew)) {
      const skewC = bi.microSkew * 100;
      parts.push(`micro skew ${skewC >= 0 ? '+' : ''}${skewC.toFixed(2)}¢ vs mid`);
    }
    if (bi.imbalanceNotional5 != null && Number.isFinite(bi.imbalanceNotional5)) {
      const imb = bi.imbalanceNotional5;
      parts.push(
        imb > 0.08 ? 'bid-heavy top-5' : imb < -0.08 ? 'ask-heavy top-5' : 'balanced depth',
      );
    }
    if (parts.length) lines.push(`Book · ${parts.join(' · ')}`);
  }

  if (!lines.length) return null;
  return { lines };
}
