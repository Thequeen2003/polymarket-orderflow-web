/**
 * Probability Lag Monitor (PLM): log P_mkt vs P_model, edge, and repricing capture events.
 */

import { estimateBinaryOutcomeBias } from './binaryOutcomeBias';
import { EDGE_TRADE_THRESHOLD } from './probabilityEdgeScalp';

export type PlmSample = {
  t: number;
  pMkt: number;
  pModel: number;
  /** P_model − P_mkt */
  edge: number;
};

export type PlmRepricingEvent = {
  id: string;
  signalAtMs: number;
  observeAtMs: number;
  leadSec: number;
  edgePp: number;
  pMktAtSignal: number;
  pModelAtSignal: number;
  pMktAtObserve: number;
  repricePp: number;
  /** Market mid moved toward model (≥ min capture pp). */
  caught: boolean;
  replayLine: string;
};

export type PlmLiveStats = {
  sampleCount: number;
  spanSec: number;
  eventCount: number;
  caughtCount: number;
  catchRatePct: number | null;
  medianRepricePp: number | null;
  medianLeadSec: number | null;
  currentEdgePp: number | null;
  maxAbsEdgePp10m: number | null;
};

export const PLM_MAX_SAMPLES = 600;
export const PLM_MIN_EDGE_PP = EDGE_TRADE_THRESHOLD * 100;
export const PLM_CAPTURE_MIN_PP = 2;
export const PLM_OBSERVE_SEC = 30;
export const PLM_PEAK_WINDOW_MS = 12_000;
export const PLM_EVENT_COOLDOWN_MS = 25_000;

function edgePp(edge: number): number {
  return edge * 100;
}

function fmtPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function fmtSec(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function isLocalEdgePeak(samples: PlmSample[], idx: number, halfWindow = 5): boolean {
  const cur = Math.abs(samples[idx]!.edge);
  for (let j = Math.max(0, idx - halfWindow); j <= Math.min(samples.length - 1, idx + halfWindow); j++) {
    if (j === idx) continue;
    if (Math.abs(samples[j]!.edge) > cur) return false;
  }
  return true;
}

function sampleNearTime(samples: PlmSample[], targetMs: number, toleranceMs = 4000): PlmSample | null {
  let best: PlmSample | null = null;
  let bestDt = Infinity;
  for (const s of samples) {
    const dt = Math.abs(s.t - targetMs);
    if (dt < bestDt) {
      bestDt = dt;
      best = s;
    }
  }
  return best != null && bestDt <= toleranceMs ? best : null;
}

export function appendPlmSample(
  samples: PlmSample[],
  sample: PlmSample,
  max = PLM_MAX_SAMPLES,
): PlmSample[] {
  const next = [...samples, sample];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

export function buildPlmReplayLine(params: {
  nowMs: number;
  signalAtMs: number;
  observeAtMs: number;
  edgePp: number;
  repricePp: number;
}): string {
  const agoSignal = Math.round((params.nowMs - params.signalAtMs) / 1000);
  const agoObserve = Math.round((params.nowMs - params.observeAtMs) / 1000);
  return `At T−${agoSignal}s edge was ${fmtPp(params.edgePp)}; by T−${agoObserve}s mid had repriced ${fmtPp(params.repricePp)}`;
}

export function detectPlmRepricingEvents(
  samples: PlmSample[],
  opts?: {
    minEdgePp?: number;
    captureMinPp?: number;
    observeSec?: number;
    cooldownMs?: number;
  },
): PlmRepricingEvent[] {
  if (samples.length < 8) return [];

  const minEdgePp = opts?.minEdgePp ?? PLM_MIN_EDGE_PP;
  const captureMinPp = opts?.captureMinPp ?? PLM_CAPTURE_MIN_PP;
  const observeSec = opts?.observeSec ?? PLM_OBSERVE_SEC;
  const cooldownMs = opts?.cooldownMs ?? PLM_EVENT_COOLDOWN_MS;
  const observeMs = observeSec * 1000;
  const now = samples[samples.length - 1]!.t;

  const events: PlmRepricingEvent[] = [];
  let lastEventAt = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const ePp = edgePp(s.edge);
    if (Math.abs(ePp) < minEdgePp) continue;
    if (!isLocalEdgePeak(samples, i)) continue;
    if (s.t - lastEventAt < cooldownMs) continue;

    const observeTarget = s.t + observeMs;
    if (observeTarget > now - 2000) continue;

    const observed = sampleNearTime(samples, observeTarget, 5000);
    if (!observed) continue;

    const repricePp = edgePp(observed.pMkt - s.pMkt);
    const caught =
      (s.edge > 0 && repricePp >= captureMinPp) || (s.edge < 0 && repricePp <= -captureMinPp);

    const leadSec = (observed.t - s.t) / 1000;
    events.push({
      id: `${s.t}-${ePp.toFixed(1)}`,
      signalAtMs: s.t,
      observeAtMs: observed.t,
      leadSec,
      edgePp: ePp,
      pMktAtSignal: s.pMkt,
      pModelAtSignal: s.pModel,
      pMktAtObserve: observed.pMkt,
      repricePp,
      caught,
      replayLine: buildPlmReplayLine({
        nowMs: now,
        signalAtMs: s.t,
        observeAtMs: observed.t,
        edgePp: ePp,
        repricePp,
      }),
    });
    lastEventAt = s.t;
  }

  return events.slice(-24);
}

export function computePlmLiveStats(
  samples: PlmSample[],
  events: PlmRepricingEvent[],
): PlmLiveStats {
  if (!samples.length) {
    return {
      sampleCount: 0,
      spanSec: 0,
      eventCount: 0,
      caughtCount: 0,
      catchRatePct: null,
      medianRepricePp: null,
      medianLeadSec: null,
      currentEdgePp: null,
      maxAbsEdgePp10m: null,
    };
  }

  const last = samples[samples.length - 1]!;
  const first = samples[0]!;
  const caught = events.filter((e) => e.caught);
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  };

  const window10m = last.t - 600_000;
  const recent = samples.filter((s) => s.t >= window10m);
  const maxAbs = recent.length
    ? Math.max(...recent.map((s) => Math.abs(edgePp(s.edge))))
    : null;

  return {
    sampleCount: samples.length,
    spanSec: Math.max(0, (last.t - first.t) / 1000),
    eventCount: events.length,
    caughtCount: caught.length,
    catchRatePct: events.length ? (caught.length / events.length) * 100 : null,
    medianRepricePp: median(caught.map((e) => Math.abs(e.repricePp))),
    medianLeadSec: median(caught.map((e) => e.leadSec)),
    currentEdgePp: edgePp(last.edge),
    maxAbsEdgePp10m: maxAbs,
  };
}

export function buildPlmSampleInput(params: {
  now: number;
  ptb: number;
  spotPts: { t: number; v: number }[];
  pMkt: number;
  slopeUsdPerSec?: number | null;
  bandUsd?: number | null;
  horizonSec?: number;
  atMs?: number;
}): PlmSample | null {
  const est = estimateBinaryOutcomeBias({
    now: params.now,
    ptb: params.ptb,
    spotPts: params.spotPts,
    pUp01: params.pMkt,
    slopeUsdPerSec: params.slopeUsdPerSec,
    bandUsd: params.bandUsd,
    horizonSec: params.horizonSec ?? 30,
  });
  if (!est) return null;
  const pModel = est.probUp;
  const pMkt = Math.max(0.01, Math.min(0.99, params.pMkt));
  return {
    t: params.atMs ?? Date.now(),
    pMkt,
    pModel,
    edge: pModel - pMkt,
  };
}

/** Sparkline points for edge (pp) over time. */
export function plmEdgeSeries(samples: PlmSample[], maxPoints = 120): { t: number; edgePp: number }[] {
  const tail = samples.slice(-maxPoints);
  return tail.map((s) => ({ t: s.t, edgePp: edgePp(s.edge) }));
}

/** Dual prob series for overlay chart. */
export function plmProbSeries(
  samples: PlmSample[],
  maxPoints = 120,
): { t: number; pMktPct: number; pModelPct: number }[] {
  const tail = samples.slice(-maxPoints);
  return tail.map((s) => ({
    t: s.t,
    pMktPct: s.pMkt * 100,
    pModelPct: s.pModel * 100,
  }));
}

export function plmAgeSec(nowMs: number, atMs: number): number {
  return Math.max(0, (nowMs - atMs) / 1000);
}

export function plmEventAgeLabel(nowMs: number, event: PlmRepricingEvent): string {
  const age = plmAgeSec(nowMs, event.signalAtMs);
  return `${fmtSec(age)} ago`;
}
