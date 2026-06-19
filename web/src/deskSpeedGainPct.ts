/**
 * Express desk speed layers as % gain vs current spot / mid (trader-readable).
 */

import type { DeskSpeedSnapshot, LayerSpeed } from './deskSpeedLayers';
import { formatProbSpeedPpMin, formatSpotSpeedPerMin } from './deskSpeedLayers';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { PressureTiming } from './pressureTiming';

export function formatPctSigned(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '';
  return `${s}${n.toFixed(decimals)}%`;
}

export function formatCentsFrom01(v01: number): string {
  if (!Number.isFinite(v01)) return '—';
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

export function formatCentsDelta(d01: number): string {
  if (!Number.isFinite(d01)) return '—';
  const c = d01 * 100;
  if (Math.abs(c) < 0.05) return '0¢';
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

/** Live contract move over the pressure window + forward projection (not “you already entered”). */
export type ContractEntryJump = {
  outcomeLabel: string;
  horizonSec: number;
  /** Implied mid at window open (e.g. 46¢ when now is 52¢). */
  entry01: number;
  now01: number;
  gain01: number;
  gainCents: number;
  gainPct: number;
  /** Linear extrapolation of current repricing speed for 1 minute. */
  proj01In1m: number;
  projJumpCentsFromNow1m: number;
  projJumpCentsFromEntry1m: number;
  /** Primary one-liner for the card. */
  headline: string;
  /** Secondary: projection from current print. */
  projLine: string;
};

export function computeContractEntryJump(params: {
  prob: LayerSpeed | null;
  now01: number | null | undefined;
  horizonSec: number;
  outcomeLabel: string;
}): ContractEntryJump | null {
  const { prob, now01, horizonSec, outcomeLabel } = params;
  if (!prob || now01 == null || !Number.isFinite(now01) || now01 < 0.001) return null;

  const entry01 = Math.max(0.001, Math.min(0.999, now01 - prob.delta30));
  const gain01 = now01 - entry01;
  const gainCents = gain01 * 100;
  const gainPct = entry01 > 0.001 ? (gain01 / entry01) * 100 : 0;

  const proj01In1m = Math.max(0.001, Math.min(0.999, now01 + prob.velocityPerSec * 60));
  const projJumpFromNow = (proj01In1m - now01) * 100;
  const projJumpFromEntry = (proj01In1m - entry01) * 100;

  const entryStr = formatCentsFrom01(entry01);
  const nowStr = formatCentsFrom01(now01);
  const gainStr = formatCentsDelta(gain01);
  const pctStr = formatPctSigned(gainPct, 1);

  const headline = `${outcomeLabel} ${entryStr} → ${nowStr} now · ${gainStr} (${pctStr}) over ${horizonSec}s`;

  const projStr = formatCentsDelta(projJumpFromNow / 100);
  const totalFromOpen = formatCentsDelta(projJumpFromEntry / 100);
  const projLine =
    Math.abs(projJumpFromNow) < 0.05
      ? `Now ${nowStr}: repricing flat — little extra ¢ expected in 1m`
      : `Now ${nowStr}: ~${projStr} more in 1m if speed holds → ~${formatCentsFrom01(proj01In1m)} (${totalFromOpen} from ${entryStr} open)`;

  return {
    outcomeLabel,
    horizonSec,
    entry01,
    now01,
    gain01,
    gainCents,
    gainPct,
    proj01In1m,
    projJumpCentsFromNow1m: projJumpFromNow,
    projJumpCentsFromEntry1m: projJumpFromEntry,
    headline,
    projLine,
  };
}

/** Min contract ¢ move before showing the jump readout (filters chop like +1¢ / 30s). */
export const PRESSURE_ENTRY_JUMP_MIN_CENTS = 2.5;

export type PressureEntryJumpDisplay = {
  title: string;
  jump: ContractEntryJump;
  lateNote: string | null;
};

/** Only surface contract jumps worth acting on — not noise or duplicate 30s confirm cards. */
export function resolvePressureEntryJumpDisplay(args: {
  timing: PressureTiming;
  timingNote: string;
  entryJump: ContractEntryJump | null;
  earlyEntryJump: ContractEntryJump | null;
  earlyHorizonSec: number;
  confirmHorizonSec: number;
}): PressureEntryJumpDisplay | null {
  const { timing, timingNote, entryJump, earlyEntryJump, earlyHorizonSec, confirmHorizonSec } = args;

  if (timing === 'CHASING' || timing === 'EXTENDED') {
    if (!entryJump) return null;
    return {
      title: `Too late · ${confirmHorizonSec}s confirm`,
      jump: entryJump,
      lateNote: timingNote,
    };
  }

  const lead = earlyEntryJump;
  if (lead && Math.abs(lead.gainCents) >= PRESSURE_ENTRY_JUMP_MIN_CENTS) {
    return {
      title: `${earlyHorizonSec}s lead · contract ¢`,
      jump: lead,
      lateNote: null,
    };
  }

  if (entryJump && Math.abs(entryJump.gainCents) >= PRESSURE_ENTRY_JUMP_MIN_CENTS + 1) {
    return {
      title: `${confirmHorizonSec}s move · contract ¢`,
      jump: entryJump,
      lateNote: null,
    };
  }

  return null;
}

/** @deprecated UI no longer shows 1m projections — kept for tests. */
export function entryJumpProjLineForTiming(jump: ContractEntryJump, timing: PressureTiming): string {
  const gainStr = formatCentsDelta(jump.gain01);
  const pctStr = formatPctSigned(jump.gainPct, 1);
  if (timing === 'CHASING') {
    return `Too late for fresh entry — ${gainStr} (${pctStr}) already repriced on ${jump.horizonSec}s confirm. Hunt pullback or catch the next 10s lead.`;
  }
  if (timing === 'EXTENDED') {
    return `Confirm window is late — ${gainStr} (${pctStr}) is mostly in. Do not chase the +1m extension; watch 10s pressure instead.`;
  }
  return jump.projLine;
}

export function spotEntryJumpLine(
  spot: LayerSpeed | null,
  nowSpot: number,
  horizonSec: number,
): string | null {
  if (!spot || !Number.isFinite(nowSpot) || Math.abs(nowSpot) < 1e-6) return null;
  const entry = nowSpot - spot.delta30;
  const gainUsd = spot.delta30;
  const pct = (gainUsd / entry) * 100;
  return `Spot $${entry.toLocaleString(undefined, { maximumFractionDigits: 2 })} → $${nowSpot.toLocaleString(undefined, { maximumFractionDigits: 2 })} now · ${gainUsd >= 0 ? '+' : ''}$${Math.abs(gainUsd).toFixed(2)} (${formatPctSigned(pct, 2)}) / ${horizonSec}s`;
}

export function spotSpeedDetailWithGain(
  spot: LayerSpeed,
  nowSpot: number,
  horizonSec: number,
): { detail: string; gainPct: string | null } {
  const abs = formatSpotSpeedPerMin(spot.velocityPerMin);
  if (!Number.isFinite(nowSpot) || Math.abs(nowSpot) < 1e-6) {
    return { detail: abs, gainPct: null };
  }
  const windowPct = (spot.delta30 / nowSpot) * 100;
  const perMinPct = (spot.velocityPerMin / nowSpot) * 100;
  return {
    detail: abs,
    gainPct: `${formatPctSigned(windowPct, 2)} / ${horizonSec}s · ${formatPctSigned(perMinPct, 3)}/min`,
  };
}

export function probSpeedDetailWithGain(
  prob: LayerSpeed,
  pNow01: number | null | undefined,
  horizonSec: number,
): { detail: string; gainPct: string | null } {
  const abs = formatProbSpeedPpMin(prob.velocityPerMin);
  const d30pp = prob.delta30 * 100;
  const ppWindow = `${d30pp >= 0 ? '+' : ''}${d30pp.toFixed(1)}pp / ${horizonSec}s`;
  if (pNow01 == null || !Number.isFinite(pNow01) || pNow01 < 0.001) {
    return { detail: abs, gainPct: ppWindow };
  }
  const vsMidPct = (prob.delta30 / pNow01) * 100;
  return {
    detail: abs,
    gainPct: `${ppWindow} · ${formatPctSigned(vsMidPct, 1)} vs mid`,
  };
}

export function gapDetailWithGain(
  ptb: LayerSpeed,
  speed: DeskSpeedSnapshot,
  nowSpot: number | null | undefined,
): { detail: string; gainPct: string | null } {
  const motion = ptb.ptbGapMotion?.replace(/_/g, ' ') ?? '—';
  if (speed.gapClosurePctPerMin != null && Number.isFinite(speed.gapClosurePctPerMin)) {
    return {
      detail: motion,
      gainPct: `${formatPctSigned(speed.gapClosurePctPerMin, 1)}%/min gap close`,
    };
  }
  const gap = speed.gapNowUsd;
  if (gap != null && nowSpot != null && Number.isFinite(gap) && Number.isFinite(nowSpot) && Math.abs(nowSpot) > 1e-6) {
    const gapPctSpot = (gap / nowSpot) * 100;
    const d30 = ptb.delta30;
    const gapPctWindow =
      Math.abs(gap) > 0.5 ? formatPctSigned((d30 / Math.abs(gap)) * 100, 1) + ` gap / ${speed.horizonSec}s` : null;
    return {
      detail: motion,
      gainPct: gapPctWindow ?? `${formatPctSigned(gapPctSpot, 2)} vs spot`,
    };
  }
  return { detail: motion, gainPct: null };
}

export function mtfDetailWithGain(
  mtf: MtfConsensus | null | undefined,
  lane: 'up' | 'down',
  nowSpot?: number | null,
): { detail: string; gainPct: string | null } {
  if (!mtf) return { detail: '—', gainPct: null };
  const up = mtf.votes.filter((v) => v.vote === 'up' && !v.thin).length;
  const down = mtf.votes.filter((v) => v.vote === 'down' && !v.thin).length;
  const detail = `${up}↑ ${down}↓ · ${mtf.alignedCount}/${mtf.votes.length} ${lane.toUpperCase()}`;
  const ref = mtf.votes.find((v) => v.key === '5m' && !v.thin) ?? mtf.votes.find((v) => !v.thin);
  if (!ref || !Number.isFinite(nowSpot) || Math.abs(nowSpot!) < 1e-6) return { detail, gainPct: null };
  const pctOfSpot = (ref.netUsd / nowSpot!) * 100;
  return { detail, gainPct: `${formatPctSigned(pctOfSpot, 2)} spot / ${ref.key}` };
}

/** One-line summary of active-side 30s gains for the card header. */
export function pressureGainSummaryLine(params: {
  speed: DeskSpeedSnapshot;
  nowSpot: number;
  pMktUp: number | null | undefined;
  pMktDown: number | null | undefined;
  bias: 'BUY' | 'SELL' | 'NEUTRAL';
}): string | null {
  const { speed, nowSpot, pMktUp, pMktDown, bias } = params;
  const spot = speed.spot;
  if (!spot || !Number.isFinite(nowSpot)) return null;
  const parts: string[] = [];
  const windowPct = formatPctSigned((spot.delta30 / nowSpot) * 100, 2);
  parts.push(`spot ${windowPct} / ${speed.horizonSec}s`);

  if (bias !== 'SELL' && speed.lanes.up.prob && pMktUp != null) {
    const u = probSpeedDetailWithGain(speed.lanes.up.prob, pMktUp, speed.horizonSec);
    parts.push(`UP ${u.gainPct ?? '—'}`);
  }
  if (bias !== 'BUY' && speed.lanes.down.prob && pMktDown != null) {
    const d = probSpeedDetailWithGain(speed.lanes.down.prob, pMktDown, speed.horizonSec);
    parts.push(`DOWN ${d.gainPct ?? '—'}`);
  }
  if (speed.gapClosurePctPerMin != null) {
    parts.push(`gap ${formatPctSigned(speed.gapClosurePctPerMin, 1)}%/min`);
  }
  return parts.join(' · ');
}
