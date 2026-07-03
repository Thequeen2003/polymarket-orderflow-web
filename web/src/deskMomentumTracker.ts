/**
 * Tracks outcome mid climb (62 → 67 → 68), desk-TP peak/drop, and lane switch.
 * Desk TP drop *while mid is still near peak* is the leading stall signal.
 */

export type DeskMomentumPhase = 'idle' | 'climbing' | 'fading' | 'stagnating' | 'reversing' | 'switched';

export type DeskMomentumSample = {
  ms: number;
  focusMid01: number;
  liveDeskTp01: number | null;
  upMid01: number | null;
  downMid01: number | null;
};

export type DeskMomentumTrackerState = {
  focusLane: 'up' | 'down' | null;
  samples: DeskMomentumSample[];
};

export type DeskMomentumReadout = {
  phase: DeskMomentumPhase;
  focusLane: 'up' | 'down';
  midTrailCents: number[];
  currentMidCents: number;
  peakMidCents: number;
  givebackMidCents: number;
  deskTpPeakCents: number | null;
  deskTpNowCents: number | null;
  /** Desk TP drop from session peak. */
  deskTpDropCents: number | null;
  /** Desk TP drop since mid was at its peak — leading stall indicator. */
  deskTpLeadDropCents: number | null;
  /** Opposing lane mid gain (¢) since climb started. */
  opposingGainCents: number;
  winningLane: 'up' | 'down' | null;
  climbWinningLane: 'up' | 'down' | null;
  headline: string;
  detail: string;
  severity: 'ok' | 'warn' | 'danger';
  /** 0–100 — higher = more urgent to exit / bank. */
  exitPressure: number;
};

export const DESK_MOMENTUM_MAX_SAMPLES = 56;
export const DESK_MOMENTUM_MIN_SAMPLES = 3;
const MIN_PUSH_MS = 350;
const MIN_PUSH_CENTS = 0.2;

function valid01(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0 && v < 1;
}

function toCents(v01: number): number {
  return Math.round(v01 * 1000) / 10;
}

function opposingLane(lane: 'up' | 'down'): 'up' | 'down' {
  return lane === 'up' ? 'down' : 'up';
}

function opposingMid01(sample: DeskMomentumSample, lane: 'up' | 'down'): number | null {
  const v = lane === 'up' ? sample.downMid01 : sample.upMid01;
  return valid01(v) ? v : null;
}

function winningLaneFromMids(upMid01: number | null, downMid01: number | null): 'up' | 'down' | null {
  if (!valid01(upMid01) || !valid01(downMid01)) {
    if (valid01(upMid01)) return 'up';
    if (valid01(downMid01)) return 'down';
    return null;
  }
  const gap = (upMid01 - downMid01) * 100;
  if (Math.abs(gap) < 1) return null;
  return gap > 0 ? 'up' : 'down';
}

/** Notable highs on the climb — each step ≥ ~0.35¢ above prior trail point. */
export function pivotHighTrailCents(mids01: readonly number[], maxPoints = 6): number[] {
  const valid = mids01.filter(valid01);
  if (!valid.length) return [];
  const trail: number[] = [toCents(valid[0]!)];
  for (let i = 1; i < valid.length; i++) {
    const c = toCents(valid[i]!);
    if (c >= trail[trail.length - 1]! + 0.35) trail.push(c);
  }
  const peak = toCents(Math.max(...valid));
  if (peak > trail[trail.length - 1]! + 0.05) trail.push(peak);
  return trail.slice(-maxPoints);
}

export function createDeskMomentumTracker(focusLane: 'up' | 'down' | null = null): DeskMomentumTrackerState {
  return { focusLane, samples: [] };
}

export function pushDeskMomentumSample(
  state: DeskMomentumTrackerState,
  sample: DeskMomentumSample & { focusLane: 'up' | 'down' },
): DeskMomentumTrackerState {
  if (state.focusLane !== sample.focusLane) {
    state = createDeskMomentumTracker(sample.focusLane);
  }
  if (!valid01(sample.focusMid01)) return state;

  const last = state.samples[state.samples.length - 1];
  if (last) {
    const dt = sample.ms - last.ms;
    const midMove = Math.abs(sample.focusMid01 - last.focusMid01) * 100;
    const tpMove =
      valid01(sample.liveDeskTp01) && valid01(last.liveDeskTp01)
        ? Math.abs(sample.liveDeskTp01 - last.liveDeskTp01) * 100
        : 0;
    if (dt < MIN_PUSH_MS && midMove < MIN_PUSH_CENTS && tpMove < MIN_PUSH_CENTS) {
      return state;
    }
  }

  const samples = [...state.samples, sample].slice(-DESK_MOMENTUM_MAX_SAMPLES);
  return { focusLane: sample.focusLane, samples };
}

function fmtTrail(trail: number[]): string {
  if (!trail.length) return '—';
  return trail.map((c) => c.toFixed(1)).join(' → ');
}

function laneLabel(lane: 'up' | 'down', upLabel: string, downLabel: string): string {
  return lane === 'up' ? upLabel : downLabel;
}

function deskTpAtMidPeak(samples: DeskMomentumSample[], peakMid01: number): number | null {
  let best: number | null = null;
  for (const s of samples) {
    if (Math.abs(s.focusMid01 - peakMid01) <= 0.004 && valid01(s.liveDeskTp01)) {
      best = s.liveDeskTp01;
    }
  }
  if (best != null) return best;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (s.focusMid01 >= peakMid01 - 0.004 && valid01(s.liveDeskTp01)) return s.liveDeskTp01;
  }
  return null;
}

function exitPressureScore(args: {
  phase: DeskMomentumPhase;
  givebackMidCents: number;
  deskTpLeadDropCents: number | null;
  deskTpDropCents: number | null;
  opposingGainCents: number;
  switched: boolean;
}): number {
  let s = 0;
  if (args.phase === 'switched') s += 88;
  else if (args.phase === 'reversing') s += 72;
  else if (args.phase === 'stagnating') s += 48;
  else if (args.phase === 'fading') s += 58;
  else if (args.phase === 'climbing') s += 8;
  if (args.deskTpLeadDropCents != null) s += Math.min(28, args.deskTpLeadDropCents * 8);
  if (args.deskTpDropCents != null) s += Math.min(12, args.deskTpDropCents * 3);
  s += Math.min(18, args.givebackMidCents * 6);
  s += Math.min(14, args.opposingGainCents * 2);
  if (args.switched) s += 10;
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function analyzeDeskMomentum(input: {
  state: DeskMomentumTrackerState;
  upLabel?: string;
  downLabel?: string;
}): DeskMomentumReadout | null {
  const { state } = input;
  const upLabel = input.upLabel ?? 'UP';
  const downLabel = input.downLabel ?? 'DOWN';
  const lane = state.focusLane;
  if (lane == null || state.samples.length < DESK_MOMENTUM_MIN_SAMPLES) return null;

  const samples = state.samples;
  const mids = samples.map((s) => s.focusMid01);
  const last = samples[samples.length - 1]!;
  const first = samples[0]!;
  const currentMidCents = toCents(last.focusMid01);
  const peakMid01 = Math.max(...mids);
  const peakMidCents = toCents(peakMid01);
  const givebackMidCents = Math.max(0, peakMidCents - currentMidCents);

  const deskTps = samples.map((s) => s.liveDeskTp01).filter(valid01);
  const deskTpPeakCents = deskTps.length ? toCents(Math.max(...deskTps)) : null;
  const deskTpNowCents = valid01(last.liveDeskTp01) ? toCents(last.liveDeskTp01) : null;
  const deskTpDropCents =
    deskTpPeakCents != null && deskTpNowCents != null ? Math.max(0, deskTpPeakCents - deskTpNowCents) : null;

  const deskTpAtPeak = deskTpAtMidPeak(samples, peakMid01);
  const deskTpAtPeakCents = deskTpAtPeak != null ? toCents(deskTpAtPeak) : null;
  const deskTpLeadDropCents =
    deskTpAtPeakCents != null && deskTpNowCents != null
      ? Math.max(0, deskTpAtPeakCents - deskTpNowCents)
      : null;

  const midTrailCents = pivotHighTrailCents(mids);
  const trailStr = fmtTrail(midTrailCents);

  const winningLane = winningLaneFromMids(last.upMid01, last.downMid01);
  const climbSlice = samples.slice(0, Math.max(2, Math.floor(samples.length * 0.6)));
  const climbWinningLane =
    climbSlice.length > 0
      ? winningLaneFromMids(
          climbSlice[climbSlice.length - 1]!.upMid01,
          climbSlice[climbSlice.length - 1]!.downMid01,
        ) ?? lane
      : lane;

  const climbGainCents = (peakMid01 - first.focusMid01) * 100;
  const recent = samples.slice(-4);
  const recentGainCents =
    recent.length >= 2 ? (recent[recent.length - 1]!.focusMid01 - recent[0]!.focusMid01) * 100 : 0;

  const oppFirst = opposingMid01(first, lane);
  const oppLast = opposingMid01(last, lane);
  const opposingGainCents =
    oppFirst != null && oppLast != null ? Math.max(0, (oppLast - oppFirst) * 100) : 0;

  const hadClimb = climbGainCents >= 1.5 && midTrailCents.length >= 2;
  const nearPeak = givebackMidCents <= 1.2;
  const deskTpFadingAtPeak =
    nearPeak && deskTpLeadDropCents != null && deskTpLeadDropCents >= 0.7;
  const deskTpStalled = deskTpDropCents != null && deskTpDropCents >= 0.9;
  const midStalled = givebackMidCents >= 0.6 || (nearPeak && recentGainCents <= 0.2);

  const bookFlipped =
    winningLane != null &&
    climbWinningLane != null &&
    winningLane !== climbWinningLane &&
    winningLane !== lane;

  const switched =
    hadClimb &&
    (bookFlipped ||
      (winningLane != null &&
        winningLane !== lane &&
        opposingGainCents >= 2.5 &&
        (deskTpLeadDropCents ?? 0) >= 0.5));

  const reversing =
    hadClimb &&
    !switched &&
    (givebackMidCents >= 1.5 ||
      (recentGainCents <= -0.8 && givebackMidCents >= 0.8) ||
      (deskTpFadingAtPeak && givebackMidCents >= 0.9));

  const stagnating =
    hadClimb &&
    !switched &&
    !reversing &&
    (deskTpFadingAtPeak || (midStalled && deskTpStalled));

  /** Early momentum loss — fires before full stall / climb requirement. */
  const fading =
    !switched &&
    !reversing &&
    !stagnating &&
    (recentGainCents <= -0.45 ||
      (deskTpLeadDropCents != null && deskTpLeadDropCents >= 0.35 && givebackMidCents >= 0.25) ||
      (givebackMidCents >= 0.55 && recentGainCents <= 0.1));

  const deskTpRising =
    deskTpLeadDropCents == null || deskTpLeadDropCents < 0.3;
  const climbing =
    hadClimb &&
    !stagnating &&
    !fading &&
    !reversing &&
    !switched &&
    givebackMidCents < 1 &&
    recentGainCents >= -0.3 &&
    deskTpRising;

  const focusName = laneLabel(lane, upLabel, downLabel);
  const oppName = laneLabel(opposingLane(lane), upLabel, downLabel);
  const winName = winningLane != null ? laneLabel(winningLane, upLabel, downLabel) : oppName;

  let phase: DeskMomentumPhase = 'idle';
  let severity: DeskMomentumReadout['severity'] = 'ok';
  let headline = `${focusName} — ${trailStr}`;
  let detail = `Peak ${peakMidCents.toFixed(1)}¢ · now ${currentMidCents.toFixed(1)}¢`;

  if (switched) {
    phase = 'switched';
    severity = 'danger';
    headline = `Exit ${focusName} — book flipped to ${winName}`;
    detail = `Climbed ${trailStr} then stalled. ${
      deskTpLeadDropCents != null && deskTpLeadDropCents >= 0.5
        ? `Desk TP rolled ${deskTpAtPeakCents!.toFixed(1)} → ${deskTpNowCents!.toFixed(1)}¢ (−${deskTpLeadDropCents.toFixed(1)}¢) before ${winName} took over — sell, don't wait for the old TP.`
        : `${winName} gained ${opposingGainCents.toFixed(1)}¢ sponsorship — take the bid on ${focusName}.`
    }`;
  } else if (reversing) {
    phase = 'reversing';
    severity = 'danger';
    headline = `Bank ${focusName} — ${givebackMidCents.toFixed(1)}¢ off peak ${peakMidCents.toFixed(1)}¢`;
    detail =
      deskTpLeadDropCents != null && deskTpLeadDropCents >= 0.5
        ? `Trail ${trailStr} · desk TP already fell ${deskTpLeadDropCents.toFixed(1)}¢ from the ${peakMidCents.toFixed(1)}¢ high — momentum failed, sell into the bid.`
        : `Trail ${trailStr} · rollover in progress — your TP is unlikely from here.`;
  } else if (fading) {
    phase = 'fading';
    severity = recentGainCents <= -0.5 || (deskTpLeadDropCents ?? 0) >= 0.5 ? 'danger' : 'warn';
    headline =
      deskTpLeadDropCents != null && deskTpLeadDropCents >= 0.35
        ? `Momentum fading — desk TP −${deskTpLeadDropCents.toFixed(1)}¢ @ ${currentMidCents.toFixed(1)}¢`
        : `Momentum fading — ${focusName} slipping (${recentGainCents.toFixed(1)}¢ recent)`;
    detail =
      deskTpAtPeakCents != null && deskTpNowCents != null && deskTpLeadDropCents != null
        ? `Desk TP ${deskTpAtPeakCents.toFixed(1)} → ${deskTpNowCents.toFixed(1)}¢ while tape rolls — TP odds drop fast; bank or tighten now.`
        : `Recent tape −${Math.abs(recentGainCents).toFixed(1)}¢ — don't wait for a full reversal to exit.`;
  } else if (stagnating) {
    phase = 'stagnating';
    severity = 'warn';
    headline = deskTpFadingAtPeak
      ? `Stall ${focusName} — desk TP fading at ${currentMidCents.toFixed(1)}¢`
      : `${focusName} stalling under ${peakMidCents.toFixed(1)}¢ peak`;
    detail =
      deskTpAtPeakCents != null && deskTpNowCents != null && deskTpLeadDropCents != null
        ? `Mid trail ${trailStr} · desk TP ${deskTpAtPeakCents.toFixed(1)} → ${deskTpNowCents.toFixed(1)}¢ (−${deskTpLeadDropCents.toFixed(1)}¢) while price held — classic pre-flip stall; bank or tighten before ${winName} switches.`
        : `Mid trail ${trailStr} · move stopped climbing — don't press for the old target.`;
  } else if (climbing) {
    phase = 'climbing';
    severity = 'ok';
    headline = `Ride ${focusName} — ${trailStr}`;
    detail =
      deskTpNowCents != null
        ? `Desk TP ${deskTpNowCents.toFixed(1)}¢ still supportive · invalidation = desk TP collapse or ${oppName} taking the book.`
        : `Peak ${peakMidCents.toFixed(1)}¢ · structure still pushing.`;
  } else {
    phase = 'idle';
    headline = `${focusName} @ ${currentMidCents.toFixed(1)}¢`;
    detail = midTrailCents.length >= 2 ? `Trail ${trailStr} — building context.` : 'Warming up trail…';
  }

  const exitPressure = exitPressureScore({
    phase,
    givebackMidCents,
    deskTpLeadDropCents,
    deskTpDropCents,
    opposingGainCents,
    switched,
  });

  return {
    phase,
    focusLane: lane,
    midTrailCents,
    currentMidCents,
    peakMidCents,
    givebackMidCents,
    deskTpPeakCents,
    deskTpNowCents,
    deskTpDropCents,
    deskTpLeadDropCents,
    opposingGainCents,
    winningLane,
    climbWinningLane,
    headline,
    detail,
    severity,
    exitPressure,
  };
}
