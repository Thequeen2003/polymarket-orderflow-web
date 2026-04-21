import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { buildSpotCandlesInRange, type SpotCandle } from './spotVsPtb';
import { pickBookLevels } from './bookLevels';
import { computeProbMicrostructure } from './ptbAdvancedContext';
import { computePtbSystemDecision, PTB_DECISION_FALLBACK } from './ptbDecisionEngine';
import { appendPtbDualSample, loadPtbDualSamples, sampleFromPtbEvent, summarizePtbDual, updatePtbDualSampleById } from './ptbDualPlaybookStats';
import { estimateNet4cLong } from './executionEstimator';
import { computePtbNet4cRoom } from './ptbNet4cTradeability';
import { computePtbPathToTarget } from './ptbPathToTarget';
import { computePtbTargetEngine, topBookBias01 } from './ptbTargetEngine';
import { PtbUnifiedLineChartSvg } from './PtbUnifiedLineChartSvg';

const BUCKET_N = 26;
const BIN_N = 28;
const GAP_Q = 0.38;
const GAP_BIN_MIN = 3;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Pad sparse or degenerate time series so candle windows have a positive span. */
function padProbSeries(pts: { t: number; v: number }[]): { t: number; v: number }[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) {
    const p = pts[0]!;
    return [p, { t: p.t + 1, v: p.v }];
  }
  const out = pts.map((p) => ({ t: p.t, v: p.v }));
  const t0 = out[0]!.t;
  const t1 = out[out.length - 1]!.t;
  if (!(t1 > t0)) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { t: t0 + 1, v: last.v };
  }
  return out;
}

/** Symmetric [0,1] window around 0.5 so PTB sits at vertical center of each panel. */
function extentSymProb(minV: number, maxV: number): { min: number; max: number } {
  const lo = clamp01(minV);
  const hi = clamp01(maxV);
  const R = Math.max(0.06, Math.abs(lo - 0.5), Math.abs(hi - 0.5)) * 1.14;
  return { min: clamp01(0.5 - R), max: clamp01(0.5 + R) };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

function fmtPpSigned(pp: number): string {
  const s = pp >= 0 ? '+' : '';
  return `${s}${pp.toFixed(1)}pp`;
}

function bin01(p: number, n: number): number {
  const w = 1 / n;
  return Math.max(0, Math.min(n - 1, Math.floor(clamp01(p) / w)));
}

function contiguousMaxMean(scores: number[], lo: number, hi: number): { mean: number; a: number; b: number } | null {
  const a0 = Math.min(lo, hi);
  const b0 = Math.max(lo, hi);
  if (a0 > b0) return null;
  let best = -1;
  let ba = a0;
  let bb = a0;
  for (let a = a0; a <= b0; a++) {
    let s = 0;
    for (let b = a; b <= b0; b++) {
      s += scores[b]!;
      const len = b - a + 1;
      const m = s / len;
      if (m > best && len >= 2) {
        best = m;
        ba = a;
        bb = b;
      }
    }
  }
  return best < 0 ? null : { mean: best, a: ba, b: bb };
}

type GapBlock = { a: number; b: number; strength10: number; lo: number; hi: number; active: boolean; exitWall: number | null };

type PtbDualChartModel = {
  tMin: number;
  tMax: number;
  candlesUp: SpotCandle[];
  candlesDn: SpotCandle[];
  scaleU: { min: number; max: number };
  scaleD: { min: number; max: number };
  vacU: number[];
  vacD: number[];
  pathUp: { mean: number; a: number; b: number } | null;
  pathDn: { mean: number; a: number; b: number } | null;
  upRising: boolean;
  dnRising: boolean;
  lastU: number;
  lastD: number;
  distAbovePp: number;
  distBelowPp: number;
  gapU: GapBlock | null;
  gapD: GapBlock | null;
  lineSeriesUp: { t: number; v: number }[];
  lineSeriesDown: { t: number; v: number }[];
};

const DUMMY_CHART_MODEL: PtbDualChartModel = {
  tMin: 0,
  tMax: 1,
  candlesUp: [],
  candlesDn: [],
  scaleU: { min: 0.44, max: 0.56 },
  scaleD: { min: 0.44, max: 0.56 },
  vacU: Array.from({ length: BIN_N }, () => 0),
  vacD: Array.from({ length: BIN_N }, () => 0),
  pathUp: null,
  pathDn: null,
  upRising: false,
  dnRising: false,
  lastU: 0.5,
  lastD: 0.5,
  distAbovePp: 0,
  distBelowPp: 0,
  gapU: null,
  gapD: null,
  lineSeriesUp: [],
  lineSeriesDown: [],
};

function towardPtb(prev: number, cur: number): boolean {
  const a0 = Math.abs(prev - 0.5);
  const a1 = Math.abs(cur - 0.5);
  return a1 + 1e-9 < a0;
}

function fmtSignedCentsFrom50(p: number): string {
  const d = (p - 0.5) * 100;
  const s = d >= 0 ? '+' : '';
  return `${s}${d.toFixed(1)}¢`;
}

function fmtCents(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

function fmtChartWindowMin(tMin: number, tMax: number): string {
  const m = Math.max(1, Math.round((tMax - tMin) / 60_000));
  if (m < 180) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

function wallNearProb(prob: number, wall: number | null, side: 'above' | 'below'): boolean {
  if (wall == null) return false;
  const d = side === 'above' ? wall - prob : prob - wall;
  return d >= 0 && d <= 0.045;
}

type LaneExecPack = {
  line: number | null;
  setupReady: boolean;
  triggerPill: 'ARMED' | 'PARTIAL' | 'NOT_ARMED';
  triggerReason: string;
  enterOnlyIf: string;
  hintLine: string;
};

function computeLaneExecution(args: {
  lane: 'up' | 'down';
  upLabel: string;
  downLabel: string;
  preMove: {
    up: { pressure: boolean; gapAbove: boolean; trigger: number | null; ready: boolean };
    down: { pressure: boolean; gapAbove: boolean; trigger: number | null; ready: boolean };
    chosen: { lane: 'up' | 'down'; trigger: number } | null;
  };
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  lastU: number;
  lastD: number;
}): LaneExecPack {
  const laneTitle = args.lane === 'up' ? args.upLabel : args.downLabel;
  const line = args.lane === 'up' ? args.preMove.up.trigger : args.preMove.down.trigger;
  const setupReady = args.lane === 'up' ? args.preMove.up.ready : args.preMove.down.ready;
  const last = args.lane === 'up' ? args.lastU : args.lastD;
  const eps = 0.0008;
  const throughLine = line != null && last >= line - eps;

  let triggerPill: 'ARMED' | 'PARTIAL' | 'NOT_ARMED' = 'NOT_ARMED';
  let triggerReason = '';
  if (line == null) {
    triggerReason = 'No break level yet (need a bit more candle history).';
  } else if (!setupReady) {
    triggerPill = 'NOT_ARMED';
    triggerReason =
      args.speedLabel === 'SLOW'
        ? `Setup not complete + tape SLOW — if it fires: break ${fmtCents(line)} + tape → FAST`
        : `Setup not complete — arm first: pressure + gap above + break ${fmtCents(line)}; execute with FAST tape`;
  } else if (args.speedLabel === 'SLOW') {
    triggerPill = 'NOT_ARMED';
    triggerReason = `Break ${fmtCents(line)} + tape → FAST (now SLOW)`;
  } else if (args.speedLabel === 'MED') {
    triggerPill = 'PARTIAL';
    triggerReason = `Break ${fmtCents(line)} + FAST tape (now MED — close)`;
  } else {
    triggerPill = 'ARMED';
    triggerReason = throughLine ? 'Through ENTER line — manage / don’t chase blind' : `Break ${fmtCents(line)} with FAST tape`;
  }

  const enterOnlyIf =
    line != null
      ? `ENTER ONLY IF: ${laneTitle} breaks ${fmtCents(line)} with FAST tape`
      : 'ENTER ONLY IF: — (waiting for a clean break level)';

  const pillWord =
    triggerPill === 'ARMED' ? 'ARMED' : triggerPill === 'PARTIAL' ? 'PARTIAL' : 'NOT ARMED';
  const hintLine =
    line != null ? `${laneTitle}: ${pillWord} — break ${fmtCents(line)} + FAST tape` : `${laneTitle}: ${pillWord} — ${triggerReason}`;

  return { line, setupReady, triggerPill, triggerReason, enterOnlyIf, hintLine };
}

function findBestGapBlock(params: {
  vac: number[];
  hiVac: number;
  scaleMin: number;
  scaleMax: number;
  current: number;
  direction: 'up' | 'down';
  isRising: boolean;
  lastBodyFrac: number;
  book: unknown;
}): GapBlock | null {
  const { vac, hiVac, scaleMin, scaleMax, current, direction, isRising, lastBodyFrac, book } = params;
  const n = vac.length;
  const curIdx = bin01(current, n);
  const cut = direction === 'up' ? { lo: curIdx, hi: n - 1 } : { lo: 0, hi: curIdx };
  const seg = contiguousMaxMean(vac, cut.lo, cut.hi);
  if (!seg) return null;
  const len = seg.b - seg.a + 1;
  if (len < GAP_BIN_MIN) return null;
  const mean = seg.mean;
  if (mean < GAP_Q) return null;

  const strengthRaw = (mean / Math.max(1e-9, hiVac)) * (len / n) * 12; // overshoot then clamp
  const strength10 = Math.max(0, Math.min(10, strengthRaw * 10)) / 10;

  const binW = 1 / n;
  const lo = Math.max(0, Math.min(1, (Math.min(seg.a, seg.b) + 0) * binW));
  const hi = Math.max(0, Math.min(1, (Math.max(seg.a, seg.b) + 1) * binW));

  const active = isRising && lastBodyFrac >= 0.36;

  // First wall after gap (share-price ladder): use the book’s side in the direction of the gap.
  // For up-gap (prob rising), resistance is in asks above current.
  // For down-gap (prob falling), support wall is in bids below current.
  let exitWall: number | null = null;
  try {
    const { asks, bids } = pickBookLevels(book);
    if (direction === 'up') {
      for (const l of asks) {
        if (l.price > hi + 1e-9 && l.size >= 1200) {
          exitWall = l.price;
          break;
        }
      }
    } else {
      for (const l of bids) {
        if (l.price < lo - 1e-9 && l.size >= 1200) {
          exitWall = l.price;
          break;
        }
      }
    }
  } catch {
    exitWall = null;
  }

  void scaleMin;
  void scaleMax;
  return { a: seg.a, b: seg.b, strength10, lo, hi, active, exitWall };
}

/**
 * Dual-sided implied-probability OHLC (UP vs DOWN / YES vs NO) around the 50% PTB anchor.
 */
export function PtbDualProbabilityChart(props: {
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  upLabel: string;
  downLabel: string;
  lastUpdateMs: number | null;
  /** SSR underlying PTB (USD) — footnote only */
  priceToBeatUsd?: number | null;
  bookUp?: unknown;
  bookDown?: unknown;
  onGapAutofill?: (g: {
    side: 'up' | 'down';
    entry: number;
    gapLo: number;
    gapHi: number;
    strength10: number;
    exitWall: number | null;
  }) => void;
  onTapProb?: (p: number, ctx?: { lane: 'up' | 'down' }) => void;
  onGapsUpdate?: (g: {
    up: { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;
    down: { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;
    lastUp: number;
    lastDown: number;
  }) => void;
  /** Watch cards: strip analyst chrome, keep a thin regime / gate strip. */
  compactHeader?: boolean;
  /** Optional: localStorage key grouping for PTB Dual playbook samples. */
  playbookSlug?: string;
}): ReactElement | null {
  const {
    probUp,
    probDown,
    upLabel,
    downLabel,
    lastUpdateMs,
    priceToBeatUsd,
    bookUp = {},
    bookDown = {},
    onGapAutofill,
    onTapProb,
    onGapsUpdate,
    compactHeader = false,
    playbookSlug = '',
  } = props;
  const [now, setNow] = useState(() => Date.now());
  const [flowOpen, setFlowOpen] = useState(() =>
    typeof window !== 'undefined' && window.localStorage.getItem('ptbChart.flowOpen') === '0' ? false : true,
  );
  const [detailsOpen, setDetailsOpen] = useState(() =>
    typeof window !== 'undefined' && window.localStorage.getItem('ptbChart.detailsOpen') === '1',
  );
  const [playbookRev, setPlaybookRev] = useState(0);
  /** Previous poll best ask sizes (for consumption proxy in preMove). */
  const lagAskRef = useRef<{ u: number | null; d: number | null }>({ u: null, d: null });
  const lastPlaybookAppendMsRef = useRef(0);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem('ptbChart.flowOpen', flowOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [flowOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('ptbChart.detailsOpen', detailsOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [detailsOpen]);

  useEffect(() => {
    try {
      const u = pickBookLevels(bookUp).asks[0]?.size ?? null;
      const d = pickBookLevels(bookDown).asks[0]?.size ?? null;
      lagAskRef.current = { u, d };
    } catch {
      /* ignore */
    }
  }, [bookUp, bookDown]);

  const model = useMemo((): PtbDualChartModel | null => {
    const u0 = padProbSeries(probUp.map((p) => ({ t: p.t, v: clamp01(p.v) })));
    const d0 = padProbSeries(probDown.map((p) => ({ t: p.t, v: clamp01(p.v) })));
    if (u0.length < 2 || d0.length < 2) return null;
    const tMin = Math.min(u0[0]!.t, d0[0]!.t);
    const tMax = Math.max(u0[u0.length - 1]!.t, d0[d0.length - 1]!.t);
    if (!(tMax > tMin)) return null;

    const candlesUp = buildSpotCandlesInRange(u0, tMin, tMax, BUCKET_N);
    const candlesDn = buildSpotCandlesInRange(d0, tMin, tMax, BUCKET_N);
    if (candlesUp.length === 0 || candlesDn.length === 0) return null;

    const lastU = u0[u0.length - 1]!.v;
    const lastD = d0[d0.length - 1]!.v;

    const uVals = u0.map((p) => p.v);
    const dVals = d0.map((p) => p.v);
    const scaleU = extentSymProb(Math.min(...uVals), Math.max(...uVals));
    const scaleD = extentSymProb(Math.min(...dVals), Math.max(...dVals));

    const gapScoresU = new Array(BIN_N).fill(0);
    const gapScoresD = new Array(BIN_N).fill(0);
    for (const p of u0) {
      gapScoresU[bin01(p.v, BIN_N)]! += 1;
    }
    for (const p of d0) {
      gapScoresD[bin01(p.v, BIN_N)]! += 1;
    }
    const norm = (arr: number[]) => {
      const m = Math.max(1, ...arr);
      return arr.map((x) => x / m);
    };
    const densU = norm(gapScoresU);
    const densD = norm(gapScoresD);
    const vacU = densU.map((d) => 1 - d);
    const vacD = densD.map((d) => 1 - d);

    const iLastU = bin01(lastU, BIN_N);
    const iLastD = bin01(lastD, BIN_N);
    const i50 = bin01(0.5, BIN_N);
    const pathUp = contiguousMaxMean(vacU, iLastU, i50);
    const pathDn = contiguousMaxMean(vacD, iLastD, i50);

    const upRising = candlesUp.length >= 2 && candlesUp[candlesUp.length - 1]!.c > candlesUp[candlesUp.length - 2]!.c;
    const dnRising = candlesDn.length >= 2 && candlesDn[candlesDn.length - 1]!.c > candlesDn[candlesDn.length - 2]!.c;

    const lastBodyU = candlesUp[candlesUp.length - 1]!.bodyFrac;
    const lastBodyD = candlesDn[candlesDn.length - 1]!.bodyFrac;

    const hiU = Math.max(1e-9, ...vacU);
    const hiD = Math.max(1e-9, ...vacD);
    const gapU = findBestGapBlock({
      vac: vacU,
      hiVac: hiU,
      scaleMin: scaleU.min,
      scaleMax: scaleU.max,
      current: lastU,
      direction: lastU >= 0.5 ? 'up' : 'down',
      isRising: upRising,
      lastBodyFrac: lastBodyU,
      book: bookUp,
    });
    const gapD = findBestGapBlock({
      vac: vacD,
      hiVac: hiD,
      scaleMin: scaleD.min,
      scaleMax: scaleD.max,
      current: lastD,
      direction: lastD >= 0.5 ? 'up' : 'down',
      isRising: dnRising,
      lastBodyFrac: lastBodyD,
      book: bookDown,
    });

    const distAbovePp = (lastU - 0.5) * 100;
    const distBelowPp = (lastD - 0.5) * 100;

    const lineSeriesUp = u0.map((p) => ({ t: p.t, v: p.v }));
    const lineSeriesDown = d0.map((p) => ({ t: p.t, v: p.v }));

    return {
      tMin,
      tMax,
      candlesUp,
      candlesDn,
      scaleU,
      scaleD,
      vacU,
      vacD,
      pathUp,
      pathDn,
      upRising,
      dnRising,
      lastU,
      lastD,
      distAbovePp,
      distBelowPp,
      gapU,
      gapD,
      lineSeriesUp,
      lineSeriesDown,
    };
  }, [bookDown, bookUp, probDown, probUp]);

  const m = model ?? DUMMY_CHART_MODEL;
  const {
    tMin,
    tMax,
    candlesUp,
    candlesDn,
    scaleU,
    scaleD,
    vacU,
    vacD,
    upRising,
    dnRising,
    lastU,
    lastD,
    distAbovePp,
    distBelowPp,
    gapU,
    gapD,
    lineSeriesUp,
    lineSeriesDown,
  } = m;

  const engine = useMemo(() => {
    if (!model) return PTB_DECISION_FALLBACK;
    const {
      candlesUp: cu,
      candlesDn: cd,
      pathUp: pu,
      pathDn: pd,
      upRising: ur,
      dnRising: dr,
      lastU: lu,
      lastD: ld,
      distAbovePp: dap,
      distBelowPp: dbp,
      gapU: gu,
      gapD: gd,
    } = m;
    const tailU = cu.slice(-6);
    const tailD = cd.slice(-6);
    const agg = (arr: SpotCandle[]) => {
      if (arr.length === 0) return 0;
      return (
        arr.reduce((s, c) => s + clamp01(c.bodyFrac) * Math.sqrt(Math.max(0, c.rangeUsd)), 0) / Math.max(1, arr.length)
      );
    };
    const speedScore01 = clamp(Math.max(agg(tailU), agg(tailD)) / 0.9, 0, 1);
    const speedLabel = speedScore01 < 0.34 ? 'SLOW' : speedScore01 < 0.7 ? 'MED' : 'FAST';
    const pathUpActive = pu != null && pu.mean >= GAP_Q && ur && lu >= 0.48;
    const pathDnActive = pd != null && pd.mean >= GAP_Q && dr && ld >= 0.48;
    const micro = computeProbMicrostructure({
      candlesUp: cu,
      candlesDn: cd,
      lastU: lu,
      lastD: ld,
      upRising: ur,
      dnRising: dr,
      gapU: gu,
      gapD: gd,
    });
    return computePtbSystemDecision({
      lastU: lu,
      lastD: ld,
      distAbovePp: dap,
      distBelowPp: dbp,
      upRising: ur,
      dnRising: dr,
      speedLabel,
      speedScore01,
      gapU: gu,
      gapD: gd,
      pathUpActive,
      pathDnActive,
      micro,
    });
  }, [m, model]);

  const ptbGapEvidence = useMemo((): { k: string; v: string } | null => {
    if (!model) return null;
    const prevU = m.candlesUp.length >= 2 ? m.candlesUp[m.candlesUp.length - 2]!.c : null;
    const prevD = m.candlesDn.length >= 2 ? m.candlesDn[m.candlesDn.length - 2]!.c : null;
    const dist = (p: number) => Math.abs(p - 0.5) * 100;
    const du = dist(m.lastU);
    const dd = dist(m.lastD);
    const dpu = prevU != null ? dist(prevU) : du;
    const dpd = prevD != null ? dist(prevD) : dd;
    const chu = du - dpu;
    const chd = dd - dpd;

    const trend = (c: number) => (c > 1.0 ? 'expanding' : c < -1.0 ? 'collapsing' : 'stall');
    const tu = trend(chu);
    const td = trend(chd);

    // Active side = faster expansion; tie → farther from 50¢.
    const activeLane: 'up' | 'down' =
      Math.abs(chu - chd) >= 0.8 ? (chu >= chd ? 'up' : 'down') : du >= dd ? 'up' : 'down';
    const sideLabel = activeLane === 'up' ? upLabel : downLabel;
    const now = activeLane === 'up' ? m.lastU : m.lastD;
    const nowDist = dist(now);
    const ch = activeLane === 'up' ? chu : chd;
    const tr = activeLane === 'up' ? tu : td;
    const s = ch >= 0 ? '+' : '';

    return {
      k: 'PTB gap',
      v: `${sideLabel} ${nowDist.toFixed(1)}¢ · ${tr} (${s}${ch.toFixed(1)}¢) · ${engine.tapeSpeedLabel}`,
    };
  }, [engine.tapeSpeedLabel, m, model, upLabel, downLabel]);

  const evidence = useMemo(() => {
    if (!ptbGapEvidence) return engine.evidence;
    return [ptbGapEvidence, ...engine.evidence];
  }, [engine.evidence, ptbGapEvidence]);


  useEffect(() => {
    if (!onGapsUpdate || !model) return;
    const { gapU, gapD, lastU, lastD } = model;
    onGapsUpdate({
      up: gapU ? { lo: gapU.lo, hi: gapU.hi, strength10: gapU.strength10, active: gapU.active, exitWall: gapU.exitWall ?? null } : null,
      down: gapD ? { lo: gapD.lo, hi: gapD.hi, strength10: gapD.strength10, active: gapD.active, exitWall: gapD.exitWall ?? null } : null,
      lastUp: lastU,
      lastDown: lastD,
    });
  }, [model, onGapsUpdate]);

  const width = 680;
  const height = 460;
  const padL = 12;
  const padR = 58;
  const padY = 10;
  const plotW = width - padL - padR;
  const topY0 = padY + 40;
  const plotH = height - topY0 - padY - 12;

  const stale = lastUpdateMs == null || now - lastUpdateMs > 20_000;

  const pathUpActive = engine.pathUpActive;
  const pathDnActive = engine.pathDnActive;
  const speedLabel = engine.tapeSpeedLabel;
  const speedScore01 = engine.tapeSpeedScore01;

  const ptbDynamics = useMemo(() => {
    const u = candlesUp.slice(-6).map((c) => c.c);
    const d = candlesDn.slice(-6).map((c) => c.c);
    const slope = (arr: number[]) => {
      if (arr.length < 2) return 0;
      return (arr[arr.length - 1]! - arr[0]!) / Math.max(1, arr.length - 1);
    };
    const accel = (arr: number[]) => {
      if (arr.length < 4) return 0;
      const mid = Math.floor(arr.length / 2);
      const a = slope(arr.slice(0, mid + 1));
      const b = slope(arr.slice(mid));
      return b - a;
    };
    const uSlope = slope(u);
    const dSlope = slope(d);
    const uAccel = accel(u);
    const dAccel = accel(d);
    const lab = (v: number) => (Math.abs(v) < 0.0015 ? 'flat' : v > 0 ? 'up' : 'down');
    const accelLab = (v: number) => (Math.abs(v) < 0.001 ? 'steady' : v > 0 ? 'speeding' : 'slowing');
    return {
      uSlope,
      dSlope,
      uAccel,
      dAccel,
      uLab: lab(uSlope),
      dLab: lab(dSlope),
      uAccelLab: accelLab(uAccel),
      dAccelLab: accelLab(dAccel),
    };
  }, [candlesDn, candlesUp]);

  const preMove = useMemo(() => {
    const n = 6;
    const tailU = candlesUp.slice(-n);
    const tailD = candlesDn.slice(-n);

    const pressureBuilding = (arr: SpotCandle[]) => {
      if (arr.length < 4) return false;
      const last3 = arr.slice(-3);
      const greens = last3.reduce((s, c) => s + (c.c >= c.o ? 1 : 0), 0);
      const higherLows = last3[2]!.l > last3[1]!.l - 1e-9 && last3[1]!.l > last3[0]!.l - 1e-9;
      const smallRanges = last3.reduce((s, c) => s + c.rangeUsd, 0) / 3 < 0.03; // in prob space this is tiny; just a "not explosive yet" proxy
      const driftUp = last3[2]!.c > last3[0]!.o + 0.006; // ~0.6¢ drift
      const notFastYet = speedLabel !== 'FAST' && speedScore01 < 0.72;
      return greens >= 2 && higherLows && driftUp && notFastYet && smallRanges;
    };

    const triggerLevel = (arr: SpotCandle[]) => {
      const w = arr.slice(-5);
      if (w.length === 0) return null;
      const hi = Math.max(...w.map((c) => c.h));
      // small pad so "break" is unambiguous
      return clamp01(hi + 0.001);
    };

    const gapAbove = (g: GapBlock | null, cur: number) => {
      if (!g) return false;
      return g.hi >= cur + 0.02 && g.lo >= cur - 0.003;
    };

    const prev = lagAskRef.current;
    let currU: number | null = null;
    let currD: number | null = null;
    try {
      currU = pickBookLevels(bookUp).asks[0]?.size ?? null;
      currD = pickBookLevels(bookDown).asks[0]?.size ?? null;
    } catch {
      /* ignore */
    }
    const askEatU =
      prev.u != null && currU != null && prev.u > 0 && (prev.u - currU) / prev.u > 0.22;
    const askEatD =
      prev.d != null && currD != null && prev.d > 0 && (prev.d - currD) / prev.d > 0.22;

    const twoBucketUp = (() => {
      if (tailU.length < 2) return false;
      const a = tailU[tailU.length - 2]!;
      const b = tailU[tailU.length - 1]!;
      return b.c > a.c + 0.003 && b.c >= b.o - 1e-9;
    })();
    const twoBucketDn = (() => {
      if (tailD.length < 2) return false;
      const a = tailD[tailD.length - 2]!;
      const b = tailD[tailD.length - 1]!;
      return b.c > a.c + 0.003 && b.c >= b.o - 1e-9;
    })();

    const biasU = topBookBias01(bookUp);
    const biasD = topBookBias01(bookDown);
    const biasAlignU = biasU != null && biasU > 0.06;
    const alignD = biasD != null && biasD > 0.06;

    const confirmU = askEatU || biasAlignU || twoBucketUp;
    const confirmD = askEatD || alignD || twoBucketDn;

    const uPressure = pressureBuilding(tailU);
    const dPressure = pressureBuilding(tailD);
    const uGapAbove = gapAbove(gapU, lastU);
    const dGapAbove = gapAbove(gapD, lastD);
    const uTrig = triggerLevel(tailU);
    const dTrig = triggerLevel(tailD);

    const uReady = uPressure && uGapAbove && uTrig != null && confirmU;
    const dReady = dPressure && dGapAbove && dTrig != null && confirmD;

    let chosen: { lane: 'up' | 'down'; trigger: number } | null = null;
    if (uReady && dReady) {
      const su = (gapU?.strength10 ?? 0) + (gapU?.active ? 1 : 0);
      const sd = (gapD?.strength10 ?? 0) + (gapD?.active ? 1 : 0);
      chosen = su >= sd ? { lane: 'up', trigger: uTrig! } : { lane: 'down', trigger: dTrig! };
    } else if (uReady) chosen = { lane: 'up', trigger: uTrig! };
    else if (dReady) chosen = { lane: 'down', trigger: dTrig! };

    return {
      up: { pressure: uPressure, gapAbove: uGapAbove, trigger: uTrig, ready: uReady, confirm: confirmU },
      down: { pressure: dPressure, gapAbove: dGapAbove, trigger: dTrig, ready: dReady, confirm: confirmD },
      chosen,
    };
  }, [bookDown, bookUp, candlesDn, candlesUp, gapD, gapU, lastD, lastU, speedLabel, speedScore01]);

  const ptbTarget = useMemo(
    () =>
      computePtbTargetEngine({
        lastU: m.lastU,
        lastD: m.lastD,
        upRising: m.upRising,
        dnRising: m.dnRising,
        gapU: m.gapU,
        gapD: m.gapD,
        speedLabel: engine.tapeSpeedLabel,
        speedScore01: engine.tapeSpeedScore01,
        closesUp: m.candlesUp.map((c) => c.c),
        closesDown: m.candlesDn.map((c) => c.c),
        breakUp: preMove.up.trigger,
        breakDown: preMove.down.trigger,
        pressureUp: preMove.up.pressure,
        pressureDown: preMove.down.pressure,
        bookUp,
        bookDown,
        probMicro: engine.microstructure
          ? { takeoverRisk: engine.microstructure.takeoverRisk, jumpRisk01: engine.microstructure.jumpRisk01 }
          : null,
      }),
    [bookDown, bookUp, engine.microstructure, engine.tapeSpeedLabel, engine.tapeSpeedScore01, m, preMove],
  );

  const chartAccent = ptbTarget.engineLane === 'up' ? 'text-emerald-200' : 'text-rose-200';

  const primaryBook = ptbTarget.engineLane === 'up' ? bookUp : bookDown;
  const nowLaneProb = ptbTarget.engineLane === 'up' ? lastU : lastD;
  const activeGap = ptbTarget.engineLane === 'up' ? gapU : gapD;

  const net4cTradeability = useMemo(
    () =>
      computePtbNet4cRoom({
        book: primaryBook,
        refShares: 100,
        nowProb: nowLaneProb,
        wallProb: ptbTarget.wall01,
        targetHiProb: ptbTarget.hi01,
      }),
    [nowLaneProb, primaryBook, ptbTarget.hi01, ptbTarget.wall01],
  );

  const pathToTarget = useMemo(
    () =>
      computePtbPathToTarget({
        lane: ptbTarget.engineLane,
        nowProb: nowLaneProb,
        next01: ptbTarget.next01,
        lo01: ptbTarget.lo01,
        hi01: ptbTarget.hi01,
        wall01: ptbTarget.wall01,
        gap: activeGap,
        speedLabel,
        speedScore01,
        micro: engine.microstructure,
        wallClearanceCents: net4cTradeability.wallClearanceCents,
      }),
    [
      activeGap,
      engine.microstructure,
      net4cTradeability.wallClearanceCents,
      nowLaneProb,
      ptbTarget.engineLane,
      ptbTarget.hi01,
      ptbTarget.lo01,
      ptbTarget.next01,
      ptbTarget.wall01,
      speedLabel,
      speedScore01,
    ],
  );

  const displayVerdict = useMemo(() => {
    if (net4cTradeability.room === 'NO') return 'WAIT' as const;
    return engine.verdict;
  }, [engine.verdict, net4cTradeability.room]);

  const invalidationShort =
    engine.invalidation[0] != null ? engine.invalidation[0]!.slice(0, 72) + (engine.invalidation[0]!.length > 72 ? '…' : '') : '—';

  const playbookSummary = useMemo(() => summarizePtbDual(loadPtbDualSamples()), [playbookRev]);

  /** Single execution condition: break level + tape speed (kill switch for guessing). */
  const tradeTrigger = useMemo(() => {
    const fallbackLane: 'up' | 'down' =
      engine.highlightGap === 'down'
        ? 'down'
        : engine.highlightGap === 'up'
          ? 'up'
          : lastU > lastD
            ? 'up'
            : lastU < lastD
              ? 'down'
              : 'down';
    const lane = preMove.chosen?.lane ?? fallbackLane;
    const laneTitle = lane === 'up' ? upLabel : downLabel;
    const line =
      preMove.chosen != null ? preMove.chosen.trigger : lane === 'up' ? preMove.up.trigger : preMove.down.trigger;
    const setupReady = preMove.chosen != null;
    const last = lane === 'up' ? lastU : lastD;
    const eps = 0.0008;
    const throughLine = line != null && last >= line - eps;

    let triggerPill: 'ARMED' | 'PARTIAL' | 'NOT_ARMED' = 'NOT_ARMED';
    let triggerReason = '';
    if (line == null) {
      triggerReason = 'No break level yet (need a bit more candle history).';
    } else if (!setupReady) {
      triggerPill = 'NOT_ARMED';
      triggerReason =
        speedLabel === 'SLOW'
          ? `Setup not complete + tape SLOW — if it fires: break ${fmtCents(line)} + tape → FAST`
          : `Setup not complete — arm first: pressure + gap above + break ${fmtCents(line)}; execute with FAST tape`;
    } else if (speedLabel === 'SLOW') {
      triggerPill = 'NOT_ARMED';
      triggerReason = `Break ${fmtCents(line)} + tape → FAST (now SLOW)`;
    } else if (speedLabel === 'MED') {
      triggerPill = 'PARTIAL';
      triggerReason = `Break ${fmtCents(line)} + FAST tape (now MED — close)`;
    } else {
      triggerPill = 'ARMED';
      triggerReason = throughLine ? 'Through ENTER line — manage / don’t chase blind' : `Break ${fmtCents(line)} with FAST tape`;
    }

    const enterOnlyIf =
      line != null
        ? `ENTER ONLY IF: ${laneTitle} breaks ${fmtCents(line)} with FAST tape`
        : 'ENTER ONLY IF: — (waiting for a clean break level)';

    const wallUp = gapU?.exitWall ?? null;
    const wallDn = gapD?.exitWall ?? null;
    let fadeText: string | null = null;
    let fadeWall: number | null = null;
    let fadeLane: 'up' | 'down' | null = null;
    if (wallUp != null && wallNearProb(lastU, wallUp, 'above') && speedLabel === 'SLOW') {
      fadeText = `FADE / SHORT: rejection at ${fmtCents(wallUp)} wall + tape stays SLOW`;
      fadeWall = wallUp;
      fadeLane = 'up';
    } else if (wallDn != null && wallNearProb(lastD, wallDn, 'below') && speedLabel === 'SLOW') {
      fadeText = `FADE / LONG: rejection at ${fmtCents(wallDn)} wall + tape stays SLOW`;
      fadeWall = wallDn;
      fadeLane = 'down';
    }

    return {
      lane,
      laneTitle,
      line,
      setupReady,
      throughLine,
      triggerPill,
      triggerReason,
      enterOnlyIf,
      fadeText,
      fadeWall,
      fadeLane,
    };
  }, [engine.highlightGap, gapD, gapU, lastD, lastU, preMove, speedLabel, upLabel, downLabel]);

  const pairedExec = useMemo(
    () => ({
      up: computeLaneExecution({ lane: 'up', upLabel, downLabel, preMove, speedLabel, lastU, lastD }),
      down: computeLaneExecution({ lane: 'down', upLabel, downLabel, preMove, speedLabel, lastU, lastD }),
    }),
    [preMove, speedLabel, lastU, lastD, upLabel, downLabel],
  );

  useEffect(() => {
    if (!playbookSlug) return;
    const armed = tradeTrigger.triggerPill === 'ARMED';
    if (!armed && displayVerdict !== 'ENTER' && displayVerdict !== 'SCALP') return;
    const t = Date.now();
    if (t - lastPlaybookAppendMsRef.current < 28_000) return;
    lastPlaybookAppendMsRef.current = t;

    const sample = sampleFromPtbEvent({
      slug: playbookSlug,
      verdict: displayVerdict,
      gateArmed: armed,
      room: net4cTradeability.room,
      net4c: net4cTradeability.net4c,
      wallClearanceCents: net4cTradeability.wallClearanceCents,
    });
    appendPtbDualSample(sample);
    setPlaybookRev((x) => x + 1);

    const sampleId = sample.id;
    const b = primaryBook;
    const run = (slot: 'outcome30s' | 'outcome2m') => {
      try {
        const { bids, asks } = pickBookLevels(b);
        const n = estimateNet4cLong({ asks, bids, shares: 100, maxLevels: 18 });
        const payload = { t: Date.now(), ok: n.ok, profitCents: n.net.profitCents };
        updatePtbDualSampleById(sampleId, slot === 'outcome30s' ? { outcome30s: payload } : { outcome2m: payload });
        setPlaybookRev((x) => x + 1);
      } catch {
        /* ignore */
      }
    };
    window.setTimeout(() => run('outcome30s'), 30_000);
    window.setTimeout(() => run('outcome2m'), 120_000);
  }, [
    playbookSlug,
    tradeTrigger.triggerPill,
    displayVerdict,
    net4cTradeability.room,
    net4cTradeability.net4c,
    net4cTradeability.wallClearanceCents,
    primaryBook,
  ]);

  const counterCase = useMemo(() => {
    if (lastU > lastD + 0.02) {
      return `If you only trade momentum: ${downLabel} still needs its break + FAST tape before ${upLabel} is the only valid lane.`;
    }
    if (lastD > lastU + 0.02) {
      return `If you only trade momentum: ${upLabel} still needs its break + FAST tape before ${downLabel} is the only valid lane.`;
    }
    return `Mids are tight (${upLabel} ${fmtPct(lastU)} · ${downLabel} ${fmtPct(lastD)}) — arm one lane; don’t size only off the louder ticker.`;
  }, [lastU, lastD, upLabel, downLabel]);

  const counterEnter = useMemo(() => {
    const primary = tradeTrigger.lane;
    const other: 'up' | 'down' = primary === 'up' ? 'down' : 'up';
    const oline = other === 'up' ? preMove.up.trigger : preMove.down.trigger;
    if (oline == null) return null;
    const pline = tradeTrigger.line;
    if (pline != null && Math.abs(oline - pline) < 0.004) return null;
    return { lane: other, line: oline };
  }, [preMove.down.trigger, preMove.up.trigger, tradeTrigger.lane, tradeTrigger.line]);

  // Live cross-side meter: Up pushing while Down reverts to PTB (and vice versa).
  const liveMeter = useMemo(() => {
    const uPrev = candlesUp.length >= 2 ? candlesUp[candlesUp.length - 2]!.c : null;
    const dPrev = candlesDn.length >= 2 ? candlesDn[candlesDn.length - 2]!.c : null;
    const uCur = candlesUp.length ? candlesUp[candlesUp.length - 1]!.c : null;
    const dCur = candlesDn.length ? candlesDn[candlesDn.length - 1]!.c : null;
    if (uPrev == null || dPrev == null || uCur == null || dCur == null) return { kind: 'none' as const, label: '—', strong: false };

    const du = uCur - uPrev;
    const dd = dCur - dPrev;
    const upUp = du >= 0.0065; // ~0.65¢/bucket
    const dnUp = dd >= 0.0065;
    const upToward = towardPtb(uPrev, uCur);
    const dnToward = towardPtb(dPrev, dCur);

    const last3U = candlesUp.slice(-3);
    const last3D = candlesDn.slice(-3);
    const consecUp = (arr: SpotCandle[]) => {
      if (arr.length < 3) return { ok: false, pop: 0 };
      const a = arr[arr.length - 3]!;
      const b = arr[arr.length - 2]!;
      const c = arr[arr.length - 1]!;
      const pop = c.c - a.o;
      const greens = (b.c >= b.o ? 1 : 0) + (c.c >= c.o ? 1 : 0);
      const higherHighs = c.h > b.h + 1e-9 && b.h > a.h + 1e-9;
      const risingCloses = c.c > b.c + 1e-9 && b.c > a.c + 1e-9;
      return { ok: (greens >= 2 && (higherHighs || risingCloses)) || pop >= 0.02, pop };
    };
    const uMove = consecUp(last3U);
    const dMove = consecUp(last3D);
    const upLaneRising = uMove.ok || upUp;
    const downLaneLifting = dMove.ok || dnUp;

    // Unified “something is moving up now” alert.
    if (upLaneRising || downLaneLifting) {
      const strong = (uMove.pop + dMove.pop) >= 0.03 || speedLabel === 'FAST';
      return {
        kind: 'up_move' as const,
        label: 'UP MOVE DETECTED',
        strong,
        upLaneRising,
        downLaneLifting,
      };
    }

    if (upUp && dnToward) {
      const strong = du >= 0.012 || speedLabel === 'FAST';
      return { kind: 'up_impulse' as const, label: 'UP ↑ + DOWN → PTB', strong };
    }
    if (dnUp && upToward) {
      const strong = dd >= 0.012 || speedLabel === 'FAST';
      return { kind: 'down_impulse' as const, label: 'DOWN ↑ + UP → PTB', strong };
    }
    return { kind: 'none' as const, label: 'Neutral', strong: false };
  }, [candlesDn, candlesUp, speedLabel]);

  const chips = [
    `State: neutral`,
    `Δ50: ${upLabel} ${fmtPpSigned(distAbovePp)} · ${downLabel} ${fmtPpSigned(distBelowPp)}`,
    upRising ? `${upLabel} rising` : `${upLabel} flat/down`,
    dnRising ? `${downLabel} rising` : `${downLabel} flat/down`,
    pathUpActive ? 'Vacuum lane: UP' : null,
    pathDnActive ? 'Vacuum lane: DOWN' : null,
    engine.microstructure
      ? `Micro: jump ${(engine.microstructure.jumpRisk01 * 100).toFixed(0)}% · takeover ${engine.microstructure.takeoverRisk}${engine.microstructure.bothLegsChaotic ? ' · 2-sided spike' : ''}`
      : null,
    stale ? 'stale' : 'live',
  ].filter(Boolean) as string[];

  const gapChip = (g: GapBlock | null, side: 'up' | 'down') => {
    if (!g) return null;
    const label = `Gap ${Math.round(g.lo * 100)}–${Math.round(g.hi * 100)}¢ · ${g.strength10.toFixed(1)}/10`;
    const cls =
      side === 'up'
        ? g.active
          ? 'border-emerald-500/40 bg-emerald-950/25 text-emerald-200'
          : 'border-emerald-900/35 bg-emerald-950/10 text-emerald-200/75'
        : g.active
          ? 'border-rose-500/40 bg-rose-950/25 text-rose-200'
          : 'border-rose-900/35 bg-rose-950/10 text-rose-200/75';
    return { label, cls };
  };
  const gUp = gapChip(gapU, 'up');
  const gDn = gapChip(gapD, 'down');

  const emitGap = (side: 'up' | 'down', g: GapBlock | null, entryNow: number) => {
    if (!g || !onGapAutofill) return;
    onGapAutofill({ side, entry: entryNow, gapLo: g.lo, gapHi: g.hi, strength10: g.strength10, exitWall: g.exitWall ?? null });
  };

  if (!model) {
    const needData = probUp.length < 1 || probDown.length < 1;
    return (
      <div className="rounded-2xl border border-zinc-800/70 bg-gradient-to-b from-zinc-950 to-zinc-950/80 p-6 shadow-xl ring-1 ring-white/[0.04]">
        <div className="mx-auto max-w-md text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-700/60 bg-zinc-900/60 text-lg text-zinc-500">
            ◔
          </div>
          <h3 className="text-sm font-semibold text-zinc-200">Belief chart not ready</h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {needData ? (
              <>
                Need at least one mid snapshot on <span className="text-zinc-200">both</span> outcomes. Open the{' '}
                <span className="font-medium text-amber-200/90">Book</span> tab and enable chart polling.
              </>
            ) : (
              <>
                Candles are still building from implied mids — keep <span className="font-medium text-amber-200/90">Book</span> polling.
                If this persists, wait for another tick so the time window can widen.
              </>
            )}
          </p>
          <ol className="mt-4 space-y-2 text-left text-[13px] text-zinc-500">
            <li className="flex gap-2">
              <span className="font-mono text-zinc-600">1.</span>
              Book tab → ensure polling is on
            </li>
            <li className="flex gap-2">
              <span className="font-mono text-zinc-600">2.</span>
              Both outcome mids update at least once
            </li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800/70 bg-gradient-to-b from-[#0c0c0f] to-[#08080a] shadow-2xl ring-1 ring-amber-500/20">
      {/* Scan-friendly title row */}
      {!compactHeader ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/70 bg-zinc-900/35 px-4 py-2.5">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Belief vs PTB</h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Window <span className="font-mono text-zinc-400">{fmtChartWindowMin(tMin, tMax)}</span>
              {priceToBeatUsd != null ? (
                <>
                  {' '}
                  · SSR PTB{' '}
                  <span className="font-mono text-amber-200/85">${priceToBeatUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                </>
              ) : null}
            </p>
          </div>
          <div
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${
              stale
                ? 'border-amber-700/45 bg-amber-950/35 text-amber-100/95'
                : 'border-emerald-700/40 bg-emerald-950/30 text-emerald-100/95'
            }`}
            title={lastUpdateMs != null ? `Last book sample ${new Date(lastUpdateMs).toLocaleTimeString()}` : 'No sample time'}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-amber-400' : 'bg-emerald-400'} ${stale ? '' : 'animate-pulse'}`}
              aria-hidden
            />
            {stale ? 'Data stale' : 'Live'}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-end border-b border-zinc-800/70 bg-zinc-900/25 px-3 py-1.5">
          <div
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
              stale ? 'border-amber-800/50 text-amber-200/90' : 'border-emerald-800/50 text-emerald-200/90'
            }`}
          >
            <span className={`h-1 w-1 rounded-full ${stale ? 'bg-amber-400' : 'bg-emerald-400'} ${stale ? '' : 'animate-pulse'}`} />
            {stale ? 'Stale' : 'Live'}
          </div>
        </div>
      )}
      <div className="border-b border-zinc-800/80 px-4 py-3">
        {compactHeader ? (
          <div className="space-y-2">
            <div
              className="rounded-xl border border-zinc-800/70 bg-zinc-950/60 px-2.5 py-2 ring-1 ring-white/[0.04]"
              title={ptbTarget.summaryLine}
            >
              <div className="text-[9px] font-black tracking-wide text-amber-200/90">PTB TARGET ENGINE</div>
              <div className={`mt-1 space-y-0.5 text-[11px] font-bold leading-snug ${chartAccent}`}>
                <div>Side: {ptbTarget.side}</div>
                <div>Now: {ptbTarget.nowLabel}</div>
                <div>Momentum: {ptbTarget.momentum}</div>
                <div>Next Target: {ptbTarget.nextTargetLabel}</div>
                <div>Target Range: {ptbTarget.targetRangeLabel}</div>
                <div>First Wall: {ptbTarget.firstWallLabel}</div>
                <div>Reversal Risk: {ptbTarget.reversalRisk}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/50 pt-2">
              <div className="flex flex-wrap gap-1.5">
                <span
                  className={`rounded-lg border px-2 py-0.5 text-[9px] font-black ${
                    displayVerdict === 'ENTER'
                      ? 'border-emerald-500/50 text-emerald-200'
                      : displayVerdict === 'SCALP'
                        ? 'border-amber-500/45 text-amber-100'
                        : 'border-zinc-700 text-zinc-300'
                  }`}
                >
                  {displayVerdict === 'ENTER' ? 'ENTER' : displayVerdict === 'SCALP' ? 'SCALP' : 'WAIT'}
                </span>
                <span className="rounded-lg border border-zinc-700 px-2 py-0.5 font-mono text-[9px] text-zinc-400">
                  +4¢{' '}
                  <span
                    className={
                      net4cTradeability.room === 'YES' ? 'text-emerald-300' : net4cTradeability.room === 'MARGINAL' ? 'text-amber-200' : 'text-rose-300'
                    }
                  >
                    {net4cTradeability.room}
                  </span>
                </span>
                <span className="rounded-lg border border-zinc-700 px-2 py-0.5 font-mono text-[9px] text-zinc-400">
                  Gate{' '}
                  {tradeTrigger.triggerPill === 'ARMED' ? 'ARMED' : tradeTrigger.triggerPill === 'PARTIAL' ? 'PARTIAL' : 'OFF'}
                </span>
              </div>
            </div>
            <p className="text-[9px] leading-snug text-zinc-600">{tradeTrigger.enterOnlyIf}</p>
          </div>
        ) : (
          <>
            <div
              className="rounded-2xl border border-zinc-700/55 bg-gradient-to-br from-zinc-900/85 via-zinc-950/80 to-black/50 px-3 py-2.5 ring-1 ring-white/[0.05]"
              title={ptbTarget.summaryLine}
            >
              <div className="text-[10px] font-black tracking-wide text-amber-200/95">PTB TARGET ENGINE</div>
              <div className={`mt-1 font-mono text-[12px] font-bold leading-snug ${chartAccent}`}>
                {ptbTarget.side} · now {ptbTarget.nowLabel} · mom {ptbTarget.momentum} · next {ptbTarget.nextTargetLabel} · range{' '}
                {ptbTarget.targetRangeLabel} · wall {ptbTarget.firstWallLabel} · rev {ptbTarget.reversalRisk}
              </div>
            </div>

            <p className="mt-2 text-[9px] leading-snug text-zinc-600">{engine.regimeSubtitle}</p>

            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-xl border border-zinc-800/70 bg-zinc-950/55 px-3 py-2.5 text-[10px] leading-tight text-zinc-200">
              <span className="font-semibold text-zinc-500">Lane</span>
              <span className="font-mono font-bold text-zinc-100">{ptbTarget.engineLane === 'up' ? upLabel : downLabel}</span>
              <span className="text-zinc-600">·</span>
              <span className="font-semibold text-zinc-500">Disposition</span>
              <span
                className={`font-black ${
                  displayVerdict === 'ENTER' ? 'text-emerald-300' : displayVerdict === 'SCALP' ? 'text-amber-200' : 'text-zinc-300'
                }`}
              >
                {displayVerdict}
                {tradeTrigger.triggerPill === 'ARMED' && displayVerdict !== 'ENTER' ? (
                  <span className="ml-1 font-mono text-[9px] font-semibold text-emerald-400/90">· gate ARMED</span>
                ) : null}
              </span>
              <span className="text-zinc-600">·</span>
              <span className="font-semibold text-zinc-500">Enter line</span>
              <span className="font-mono text-zinc-100">{tradeTrigger.line != null ? fmtCents(tradeTrigger.line) : '—'}</span>
              <span className="text-zinc-600">·</span>
              <span className="font-semibold text-zinc-500">Wall</span>
              <span className="font-mono text-zinc-100">{ptbTarget.firstWallLabel}</span>
              <span className="text-zinc-600">·</span>
              <span className="font-semibold text-zinc-500">Net +4¢</span>
              <span
                className={`font-mono font-bold ${
                  net4cTradeability.room === 'YES' ? 'text-emerald-300' : net4cTradeability.room === 'MARGINAL' ? 'text-amber-200' : 'text-rose-300'
                }`}
              >
                {net4cTradeability.room}
              </span>
              <span className="text-zinc-600">·</span>
              <span className="font-semibold text-zinc-500">Invalidate</span>
              <span className="min-w-0 max-w-[16rem] truncate font-mono text-[9px] text-zinc-400" title={engine.invalidation[0]}>
                {invalidationShort}
              </span>
            </div>

            {engine.enterBlockReason === 'dual_lane_tight' ? (
              <p className="mt-2 text-[11px] font-bold text-amber-200">WAIT FOR BREAK — both lanes competitive; ENTER suppressed.</p>
            ) : null}
            {net4cTradeability.room === 'NO' ? (
              <p className="mt-2 text-[11px] font-semibold text-rose-200/90">
                Tradeability veto: {net4cTradeability.detail}
              </p>
            ) : null}

            <div className="mt-2 rounded-lg border border-zinc-800/60 bg-black/25 px-3 py-2 text-[10px] text-zinc-300">
              <span className="font-semibold text-zinc-500">Path · </span>
              Desired ~{pathToTarget.desiredLabel} · Reach{' '}
              <span className="font-bold text-zinc-100">{pathToTarget.reach}</span> ·{' '}
              <span className="font-mono text-zinc-400">{pathToTarget.pathSketch.join(' → ')}</span>
              <div className="mt-1 text-[9px] text-zinc-500">{pathToTarget.line}</div>
            </div>

            {playbookSlug ? (
              <div className="mt-2 text-[9px] text-zinc-500">
                PTB Dual log: n={playbookSummary.n} · armed/edge samples {playbookSummary.armedOrEnter}
                {playbookSummary.hit4cRate != null ? (
                  <span> · 30s ok-rate ~{(playbookSummary.hit4cRate * 100).toFixed(0)}%</span>
                ) : null}
              </div>
            ) : null}

            <details className="group mt-3 overflow-hidden rounded-xl border border-amber-500/30 bg-amber-950/10 transition-colors open:border-amber-500/50">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[11px] font-semibold text-amber-100/95 outline-none marker:content-none [&::-webkit-details-marker]:hidden hover:bg-amber-950/20">
                <span className="text-zinc-500 transition-transform duration-200 group-open:rotate-90" aria-hidden>
                  ▸
                </span>
                Trade trigger · paired execution
                <span className="font-normal text-zinc-500">· {tradeTrigger.laneTitle}</span>
              </summary>
              <div className="border-t border-zinc-800/50 px-3 pb-3 pt-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div
                    className={`rounded-xl border px-3 py-2.5 ${
                      tradeTrigger.lane === 'up'
                        ? 'border-amber-400/45 bg-black/25 ring-1 ring-amber-500/25'
                        : 'border-emerald-900/40 bg-emerald-950/10'
                    }`}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/90">{upLabel}</div>
                    <div className="mt-1 text-[11px] font-semibold leading-snug text-zinc-100">{pairedExec.up.hintLine}</div>
                    <div className="mt-1 text-[10px] leading-snug text-zinc-400">{pairedExec.up.enterOnlyIf}</div>
                  </div>
                  <div
                    className={`rounded-xl border px-3 py-2.5 ${
                      tradeTrigger.lane === 'down'
                        ? 'border-amber-400/45 bg-black/25 ring-1 ring-amber-500/25'
                        : 'border-sky-900/40 bg-sky-950/10'
                    }`}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-200/90">{downLabel}</div>
                    <div className="mt-1 text-[11px] font-semibold leading-snug text-zinc-100">{pairedExec.down.hintLine}</div>
                    <div className="mt-1 text-[10px] leading-snug text-zinc-400">{pairedExec.down.enterOnlyIf}</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                  <span className="font-semibold text-zinc-500">{tradeTrigger.laneTitle}: </span>
                  {tradeTrigger.triggerReason}
                </div>
                <p className="mt-2 text-[11px] leading-snug text-zinc-300">{counterCase}</p>
                {engine.balanceNote ? (
                  <p className="mt-1.5 rounded-lg border border-amber-800/35 bg-amber-950/20 px-2 py-1.5 text-[11px] font-semibold text-amber-100/95">
                    {engine.balanceNote}
                  </p>
                ) : null}
                {tradeTrigger.fadeText ? (
                  <div className="mt-2 rounded-xl border border-rose-800/40 bg-rose-950/20 px-2.5 py-2 text-[11px] font-semibold leading-snug text-rose-100/90">
                    <span className="text-[10px] font-black uppercase tracking-wide text-rose-300/90">Fade trigger · </span>
                    {tradeTrigger.fadeText}
                  </div>
                ) : null}
              </div>
            </details>

            <details
              className="group mt-3 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/40 transition-colors open:border-zinc-700/70 open:bg-zinc-950/55"
              open={flowOpen}
              onToggle={(e) => setFlowOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-[12px] font-semibold text-zinc-200 outline-none marker:content-none [&::-webkit-details-marker]:hidden hover:bg-zinc-900/30 focus-visible:ring-2 focus-visible:ring-amber-500/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0f]">
                <span className="text-zinc-500 transition-transform duration-200 group-open:rotate-90" aria-hidden>
                  ▸
                </span>
                <span>Flow & tape</span>
                <span className="font-normal text-zinc-500">· chips, gaps, meter, structure</span>
              </summary>
              <div className="border-t border-zinc-800/50 px-3 pb-3 pt-2">
                <div className="grid gap-2 lg:grid-cols-[1fr_auto] lg:items-start">
                  <div className="flex flex-wrap gap-2">
                    {chips.map((c) => (
                      <span key={c} className="rounded-full border border-zinc-700/55 bg-zinc-900/45 px-2.5 py-1 font-mono text-[10px] text-zinc-300">
                        {c}
                      </span>
                    ))}
                    {gUp ? (
                      <button
                        type="button"
                        onClick={() => emitGap('up', gapU, lastU)}
                        className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${gUp.cls} hover:brightness-110`}
                        title="Autofill calculator from UP gap"
                      >
                        {gUp.label}
                      </button>
                    ) : null}
                    {gDn ? (
                      <button
                        type="button"
                        onClick={() => emitGap('down', gapD, lastD)}
                        className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${gDn.cls} hover:brightness-110`}
                        title="Autofill calculator from DOWN gap"
                      >
                        {gDn.label}
                      </button>
                    ) : null}
                  </div>
                  <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/55 px-3 py-2.5 text-[11px] text-zinc-200 shadow-inner shadow-black/20 ring-1 ring-white/[0.02]">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Tape</div>
                      <div className="rounded-full border border-zinc-800/60 bg-black/20 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                        speed{' '}
                        <span className={speedLabel === 'FAST' ? 'text-emerald-300' : speedLabel === 'MED' ? 'text-amber-200' : 'text-zinc-300'}>
                          {speedLabel}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-900/60">
                      <div
                        className={`h-full ${speedLabel === 'FAST' ? 'bg-emerald-400/80' : speedLabel === 'MED' ? 'bg-amber-300/75' : 'bg-zinc-500/70'}`}
                        style={{ width: `${(speedScore01 * 100).toFixed(0)}%` }}
                      />
                    </div>
                    <div className="mt-2 font-mono text-[10px] text-zinc-500">
                      Edge <span className="text-zinc-200">{engine.edgeScore.toFixed(1)}/10</span>
                    </div>
                    <div className="mt-2 rounded-xl border border-zinc-800/55 bg-black/20 px-2.5 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">PTB dynamics (50¢)</div>
                      <div className="mt-1 grid grid-cols-2 gap-2 font-mono text-[10px] text-zinc-400">
                        <div className="rounded-lg border border-zinc-800/50 bg-zinc-950/30 px-2 py-1.5">
                          <div className="text-emerald-200/90">Up lane</div>
                          <div className="mt-0.5 text-zinc-200">now {fmtSignedCentsFrom50(lastU)}</div>
                          <div className="text-zinc-500">
                            v {(ptbDynamics.uSlope * 100).toFixed(2)}¢/b · {ptbDynamics.uLab} · {ptbDynamics.uAccelLab}
                          </div>
                        </div>
                        <div className="rounded-lg border border-zinc-800/50 bg-zinc-950/30 px-2 py-1.5">
                          <div className="text-sky-200/90">Down lane</div>
                          <div className="mt-0.5 text-zinc-200">now {fmtSignedCentsFrom50(lastD)}</div>
                          <div className="text-zinc-500">
                            v {(ptbDynamics.dSlope * 100).toFixed(2)}¢/b · {ptbDynamics.dLab} · {ptbDynamics.dAccelLab}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 font-mono text-[10px] ${
                          liveMeter.kind === 'up_move'
                            ? 'border-emerald-400/55 bg-emerald-950/25 text-emerald-100'
                            : liveMeter.kind === 'up_impulse'
                              ? 'border-emerald-500/45 bg-emerald-950/25 text-emerald-200'
                              : liveMeter.kind === 'down_impulse'
                                ? 'border-sky-500/45 bg-sky-950/20 text-sky-200'
                                : 'border-zinc-800/55 bg-zinc-950/30 text-zinc-500'
                        } ${liveMeter.strong ? 'animate-pulse' : ''}`}
                        title="Raw movement detection (no bias): lanes moving up now"
                      >
                        {liveMeter.label}
                      </span>
                      {liveMeter.kind !== 'none' ? (
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
                            liveMeter.kind === 'up_move'
                              ? 'border-emerald-300/55 bg-emerald-950/35 text-emerald-100'
                              : liveMeter.kind === 'up_impulse'
                                ? 'border-emerald-400/50 bg-emerald-950/35 text-emerald-100'
                                : 'border-sky-400/50 bg-sky-950/30 text-sky-100'
                          } ${liveMeter.strong ? 'animate-pulse' : ''}`}
                        >
                          ALERT
                        </span>
                      ) : null}
                      {liveMeter.kind === 'up_move' ? (
                        <span className="rounded-full border border-zinc-800/55 bg-zinc-950/30 px-2.5 py-1 font-mono text-[10px] text-zinc-300">
                          Up lane rising {liveMeter.upLaneRising ? '✓' : '—'} · Down lane lifting {liveMeter.downLaneLifting ? '✓' : '—'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="mt-3 rounded-xl border border-zinc-800/55 bg-black/20 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                  <span className="font-semibold text-zinc-500">Structure: </span>
                  {upLabel} pressure {preMove.up.pressure ? '✓' : '—'} gap {preMove.up.gapAbove ? '✓' : '—'} line{' '}
                  {preMove.up.trigger != null ? fmtCents(preMove.up.trigger) : '—'} · confirm {preMove.up.confirm ? '✓' : '—'} · {downLabel} pressure{' '}
                  {preMove.down.pressure ? '✓' : '—'} gap {preMove.down.gapAbove ? '✓' : '—'} line{' '}
                  {preMove.down.trigger != null ? fmtCents(preMove.down.trigger) : '—'} · confirm {preMove.down.confirm ? '✓' : '—'}
                </div>
              </div>
            </details>

            <details
              className="group mt-3 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/40 transition-colors open:border-zinc-700/70 open:bg-zinc-950/55"
              open={detailsOpen}
              onToggle={(e) => setDetailsOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-[12px] font-semibold text-zinc-200 outline-none marker:content-none [&::-webkit-details-marker]:hidden hover:bg-zinc-900/30 focus-visible:ring-2 focus-visible:ring-amber-500/35 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0f]">
                <span className="text-zinc-500 transition-transform duration-200 group-open:rotate-90" aria-hidden>
                  ▸
                </span>
                Why (evidence & invalidation)
              </summary>
              <div className="border-t border-zinc-800/50 px-3 pb-3 pt-3">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-zinc-800/55 bg-black/25 px-3 py-3 ring-1 ring-white/[0.02]">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Market conditions</div>
                    <ul className="mt-2 space-y-1.5 text-[11px] leading-snug text-zinc-300">
                      {evidence.slice(0, 6).map((e) => (
                        <li key={e.k} className="flex gap-2">
                          <span className="shrink-0 text-zinc-500">{e.k}</span>
                          <span className="min-w-0 font-mono text-zinc-200">{e.v}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-indigo-800/40 bg-indigo-950/20 px-3 py-3 ring-1 ring-indigo-500/10">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-indigo-300/90">Why this trade</div>
                      <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-zinc-300">
                        {engine.whyLines.map((line, i) => (
                          <li key={i} className="list-inside list-disc text-zinc-400">
                            <span className="text-zinc-200">{line}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="mt-3 border-t border-zinc-800/50 pt-2 text-[11px] font-semibold leading-snug text-zinc-100">{engine.finalLine}</div>
                    </div>
                    <div className="rounded-2xl border border-rose-900/35 bg-rose-950/15 px-3 py-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-300/90">Invalidation</div>
                      <ul className="mt-1.5 space-y-1 text-[11px] text-rose-100/85">
                        {engine.invalidation.map((x, i) => (
                          <li key={i}>— {x}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-2xl border border-zinc-800/55 bg-black/20 px-3 py-2.5 text-[11px] text-zinc-400">
                      <span className="font-semibold text-zinc-300">Edge score {engine.edgeScore.toFixed(1)}/10</span>
                      <span className="mx-2 text-zinc-600">·</span>
                      <span className="font-mono text-[10px] text-zinc-500">{engine.edgeReasonLines.join(' ')}</span>
                    </div>
                    <div className="text-[11px] leading-relaxed text-zinc-500">
                      <span className="font-semibold text-zinc-400">If / then: </span>
                      {engine.conditionalNote}
                    </div>
                  </div>
                </div>
              </div>
            </details>
          </>
        )}
      </div>

      <div className="min-h-0 w-full space-y-4 overflow-x-auto overflow-y-visible px-1 pb-1 sm:px-2">
        <div className="rounded-xl border border-zinc-800/55 bg-zinc-950/50 p-1.5 shadow-inner shadow-black/30 ring-1 ring-white/[0.03]">
        <PtbUnifiedLineChartSvg
          width={width}
          height={height}
          padL={padL}
          padR={padR}
          padY={padY}
          plotW={plotW}
          plotH={plotH}
          topY0={topY0}
          tMin={tMin}
          tMax={tMax}
          chartLane="up"
          winningLabel={upLabel}
          otherLabel={downLabel}
          scaleMin={scaleU.min}
          scaleMax={scaleU.max}
          lineSeries={lineSeriesUp}
          lastV={lastU}
          gap={gapU}
          vac={vacU}
          vacHi={Math.max(1e-9, ...vacU)}
          pathActive={pathUpActive}
          engine={engine}
          ptbTarget={ptbTarget}
          showTarget={ptbTarget.engineLane === 'up'}
          speedLabel={speedLabel}
          speedScore01={speedScore01}
          tradeTrigger={{
            line: tradeTrigger.line,
            lane: tradeTrigger.lane,
            fadeWall: tradeTrigger.fadeWall,
            fadeLane: tradeTrigger.fadeLane,
          }}
          counterEnter={counterEnter}
          upLabel={upLabel}
          downLabel={downLabel}
          priceToBeatUsd={priceToBeatUsd}
          fmtPct={fmtPct}
          fmtChartWindowMin={fmtChartWindowMin}
          onTapProb={onTapProb}
          emitGap={emitGap}
        />
        </div>

        <div className="rounded-xl border border-zinc-800/55 bg-zinc-950/50 p-1.5 shadow-inner shadow-black/30 ring-1 ring-white/[0.03]">
        <PtbUnifiedLineChartSvg
          width={width}
          height={height}
          padL={padL}
          padR={padR}
          padY={padY}
          plotW={plotW}
          plotH={plotH}
          topY0={topY0}
          tMin={tMin}
          tMax={tMax}
          chartLane="down"
          winningLabel={downLabel}
          otherLabel={upLabel}
          scaleMin={scaleD.min}
          scaleMax={scaleD.max}
          lineSeries={lineSeriesDown}
          lastV={lastD}
          gap={gapD}
          vac={vacD}
          vacHi={Math.max(1e-9, ...vacD)}
          pathActive={pathDnActive}
          engine={engine}
          ptbTarget={ptbTarget}
          showTarget={ptbTarget.engineLane === 'down'}
          speedLabel={speedLabel}
          speedScore01={speedScore01}
          tradeTrigger={{
            line: tradeTrigger.line,
            lane: tradeTrigger.lane,
            fadeWall: tradeTrigger.fadeWall,
            fadeLane: tradeTrigger.fadeLane,
          }}
          counterEnter={counterEnter}
          upLabel={upLabel}
          downLabel={downLabel}
          priceToBeatUsd={priceToBeatUsd}
          fmtPct={fmtPct}
          fmtChartWindowMin={fmtChartWindowMin}
          onTapProb={onTapProb}
          emitGap={emitGap}
        />
        </div>
      </div>

      {!compactHeader ? (
        <div className="border-t border-zinc-800/70 bg-zinc-950/30 px-4 py-4 text-[11px] leading-relaxed text-zinc-400">
          <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
            <div className="min-w-0 text-zinc-300">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Summary</span>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-md px-2 py-0.5 font-black ${
                    engine.verdict === 'ENTER'
                      ? 'bg-emerald-950/55 text-emerald-200'
                      : engine.verdict === 'SCALP'
                        ? 'bg-amber-950/50 text-amber-100'
                        : 'bg-zinc-900/70 text-zinc-300'
                  }`}
                >
                  {engine.verdict === 'ENTER' ? 'ENTER' : engine.verdict === 'SCALP' ? 'SCALP ONLY' : 'WAIT'}
                </span>
                <span className="text-zinc-600">·</span>
                <span>
                  Edge <span className="font-mono font-semibold text-zinc-200">{engine.edgeScore.toFixed(1)}/10</span>
                </span>
              </div>
              <div className="mt-2 text-[11px] leading-relaxed text-zinc-400">{engine.finalLine}</div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-black/25 p-3 lg:max-w-[min(100%,20rem)]">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Chart legend</div>
              <div className="mt-2 flex flex-col gap-1.5">
                <span className="inline-flex items-center gap-2 font-mono text-[10px] text-violet-200/90">
                  <span className="h-2 w-2 rounded-sm bg-violet-500/70" aria-hidden />
                  Violet bands = thin-traded gaps
                </span>
                <span className="inline-flex items-center gap-2 font-mono text-[10px] text-amber-200/85">
                  <span className="h-0.5 w-4 rounded-full bg-amber-400/90" aria-hidden />
                  Gold line = 50¢ PTB anchor
                </span>
                <span className="text-[10px] text-zinc-400">
                  Target callout on <span className="font-medium text-zinc-200">{ptbTarget.engineLane === 'up' ? upLabel : downLabel}</span>{' '}
                  panel
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
