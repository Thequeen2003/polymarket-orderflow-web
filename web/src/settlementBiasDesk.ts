import type { BinaryOutcomeEstimate } from './binaryOutcomeBias';

export const BPX_SETTLEMENT_BIAS_OPEN_EVENT = 'bpx-settlement-bias-open';

/** Square slide panel edge length (px). */
export const SETTLEMENT_BIAS_SLIDE_PX = 400;

export type SettlementBiasSnapshot = {
  estimate: BinaryOutcomeEstimate;
  upLabel: string;
  downLabel: string;
  normMarketUp: number | null;
  probDeltaUp01?: number | null;
  probDeltaDown01?: number | null;
};

/** Stable key so publish skips no-op updates (avoids context ↔ effect loops). */
export function settlementBiasSnapshotKey(snapshot: SettlementBiasSnapshot | null): string {
  if (snapshot == null) return '';
  const e = snapshot.estimate;
  return JSON.stringify({
    upLabel: snapshot.upLabel,
    downLabel: snapshot.downLabel,
    normMarketUp: snapshot.normMarketUp,
    probDeltaUp01: snapshot.probDeltaUp01 ?? null,
    probDeltaDown01: snapshot.probDeltaDown01 ?? null,
    probUp: e.probUp,
    probDown: e.probDown,
    score: e.score,
    marketImpliedUp: e.marketImpliedUp,
    marketSkewS: e.marketSkewS,
    horizonSec: e.horizonSec,
    signals: e.signals,
    missing: e.missing,
  });
}

export function dispatchSettlementBiasOpen(): void {
  window.dispatchEvent(new CustomEvent(BPX_SETTLEMENT_BIAS_OPEN_EVENT));
}
