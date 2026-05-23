/**
 * Sectional momentum + switch forecaster for long-window Up/Down markets (1h, 4h).
 *
 * The user wants: break the round into fixed N-min sections, see per-section direction,
 * and get an early heads-up when momentum is about to *flip* — so they can decide GO IN /
 * STAY / EXIT before the chart actually crosses PTB.
 *
 * Pure functions only — no React, no I/O, easy to unit-test.
 */

export type Tick = { t: number; v: number };

export type SpotSection = {
  /** Section start (ms epoch). */
  t0: number;
  /** Section end (ms epoch). */
  t1: number;
  /** Open / close prices over the section. */
  o: number;
  c: number;
  h: number;
  l: number;
  /** Net dollar move (close − open). */
  netUsd: number;
  /** USD per minute slope (close − open) / minutes. */
  slopeUsdPerMin: number;
  /** Direction tag for color-coding. */
  direction: 'UP' | 'DOWN' | 'FLAT';
  /** % time spent above the PTB band (0..1). */
  pctAbove: number;
  /** % time spent below the PTB band (0..1). */
  pctBelow: number;
  /** % time spent inside the PTB band (0..1). */
  pctAtPtb: number;
  /** Number of times spot crossed the PTB line during this section. */
  ptbCrosses: number;
  /** |slope| / max|slope| across all sections, 0..1 — for bar opacity / scale. */
  intensity01: number;
};

/**
 * Slice a series of price ticks into fixed-duration sections (e.g. 15 minutes).
 * Sections are anchored to the *latest* tick so the rightmost block is always
 * "last 15m" rather than rounded to wall-clock.
 *
 * `flatBandUsd` defines the dead-zone for FLAT classification (typically `band * 0.6`).
 */
export function buildSpotSections(
  pts: Tick[],
  ptb: number | null | undefined,
  sectionMs: number,
  count: number,
  flatBandUsd: number,
): SpotSection[] {
  if (pts.length < 2 || sectionMs <= 0 || count <= 0) return [];
  const tEnd = pts[pts.length - 1]!.t;
  const tStart = tEnd - sectionMs * count;
  const out: SpotSection[] = [];
  let pIdx = 0;
  while (pIdx < pts.length && pts[pIdx]!.t < tStart) pIdx++;
  for (let s = 0; s < count; s++) {
    const a = tStart + sectionMs * s;
    const z = a + sectionMs;
    while (pIdx < pts.length && pts[pIdx]!.t < a) pIdx++;
    if (pIdx >= pts.length) break;
    if (pts[pIdx]!.t >= z) continue;
    const o = pts[pIdx]!.v;
    let c = o;
    let h = o;
    let l = o;
    let prevV = o;
    let prevT = pts[pIdx]!.t;
    let aboveMs = 0;
    let belowMs = 0;
    let atMs = 0;
    let crosses = 0;
    let prevSide: 'a' | 'b' | 'm' | null =
      ptb == null ? null : prevV > ptb + flatBandUsd ? 'a' : prevV < ptb - flatBandUsd ? 'b' : 'm';
    let j = pIdx;
    while (j < pts.length && pts[j]!.t < z) {
      const v = pts[j]!.v;
      const t = pts[j]!.t;
      c = v;
      if (v > h) h = v;
      if (v < l) l = v;
      if (j > pIdx && ptb != null) {
        const dt = Math.max(0, t - prevT);
        const seg = (prevV + v) / 2;
        if (seg > ptb + flatBandUsd) aboveMs += dt;
        else if (seg < ptb - flatBandUsd) belowMs += dt;
        else atMs += dt;
        const curSide: 'a' | 'b' | 'm' = v > ptb + flatBandUsd ? 'a' : v < ptb - flatBandUsd ? 'b' : 'm';
        if (prevSide && prevSide !== 'm' && curSide !== 'm' && prevSide !== curSide) crosses++;
        prevSide = curSide;
      }
      prevV = v;
      prevT = t;
      j++;
    }
    if (j === pIdx) continue;
    const minutes = Math.max(1 / 60, sectionMs / 60_000);
    const netUsd = c - o;
    const slopeUsdPerMin = netUsd / minutes;
    const totalMs = aboveMs + belowMs + atMs || 1;
    const direction: SpotSection['direction'] =
      Math.abs(netUsd) <= flatBandUsd ? 'FLAT' : netUsd > 0 ? 'UP' : 'DOWN';
    out.push({
      t0: a,
      t1: Math.min(z, tEnd),
      o,
      c,
      h,
      l,
      netUsd,
      slopeUsdPerMin,
      direction,
      pctAbove: aboveMs / totalMs,
      pctBelow: belowMs / totalMs,
      pctAtPtb: atMs / totalMs,
      ptbCrosses: crosses,
      intensity01: 0, // filled below
    });
    pIdx = j;
  }
  // Normalize intensity by the loudest section so colors render proportionally.
  let peak = 0;
  for (const s of out) {
    const m = Math.abs(s.slopeUsdPerMin);
    if (m > peak) peak = m;
  }
  if (peak > 0) for (const s of out) s.intensity01 = Math.min(1, Math.abs(s.slopeUsdPerMin) / peak);
  return out;
}

/**
 * The forecaster's verdict — what to *do right now* based on sectional drift
 * and recent slope. Translates into a banner + toast in the chart.
 */
export type SwitchStatus =
  | 'GO_IN' // enter on the recommended lane now
  | 'STAY_IN' // already in the right lane; ride it
  | 'SWITCH_INCOMING' // momentum inverting — prepare to flip
  | 'EXIT' // your existing lane is invalidated — get out
  | 'WAIT'; // no edge, nothing to do

export type SwitchForecast = {
  status: SwitchStatus;
  /** Lane that currently has control (or null if WAIT). */
  lane: 'up' | 'down' | null;
  /**
   * Net direction of the last ~2 section windows (same basis as the “drift was …” line).
   * Exposed for chart UI; for `SWITCH_INCOMING`, `lane` is set to this so “from” reads correctly.
   */
  driftLane: 'up' | 'down' | null;
  /** When `SWITCH_INCOMING` — the lane the system thinks is taking over. */
  incomingLane: 'up' | 'down' | null;
  /** Confidence tier for the call. */
  confidence: 'HIGH' | 'MED' | 'LOW';
  /** Estimated seconds until the switch crystallizes (only set when `SWITCH_INCOMING`). */
  etaSec: number | null;
  /** 1-line bold headline (4–8 words). */
  headline: string;
  /** 1-line longer reason. */
  reason: string;
  /** Bullet evidence points used by the engine. */
  evidence: string[];
};

/**
 * Blend section drift, recent micro-slope, and the existing primaryCall to project
 * whether we're entering, riding, exiting, or about to flip.
 *
 * Inputs are kept loose so callers don't have to mock the entire chart model.
 */
export function forecastMomentumSwitch(input: {
  sections: SpotSection[];
  /** $/sec slope from `derivedStrip.slopeUsdPerSec` over the latest micro-window. */
  microSlopeUsdPerSec: number | null;
  /** Last spot price (for ETA distance to PTB). */
  spot: number | null;
  ptb: number | null;
  /** Spot noise band ($) — used to gate "significant" inversions. */
  bandUsd: number;
  /** The chart's primaryCall, if available. */
  primaryLane: 'up' | 'down' | null;
  primaryStatus: 'ENTER' | 'PREP' | 'WAIT';
  primaryConfidence: 'HIGH' | 'MED' | 'LOW';
  /** Optional book-flow lift bias: +1 for UP-flow, -1 for DOWN-flow, 0 unknown. */
  flowBias?: -1 | 0 | 1;
  /** Ms until round end — adds a clock line when under ~45m (machine “knows” time pressure). */
  endsInMsRemaining?: number | null;
}): SwitchForecast {
  const { sections, microSlopeUsdPerSec, spot, ptb, bandUsd, primaryLane, primaryStatus, primaryConfidence } = input;
  const flowBias = input.flowBias ?? 0;
  const endsInMsRemaining = input.endsInMsRemaining;

  const evidence: string[] = [];

  if (sections.length === 0 || ptb == null || spot == null || !Number.isFinite(ptb) || !Number.isFinite(spot)) {
    return {
      status: 'WAIT',
      lane: primaryLane,
      driftLane: null,
      incomingLane: null,
      confidence: 'LOW',
      etaSec: null,
      headline: 'WAIT — building context',
      reason: 'Need more sectional + spot data before forecasting a switch.',
      evidence,
    };
  }

  const last = sections[sections.length - 1]!;
  const prior = sections.length >= 2 ? sections[sections.length - 2]! : null;
  const window2 = sections.slice(-2);
  const window4 = sections.slice(-4);

  // --- Establish the section-level "drift" lane (what we've been doing the last few sections) ---
  const driftNet = window2.reduce((s, x) => s + x.netUsd, 0);
  const driftLane: 'up' | 'down' | null =
    Math.abs(driftNet) <= bandUsd * 0.8 ? null : driftNet > 0 ? 'up' : 'down';
  evidence.push(
    `Last ${window2.length} sections net ${driftNet >= 0 ? '+' : ''}${driftNet.toFixed(2)} → ${driftLane ?? 'mixed'}`,
  );

  if (endsInMsRemaining != null && Number.isFinite(endsInMsRemaining) && endsInMsRemaining > 0) {
    const totalSec = Math.max(0, Math.floor(endsInMsRemaining / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    const clock = `${mm}:${String(ss).padStart(2, '0')}`;
    if (endsInMsRemaining <= 8 * 60_000) {
      evidence.push(`Round clock ${clock} — late window; slippage + settlement noise rise fast`);
    } else if (endsInMsRemaining <= 40 * 60_000) {
      evidence.push(`Round clock ~${clock} — plan exits before the bell`);
    }
  }

  // --- Recent micro-slope (e.g. last 30–60s) ---
  const microSign: 'up' | 'down' | 'flat' =
    microSlopeUsdPerSec == null || Math.abs(microSlopeUsdPerSec) < bandUsd / 60
      ? 'flat'
      : microSlopeUsdPerSec > 0
        ? 'up'
        : 'down';
  if (microSlopeUsdPerSec != null) {
    const cents = microSlopeUsdPerSec * 60;
    evidence.push(`Micro slope ${cents >= 0 ? '+' : ''}${cents.toFixed(2)} $/min · ${microSign}`);
  }

  // --- Inversion test: drift one way, micro the other, big enough to matter ---
  const inversion =
    driftLane != null &&
    microSign !== 'flat' &&
    ((driftLane === 'up' && microSign === 'down') || (driftLane === 'down' && microSign === 'up'));
  // Strength of the inversion vs noise (band = 1.0 unit). >= 1.0 = solid, >= 0.5 = early.
  const microMagPerMin = Math.abs(microSlopeUsdPerSec ?? 0) * 60;
  const inversionStrength = bandUsd > 0 ? microMagPerMin / Math.max(bandUsd, 1e-6) : 0;

  // --- Distance to PTB → ETA for switch ---
  const distToPtb = Math.abs(spot - ptb);
  const etaSec =
    microSlopeUsdPerSec != null && Math.abs(microSlopeUsdPerSec) > 1e-6 && distToPtb > 0
      ? Math.max(5, Math.min(900, Math.round(distToPtb / Math.abs(microSlopeUsdPerSec))))
      : null;

  // --- Flow corroboration: book lift agrees with inversion direction? ---
  const flowAligned =
    flowBias === 0
      ? null
      : (microSign === 'up' && flowBias > 0) || (microSign === 'down' && flowBias < 0);
  if (flowAligned === true) evidence.push('Book flow corroborates micro slope.');
  if (flowAligned === false) evidence.push('Book flow disagrees with micro slope (weakens signal).');

  // --- Recent section consistency (are they all leaning the same way?) ---
  const ups = window4.filter((s) => s.direction === 'UP').length;
  const dns = window4.filter((s) => s.direction === 'DOWN').length;
  const consistent = window4.length >= 3 && (ups >= window4.length - 1 || dns >= window4.length - 1);
  if (consistent) {
    const trend =
      ups > dns ? 'UP' : dns > ups ? 'DOWN' : `split (${ups}↑ / ${dns}↓)`;
    evidence.push(`Sections trend ${trend} (${ups}↑ / ${dns}↓ of last ${window4.length})`);
  }

  // --- Build verdict ---
  let status: SwitchStatus = 'WAIT';
  let lane: 'up' | 'down' | null = primaryLane ?? driftLane;
  let incomingLane: 'up' | 'down' | null = null;
  let confidence: 'HIGH' | 'MED' | 'LOW' = 'LOW';
  let headline = 'WAIT — no edge yet';
  let reason = 'Sections are mixed and micro slope is quiet.';

  // STAY_IN — drift + primary + micro all align with the same lane.
  if (
    primaryLane &&
    driftLane === primaryLane &&
    ((primaryLane === 'up' && microSign !== 'down') || (primaryLane === 'down' && microSign !== 'up'))
  ) {
    status = primaryStatus === 'ENTER' && primaryConfidence !== 'LOW' ? 'STAY_IN' : 'GO_IN';
    lane = primaryLane;
    confidence =
      primaryStatus === 'ENTER' && primaryConfidence === 'HIGH'
        ? 'HIGH'
        : primaryStatus === 'ENTER'
          ? 'MED'
          : 'LOW';
    headline =
      status === 'STAY_IN'
        ? `STAY IN ${primaryLane.toUpperCase()} — sections + tape aligned`
        : `GO IN ${primaryLane.toUpperCase()} — sections + tape aligned`;
    reason = `Section drift and micro slope both lean ${primaryLane.toUpperCase()}; ride until structure breaks.`;
  }

  // SWITCH_INCOMING — drift one way, micro flipping the other, with body.
  if (inversion && inversionStrength >= 0.5) {
    incomingLane = microSign === 'up' ? 'up' : 'down';
    status = 'SWITCH_INCOMING';
    lane = driftLane;
    confidence = inversionStrength >= 1.4 && (flowAligned !== false) ? 'HIGH' : inversionStrength >= 0.85 ? 'MED' : 'LOW';
    headline =
      etaSec != null
        ? `SWITCH INCOMING → ${incomingLane.toUpperCase()} (~${etaSec}s)`
        : `SWITCH INCOMING → ${incomingLane.toUpperCase()}`;
    reason =
      `Drift was ${driftLane?.toUpperCase()} but micro slope is now ${microSign.toUpperCase()} (${inversionStrength.toFixed(2)}× band/min)` +
      (etaSec != null ? `; ETA to PTB ≈ ${etaSec}s.` : '.');
    if (flowAligned === true) reason += ' Book flow corroborates.';
  }

  // EXIT — already in a lane that just got invalidated by a strong inversion.
  if (
    primaryLane &&
    inversion &&
    inversionStrength >= 0.85 &&
    primaryLane === driftLane // we were riding the drift; drift is now reversing
  ) {
    status = 'EXIT';
    lane = primaryLane;
    incomingLane = primaryLane === 'up' ? 'down' : 'up';
    confidence = inversionStrength >= 1.4 && flowAligned !== false ? 'HIGH' : 'MED';
    headline = `EXIT ${primaryLane.toUpperCase()} — momentum flipping`;
    reason = `${primaryLane.toUpperCase()} drift is being overrun by ${microSign.toUpperCase()} micro slope (${inversionStrength.toFixed(2)}× band/min). Take profit / cut before the cross.`;
  }

  // GO_IN — primary called WAIT but sections + micro just lined up freshly.
  if (status === 'WAIT' && consistent && microSign !== 'flat') {
    // Strict majority only — `ups >= dns` used to break ties as UP (biased).
    const consensus: 'up' | 'down' | null = ups > dns ? 'up' : dns > ups ? 'down' : null;
    if (
      consensus != null &&
      ((consensus === 'up' && microSign === 'up') || (consensus === 'down' && microSign === 'down'))
    ) {
      status = 'GO_IN';
      lane = consensus;
      confidence = inversionStrength >= 0.6 ? 'MED' : 'LOW';
      headline = `GO IN ${consensus.toUpperCase()} — sections aligning`;
      reason = `Last ${window4.length} sections lean ${consensus.toUpperCase()} and micro slope is matching.`;
    }
  }

  // Final guard: if drift still null and primaryLane null, it's a WAIT no matter what.
  if (lane == null && status !== 'SWITCH_INCOMING') {
    status = 'WAIT';
    headline = 'WAIT — no dominant lane';
    reason = 'Sections are mixed and there is no clear control side yet.';
    confidence = 'LOW';
  }

  // Cap confidence on tiny windows so we never scream HIGH from 1 section.
  if (sections.length < 2 && confidence === 'HIGH') confidence = 'MED';
  if (sections.length < 2 && status !== 'WAIT' && status !== 'GO_IN') {
    // Very short series — keep advisory.
    confidence = 'LOW';
  }

  if (last.ptbCrosses >= 2) {
    evidence.push(`Last section had ${last.ptbCrosses} PTB crosses (chop) — discount confidence.`);
    if (confidence === 'HIGH') confidence = 'MED';
    else if (confidence === 'MED' && status !== 'EXIT') confidence = 'LOW';
  }

  if (prior && Math.abs(last.netUsd) > Math.abs(prior.netUsd) * 1.6 && last.direction !== 'FLAT') {
    evidence.push(`Latest section ${last.direction} body ${(Math.abs(last.netUsd) / Math.max(Math.abs(prior.netUsd), 1e-6)).toFixed(1)}× prior.`);
  }

  return { status, lane, driftLane, incomingLane, confidence, etaSec, headline, reason, evidence };
}

/**
 * Choose a sensible section size given the visible zoom window.
 * Constraint: `sectionMs * count ≈ zoomSec * 1000` so the strip matches the chart window.
 * (Previously returned null below 30m zoom — the whole decision strip vanished on 15m/5m.)
 */
export function pickSectionPlan(zoomSec: number): { sectionMs: number; count: number } | null {
  if (zoomSec < 60) return null;
  if (zoomSec >= 4 * 3600) return { sectionMs: 15 * 60_000, count: 16 };
  if (zoomSec >= 2 * 3600) return { sectionMs: 15 * 60_000, count: 8 };
  if (zoomSec >= 3600) return { sectionMs: 15 * 60_000, count: 4 };
  if (zoomSec >= 30 * 60) return { sectionMs: 5 * 60_000, count: 6 };
  if (zoomSec >= 15 * 60) return { sectionMs: 5 * 60_000, count: 3 };
  if (zoomSec >= 5 * 60) return { sectionMs: 60_000, count: 5 };
  if (zoomSec >= 2 * 60) return { sectionMs: 30_000, count: 4 };
  return { sectionMs: Math.floor((zoomSec * 1000) / 3), count: 3 };
}
