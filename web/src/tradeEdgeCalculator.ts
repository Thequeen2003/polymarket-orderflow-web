/**
 * Translate the model's terminal-side probability into actual $ trade edge for a
 * given outcome side.
 *
 * For Polymarket UP/DOWN tournament markets the contracts settle at $1.00 (win)
 * or $0.00 (loss). If you buy a share at mid `m`:
 *   EV per share = p_win · (1 − m) + (1 − p_win) · (−m)
 *                = p_win − m
 *
 *   Breakeven prob = m   (you must win at least m% of the time to break even)
 *   Edge in $/share = p_win − m
 *   Edge per dollar staked = (p_win − m) / m   (return on cost basis)
 *
 * Quality buckets (absolute edge per share):
 *   HIGH      ≥ 0.12   (>= +12¢ edge)
 *   MED       ≥ 0.05
 *   LOW       ≥ 0.015
 *   NEGATIVE  < 0     (model says the trade is −EV)
 *   THIN      otherwise (between 0 and ~1.5¢, basically noise)
 *
 * Pure module: no React, easy to unit-test.
 */

export type EdgeQuality = 'HIGH' | 'MED' | 'LOW' | 'THIN' | 'NEGATIVE';

export type TradeEdge = {
  lane: 'up' | 'down';
  /** Mid price you'd pay/sell at (0..1). */
  mid: number;
  /** Model probability that this outcome wins at settlement (0..1). */
  pWin: number;
  /** Per-share edge in $; positive = trade is +EV at this mid. */
  edgePerShareUsd: number;
  /** Return per dollar staked; equivalent to (pWin − mid) / mid. NaN-safe. */
  evPerDollar: number;
  /** Probability needed to merely break even (= mid). */
  breakevenProb: number;
  /** How far the model exceeds breakeven; same as edgePerShareUsd / 1 (already $/share). */
  marginOverBreakeven: number;
  quality: EdgeQuality;
  /** Short, user-facing summary. */
  summary: string;
};

export type LaneEdges = {
  up: TradeEdge | null;
  down: TradeEdge | null;
  /** Whichever lane has the larger positive edge (or null if neither is +EV). */
  bestLane: 'up' | 'down' | null;
  /** Best edge per share across the two lanes (0 if neither +EV). */
  bestEdgeUsd: number;
};

const NULL_EDGES: LaneEdges = { up: null, down: null, bestLane: null, bestEdgeUsd: 0 };

function classify(edgeUsd: number): EdgeQuality {
  if (edgeUsd < 0) return 'NEGATIVE';
  if (edgeUsd >= 0.12) return 'HIGH';
  if (edgeUsd >= 0.05) return 'MED';
  if (edgeUsd >= 0.015) return 'LOW';
  return 'THIN';
}

function laneSummary(lane: 'up' | 'down', mid: number, pWin: number, edgeUsd: number, quality: EdgeQuality): string {
  const sideTxt = lane === 'up' ? 'UP' : 'DOWN';
  const edgeTxt = `${edgeUsd >= 0 ? '+' : ''}${edgeUsd.toFixed(3)}`;
  const winTxt = `${Math.round(pWin * 100)}%`;
  const midTxt = mid.toFixed(2);
  switch (quality) {
    case 'HIGH':
      return `${sideTxt} edge ${edgeTxt}/share — model ${winTxt} vs market ${midTxt}, strong +EV.`;
    case 'MED':
      return `${sideTxt} edge ${edgeTxt}/share — model ${winTxt} vs market ${midTxt}, solid +EV.`;
    case 'LOW':
      return `${sideTxt} edge ${edgeTxt}/share — model ${winTxt} vs market ${midTxt}, marginal +EV.`;
    case 'NEGATIVE':
      return `${sideTxt} edge ${edgeTxt}/share — model ${winTxt} below market ${midTxt}, −EV.`;
    case 'THIN':
    default:
      return `${sideTxt} edge ~${edgeTxt}/share — model ${winTxt} ≈ market ${midTxt}, no real edge.`;
  }
}

function safeMid(m: number | null | undefined): number | null {
  if (m == null || !Number.isFinite(m)) return null;
  if (m <= 0 || m >= 1) return null; // 0/1 mids would zero-divide and aren't tradable mids anyway
  return m;
}

/**
 * Compute UP and DOWN trade edges given current implied mids and the model's
 * terminal-side probability. `endAboveProb` is `P(spot > PTB at bell)`.
 */
export function computeLaneEdges(input: {
  upMid: number | null;
  downMid: number | null;
  endAboveProb: number | null;
  /** Confidence in `endAboveProb` ('high' | 'med' | 'low'); 'low' demotes quality one tier. */
  modelConfidence?: 'high' | 'med' | 'low';
}): LaneEdges {
  const { endAboveProb, modelConfidence } = input;
  if (endAboveProb == null || !Number.isFinite(endAboveProb)) return NULL_EDGES;
  const pUp = Math.max(0, Math.min(1, endAboveProb));
  const pDown = 1 - pUp;
  let mUp = safeMid(input.upMid);
  let mDown = safeMid(input.downMid);
  // Binary complement: feeds often ship one outcome mid; infer the other so DOWN
  // isn't stuck null / −EV while UP looks fine (felt like TP/SL "UP bias").
  if (mUp != null && mDown == null) mDown = safeMid(1 - mUp);
  if (mDown != null && mUp == null) mUp = safeMid(1 - mDown);

  const demote = (q: EdgeQuality): EdgeQuality => {
    if (modelConfidence !== 'low') return q;
    if (q === 'HIGH') return 'MED';
    if (q === 'MED') return 'LOW';
    if (q === 'LOW') return 'THIN';
    return q;
  };

  const buildEdge = (lane: 'up' | 'down', mid: number, p: number): TradeEdge => {
    const edgeUsd = p - mid;
    const quality = demote(classify(edgeUsd));
    return {
      lane,
      mid,
      pWin: p,
      edgePerShareUsd: edgeUsd,
      evPerDollar: edgeUsd / mid,
      breakevenProb: mid,
      marginOverBreakeven: edgeUsd,
      quality,
      summary: laneSummary(lane, mid, p, edgeUsd, quality),
    };
  };

  const up = mUp != null ? buildEdge('up', mUp, pUp) : null;
  const down = mDown != null ? buildEdge('down', mDown, pDown) : null;

  const EDGE_TIE_EPS = 1e-9;
  const present = [up, down].filter((e): e is TradeEdge => e != null);
  let bestEdge = present.length ? Math.max(...present.map((e) => e.edgePerShareUsd)) : 0;
  const atBest = present.filter((e) => Math.abs(e.edgePerShareUsd - bestEdge) <= EDGE_TIE_EPS);
  const bestLane = atBest.length === 1 ? atBest[0]!.lane : null;
  return { up, down, bestLane, bestEdgeUsd: bestEdge > 0 ? bestEdge : 0 };
}
