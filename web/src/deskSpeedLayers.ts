/**
 * Three isolated desk speeds (30s window): spot, PTB gap, probability repricing.
 * Split into UP and DOWN outcome lanes — each with its own v_prob and alignment.
 */

export type SpotTick = { t: number; v: number };
export type ProbTick = { t: number; v: number | null };

export type SpeedDirection = 'UP' | 'DOWN' | 'FLAT';
export type PtbGapMotion = 'TOWARD_PTB' | 'AWAY_PTB' | 'FLAT';
export type SpeedAlignment = 'CONVERGING' | 'TREND_GRIND' | 'CHOP' | 'MIXED';
export type SpeedMode = 'ACCELERATION_IMBALANCE' | 'DECELERATION_PTB' | 'NEUTRAL';
export type LaneSupport = 'TAILWIND' | 'HEADWIND' | 'NEUTRAL';

export type LayerSpeed = {
  id: 'spot' | 'ptbGap' | 'probUp' | 'probDown';
  label: string;
  formula: string;
  velocityPerSec: number;
  velocityPerMin: number;
  delta30: number;
  direction: SpeedDirection;
  ptbGapMotion?: PtbGapMotion;
  interpretation: string;
};

export type OutcomeLaneSpeed = {
  lane: 'up' | 'down';
  label: string;
  prob: LayerSpeed | null;
  spotSupport: LaneSupport;
  spotNote: string;
  ptbSupport: LaneSupport;
  ptbNote: string;
  alignment: SpeedAlignment;
  alignmentNote: string;
  mode: SpeedMode;
  modeNote: string;
  /** + = more tailwinds than headwinds on this lane. */
  supportScore: number;
};

/** Which outcome lane has stronger tailwind alignment (for glance UI). */
export function pickSpeedFavoredLane(speed: DeskSpeedSnapshot): {
  lane: 'up' | 'down' | 'split';
  label: string;
  short: string;
} {
  const u = speed.lanes.up;
  const d = speed.lanes.down;
  const gap = d.supportScore - u.supportScore;
  if (gap >= 2) {
    return {
      lane: 'down',
      label: d.label,
      short: `${d.alignment.replace('_', ' ')} · +${d.supportScore}`,
    };
  }
  if (gap <= -2) {
    return {
      lane: 'up',
      label: u.label,
      short: `${u.alignment.replace('_', ' ')} · +${u.supportScore}`,
    };
  }
  return { lane: 'split', label: 'Mixed', short: 'UP/DOWN speeds split' };
}

export type DeskSpeedSnapshot = {
  horizonSec: number;
  /** Shared spot velocity (same for both outcomes). */
  spot: LayerSpeed | null;
  /** Shared PTB gap velocity (same math; lane interprets differently). */
  ptbGap: LayerSpeed | null;
  gapNowUsd: number | null;
  /** Gap closing speed as % of |gap| per minute (when toward PTB). */
  gapClosurePctPerMin: number | null;
  lanes: { up: OutcomeLaneSpeed; down: OutcomeLaneSpeed };
};

const FLAT_SPOT_USD_PER_SEC = 0.015;
const FLAT_GAP_USD_PER_SEC = 0.012;
const FLAT_PROB_PER_SEC = 0.00008;

function spotAtOrBefore(pts: SpotTick[], targetMs: number): number | null {
  if (!pts.length) return null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    if (p.t <= targetMs && Number.isFinite(p.v)) return p.v;
  }
  return Number.isFinite(pts[0]!.v) ? pts[0]!.v : null;
}

function probAtOrBefore(pts: ProbTick[], targetMs: number): number | null {
  if (!pts.length) return null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    if (p.t <= targetMs && p.v != null && Number.isFinite(p.v)) return p.v;
  }
  for (const p of pts) {
    if (p.v != null && Number.isFinite(p.v)) return p.v;
  }
  return null;
}

export function directionFromDelta(delta: number, flatThreshold: number): SpeedDirection {
  if (!Number.isFinite(delta) || Math.abs(delta) < flatThreshold) return 'FLAT';
  return delta > 0 ? 'UP' : 'DOWN';
}

export function ptbGapMotion(gapNowUsd: number, gapDelta30Usd: number): PtbGapMotion {
  if (!Number.isFinite(gapNowUsd) || !Number.isFinite(gapDelta30Usd)) return 'FLAT';
  if (Math.abs(gapDelta30Usd) < FLAT_GAP_USD_PER_SEC * 30) return 'FLAT';
  const toward =
    (gapNowUsd > 0 && gapDelta30Usd < 0) || (gapNowUsd < 0 && gapDelta30Usd > 0);
  return toward ? 'TOWARD_PTB' : 'AWAY_PTB';
}

function spotLayer(params: {
  now: number;
  past: number | null;
  horizonSec: number;
}): LayerSpeed | null {
  if (params.past == null) return null;
  const delta30 = params.now - params.past;
  const vSec = delta30 / params.horizonSec;
  const dir = directionFromDelta(delta30, FLAT_SPOT_USD_PER_SEC * params.horizonSec);
  return {
    id: 'spot',
    label: 'Spot speed v_spot',
    formula: `(P_t − P_{t−${params.horizonSec}s}) / ${params.horizonSec}s`,
    velocityPerSec: vSec,
    velocityPerMin: vSec * 60,
    delta30,
    direction: dir,
    interpretation:
      dir === 'UP'
        ? 'Spot accelerating up over 30s'
        : dir === 'DOWN'
          ? 'Spot accelerating down over 30s'
          : 'Spot flat — no clear velocity',
  };
}

function ptbGapLayer(params: {
  now: number;
  past: number | null;
  ptb: number;
  horizonSec: number;
}): LayerSpeed | null {
  if (params.past == null) return null;
  const gapNow = params.now - params.ptb;
  const gapPast = params.past - params.ptb;
  const delta30 = gapNow - gapPast;
  const vSec = delta30 / params.horizonSec;
  const motion = ptbGapMotion(gapNow, delta30);
  const dir = directionFromDelta(delta30, FLAT_GAP_USD_PER_SEC * params.horizonSec);
  return {
    id: 'ptbGap',
    label: 'PTB gap speed v_PTB',
    formula: `Δ(P−P_PTB) / ${params.horizonSec}s`,
    velocityPerSec: vSec,
    velocityPerMin: vSec * 60,
    delta30,
    direction: dir,
    ptbGapMotion: motion,
    interpretation:
      motion === 'TOWARD_PTB'
        ? 'Gap closing toward PTB — mean-reversion pressure'
        : motion === 'AWAY_PTB'
          ? 'Gap widening away from PTB — trend / grind'
          : 'PTB gap velocity flat',
  };
}

function probLayerForLane(params: {
  lane: 'up' | 'down';
  now: number;
  past: number | null;
  horizonSec: number;
}): LayerSpeed | null {
  if (params.past == null) return null;
  const delta30 = params.now - params.past;
  const vSec = delta30 / params.horizonSec;
  const dir = directionFromDelta(delta30, FLAT_PROB_PER_SEC * params.horizonSec);
  const ppMin = vSec * 60 * 100;
  const isUp = params.lane === 'up';
  return {
    id: isUp ? 'probUp' : 'probDown',
    label: isUp ? 'v_prob UP mid' : 'v_prob DOWN mid',
    formula: `(P_${isUp ? 'UP' : 'DOWN'},t − P_${isUp ? 'UP' : 'DOWN'},t−${params.horizonSec}s) / ${params.horizonSec}s`,
    velocityPerSec: vSec,
    velocityPerMin: ppMin,
    delta30,
    direction: dir,
    interpretation:
      dir === 'UP'
        ? `${isUp ? 'UP' : 'DOWN'} mid repricing higher`
        : dir === 'DOWN'
          ? `${isUp ? 'UP' : 'DOWN'} mid repricing lower`
          : `${isUp ? 'UP' : 'DOWN'} mid barely moving`,
  };
}

export function spotSupportForLane(lane: 'up' | 'down', spotDir: SpeedDirection): LaneSupport {
  if (spotDir === 'FLAT') return 'NEUTRAL';
  if (lane === 'up') return spotDir === 'UP' ? 'TAILWIND' : 'HEADWIND';
  return spotDir === 'DOWN' ? 'TAILWIND' : 'HEADWIND';
}

export function ptbSupportForLane(
  lane: 'up' | 'down',
  gapNowUsd: number,
  motion: PtbGapMotion,
): { support: LaneSupport; note: string } {
  if (motion === 'FLAT') {
    return { support: 'NEUTRAL', note: 'PTB gap not moving meaningfully' };
  }
  const above = gapNowUsd > 0;
  const below = gapNowUsd < 0;

  if (lane === 'up') {
    if (motion === 'AWAY_PTB' && above) {
      return { support: 'TAILWIND', note: 'Above PTB grinding higher — UP continuation speed' };
    }
    if (motion === 'AWAY_PTB' && below) {
      return { support: 'HEADWIND', note: 'Below PTB grinding lower — DOWN speed dominates' };
    }
    if (motion === 'TOWARD_PTB' && below) {
      return { support: 'TAILWIND', note: 'Below PTB snapping back up toward line — UP recovery speed' };
    }
    if (motion === 'TOWARD_PTB' && above) {
      return { support: 'HEADWIND', note: 'Above PTB fading toward line — UP extension slowing' };
    }
  } else {
    if (motion === 'AWAY_PTB' && below) {
      return { support: 'TAILWIND', note: 'Below PTB grinding lower — DOWN continuation speed' };
    }
    if (motion === 'AWAY_PTB' && above) {
      return { support: 'HEADWIND', note: 'Above PTB grinding higher — UP speed dominates' };
    }
    if (motion === 'TOWARD_PTB' && above) {
      return { support: 'TAILWIND', note: 'Above PTB fading toward line — DOWN mean-revert speed' };
    }
    if (motion === 'TOWARD_PTB' && below) {
      return { support: 'HEADWIND', note: 'Below PTB bouncing toward line — DOWN extension slowing' };
    }
  }
  return { support: 'NEUTRAL', note: 'At PTB — no clear gap-side speed' };
}

export function probSupportForLane(lane: 'up' | 'down', probDir: SpeedDirection): LaneSupport {
  if (probDir === 'FLAT') return 'NEUTRAL';
  return probDir === 'UP' ? 'TAILWIND' : 'HEADWIND';
}

function supportScore(...items: LaneSupport[]): number {
  return items.reduce((s, x) => s + (x === 'TAILWIND' ? 1 : x === 'HEADWIND' ? -1 : 0), 0);
}

export function classifyLaneAlignment(params: {
  lane: 'up' | 'down';
  spot: LayerSpeed;
  ptb: LayerSpeed;
  prob: LayerSpeed | null;
  gapNowUsd: number;
}): { alignment: SpeedAlignment; note: string; mode: SpeedMode; modeNote: string } {
  const spotS = spotSupportForLane(params.lane, params.spot.direction);
  const ptbR = ptbSupportForLane(params.lane, params.gapNowUsd, params.ptb.ptbGapMotion ?? 'FLAT');
  const probS = params.prob ? probSupportForLane(params.lane, params.prob.direction) : 'NEUTRAL';

  const supports = [spotS, ptbR.support, probS];
  const score = supportScore(...supports);
  const tail = supports.filter((s) => s === 'TAILWIND').length;
  const head = supports.filter((s) => s === 'HEADWIND').length;

  const motion = params.ptb.ptbGapMotion ?? 'FLAT';

  let alignment: SpeedAlignment = 'MIXED';
  let note = `${params.lane.toUpperCase()} lane: layers partially agree`;
  if (tail >= 2 && head === 0) {
    alignment = motion === 'AWAY_PTB' ? 'TREND_GRIND' : 'CONVERGING';
    note =
      alignment === 'TREND_GRIND'
        ? `${params.lane.toUpperCase()}: spot + gap + prob speeds aligned for continuation`
        : `${params.lane.toUpperCase()}: speeds aligned for snapback / mean-revert into this side`;
  } else if (head >= 2 && tail === 0) {
    alignment = 'CHOP';
    note = `${params.lane.toUpperCase()}: speeds fighting this outcome — skip or fade`;
  } else if (tail > 0 && head > 0) {
    alignment = 'CHOP';
    note = `${params.lane.toUpperCase()}: mixed tailwind/headwind — chop on this side`;
  }

  let mode: SpeedMode = 'NEUTRAL';
  let modeNote = 'No clear regime for this outcome';
  if (motion === 'AWAY_PTB' && score >= 2) {
    mode = 'ACCELERATION_IMBALANCE';
    modeNote = 'Breakout / trend scalp speed on this side';
  } else if (motion === 'TOWARD_PTB' && score >= 1) {
    mode = 'DECELERATION_PTB';
    modeNote = 'Mean-reversion speed toward PTB on this side';
  }

  return { alignment, note, mode, modeNote };
}

function buildOutcomeLane(params: {
  lane: 'up' | 'down';
  label: string;
  spot: LayerSpeed;
  ptb: LayerSpeed;
  prob: LayerSpeed | null;
  gapNowUsd: number;
}): OutcomeLaneSpeed {
  const spotS = spotSupportForLane(params.lane, params.spot.direction);
  const ptbR = ptbSupportForLane(params.lane, params.gapNowUsd, params.ptb.ptbGapMotion ?? 'FLAT');
  const classified = classifyLaneAlignment({
    lane: params.lane,
    spot: params.spot,
    ptb: params.ptb,
    prob: params.prob,
    gapNowUsd: params.gapNowUsd,
  });

  const spotNote =
    spotS === 'TAILWIND'
      ? `v_spot ${params.spot.direction === 'UP' ? '↑' : '↓'} supports ${params.label}`
      : spotS === 'HEADWIND'
        ? `v_spot ${params.spot.direction === 'UP' ? '↑' : '↓'} fights ${params.label}`
        : 'v_spot flat';

  return {
    lane: params.lane,
    label: params.label,
    prob: params.prob,
    spotSupport: spotS,
    spotNote,
    ptbSupport: ptbR.support,
    ptbNote: ptbR.note,
    ...classified,
    alignmentNote: classified.note,
    modeNote: classified.modeNote,
    supportScore: supportScore(spotS, ptbR.support, params.prob ? probSupportForLane(params.lane, params.prob.direction) : 'NEUTRAL'),
  };
}

/** @deprecated use classifyLaneAlignment — kept for tests */
export function classifySpeedAlignment(layers: LayerSpeed[]): {
  alignment: SpeedAlignment;
  note: string;
  mode: SpeedMode;
  modeNote: string;
} {
  const spot = layers.find((l) => l.id === 'spot');
  const ptb = layers.find((l) => l.id === 'ptbGap');
  if (!spot || !ptb) {
    return { alignment: 'MIXED', note: 'Need spot + PTB', mode: 'NEUTRAL', modeNote: '' };
  }
  return classifyLaneAlignment({
    lane: 'up',
    spot,
    ptb,
    prob: layers.find((l) => l.id === 'probUp' || l.id === 'prob') ?? null,
    gapNowUsd: 0,
  });
}

export function computeDeskSpeedSnapshot(params: {
  spotPts: SpotTick[];
  nowSpot: number;
  ptb: number;
  probUpPts: ProbTick[];
  probDownPts?: ProbTick[];
  pMktUp: number | null;
  pMktDown?: number | null;
  upLabel?: string;
  downLabel?: string;
  horizonSec?: number;
}): DeskSpeedSnapshot | null {
  const { spotPts, nowSpot, ptb } = params;
  if (!Number.isFinite(nowSpot) || !Number.isFinite(ptb) || !spotPts.length) return null;

  const horizonSec = params.horizonSec ?? 30;
  const tNow = spotPts[spotPts.length - 1]!.t;
  const pastSpot = spotAtOrBefore(spotPts, tNow - horizonSec * 1000);

  const spot = spotLayer({ now: nowSpot, past: pastSpot, horizonSec });
  const ptbGap = ptbGapLayer({ now: nowSpot, past: pastSpot, ptb, horizonSec });
  if (!spot || !ptbGap) return null;

  const gapNowUsd = nowSpot - ptb;
  let gapClosurePctPerMin: number | null = null;
  if (ptbGap.ptbGapMotion === 'TOWARD_PTB' && Math.abs(gapNowUsd) > 0.5) {
    const closurePerMin = (-ptbGap.delta30 / Math.abs(gapNowUsd)) * (60 / horizonSec) * 100;
    gapClosurePctPerMin = Number.isFinite(closurePerMin) ? closurePerMin : null;
  }

  const upLabel = params.upLabel ?? 'UP';
  const downLabel = params.downLabel ?? 'DOWN';

  let probUp: LayerSpeed | null = null;
  if (params.pMktUp != null && Number.isFinite(params.pMktUp)) {
    const past = probAtOrBefore(params.probUpPts, tNow - horizonSec * 1000);
    probUp = probLayerForLane({ lane: 'up', now: params.pMktUp, past, horizonSec });
  }

  let probDown: LayerSpeed | null = null;
  const pDown = params.pMktDown;
  if (pDown != null && Number.isFinite(pDown)) {
    const pts = params.probDownPts ?? [];
    const past = probAtOrBefore(pts, tNow - horizonSec * 1000);
    probDown = probLayerForLane({ lane: 'down', now: pDown, past, horizonSec });
  }

  return {
    horizonSec,
    spot,
    ptbGap,
    gapNowUsd,
    gapClosurePctPerMin,
    lanes: {
      up: buildOutcomeLane({
        lane: 'up',
        label: upLabel,
        spot,
        ptb: ptbGap,
        prob: probUp,
        gapNowUsd,
      }),
      down: buildOutcomeLane({
        lane: 'down',
        label: downLabel,
        spot,
        ptb: ptbGap,
        prob: probDown,
        gapNowUsd,
      }),
    },
  };
}

export function formatSpotSpeedPerMin(vPerMin: number): string {
  const s = vPerMin >= 0 ? '+' : '';
  return `${s}$${Math.abs(vPerMin).toFixed(1)}/min`;
}

export function formatProbSpeedPpMin(ppPerMin: number): string {
  const s = ppPerMin >= 0 ? '+' : '';
  return `${s}${Math.abs(ppPerMin).toFixed(2)}pp/min`;
}

export function speedDirectionArrow(dir: SpeedDirection): string {
  if (dir === 'UP') return '↑';
  if (dir === 'DOWN') return '↓';
  return '→';
}

export function laneSupportLabel(s: LaneSupport): string {
  if (s === 'TAILWIND') return 'tailwind';
  if (s === 'HEADWIND') return 'headwind';
  return 'neutral';
}
