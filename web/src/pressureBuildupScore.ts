/**
 * Pressure buildup — measure pre-move conviction before price expansion.
 * Five independent checks (0–5); 3+ = watch, 4 = early entry, 5 = strong setup.
 */

import type { DeskSpeedSnapshot } from './deskSpeedLayers';
import { ptbSupportForLane } from './deskSpeedLayers';
import {
  computeContractEntryJump,
  gapDetailWithGain,
  mtfDetailWithGain,
  pressureGainSummaryLine,
  probSpeedDetailWithGain,
  spotEntryJumpLine,
  spotSpeedDetailWithGain,
  type ContractEntryJump,
} from './deskSpeedGainPct';
import {
  classifyPressureTiming,
  probPressurePointEarly,
  PRESSURE_CONFIRM_HORIZON_SEC,
  PRESSURE_EARLY_HORIZON_SEC,
  spotLedLeadNote,
  type PressureTiming,
  type PressureTimingReadout,
} from './pressureTiming';
import type { MtfConsensus } from './multiTimeframeConsensus';
import { computeContractLeadSignal, type ContractLeadSignal } from './contractLeadSignal';

export {
  PRESSURE_EARLY_HORIZON_SEC,
  PRESSURE_CONFIRM_HORIZON_SEC,
} from './pressureTiming';

export type PressureVerdict = 'NO_TRADE' | 'WATCH' | 'EARLY_ENTRY' | 'STRONG_SETUP';

export type PressureRowId = 'upProb' | 'downProb' | 'spot' | 'gap' | 'mtf';

export type PressureRow = {
  id: PressureRowId;
  label: string;
  point: 0 | 1;
  detail: string;
  /** % gain vs current spot / mid (and window move). */
  gainPct: string | null;
  hitLine: string;
};

export type PressureSideKind = 'BUY' | 'SELL';

export type PressureSide = {
  kind: PressureSideKind;
  score: number;
  max: number;
  rows: PressureRow[];
  /** Lines shown with ✓ when point = 1. */
  bullets: string[];
  interpretation: string;
};

export type PressureBuildupSnapshot = {
  earlyHorizonSec: number;
  confirmHorizonSec: number;
  horizonSec: number;
  buy: PressureSide;
  sell: PressureSide;
  /** Score on early window — use this to act. */
  earlyScore: number;
  /** Score on confirm window — often late / chasing. */
  confirmScore: number;
  timing: PressureTiming;
  timingReadout: PressureTimingReadout;
  leadNote: string | null;
  bias: 'BUY' | 'SELL' | 'NEUTRAL';
  verdict: PressureVerdict;
  headline: string;
  emoji: string;
  scoreLine: string;
  tagline: string;
  gainSummary: string | null;
  entryJump: ContractEntryJump | null;
  /** Same contract jump on the early (10s) window — act here when confirm is late. */
  earlyEntryJump: ContractEntryJump | null;
  spotJumpLine: string | null;
  /** Actionable entry lead — spot-led or pressure-aligned; null when chop/noise. */
  contractLead: ContractLeadSignal | null;
  active: PressureSide;
  confirmActive: PressureSide;
  mtfSummary: string | null;
};

function verdictFromScore(score: number): PressureVerdict {
  if (score >= 5) return 'STRONG_SETUP';
  if (score === 4) return 'EARLY_ENTRY';
  if (score === 3) return 'WATCH';
  return 'NO_TRADE';
}

function headlineFor(
  kind: PressureSideKind,
  verdict: PressureVerdict,
  timing: PressureTiming,
): { headline: string; emoji: string } {
  if (verdict === 'NO_TRADE') return { headline: 'NO TRADE', emoji: '⚫' };
  if (timing === 'CHASING') {
    return {
      headline: kind === 'BUY' ? 'CHASING · UP extended' : 'CHASING · DOWN extended',
      emoji: '🟠',
    };
  }
  if (timing === 'EXTENDED') {
    return {
      headline: kind === 'BUY' ? 'LATE · UP confirming' : 'LATE · DOWN confirming',
      emoji: '🟡',
    };
  }
  const side = kind === 'BUY' ? 'BUY PRESSURE' : 'SELL PRESSURE';
  switch (verdict) {
    case 'STRONG_SETUP':
      return { headline: timing === 'EARLY' ? `EARLY ${side}` : `STRONG ${side}`, emoji: kind === 'BUY' ? '🟢' : '🔴' };
    case 'EARLY_ENTRY':
      return { headline: `EARLY ${side}`, emoji: kind === 'BUY' ? '🟢' : '🔴' };
    case 'WATCH':
      return { headline: `WATCH ${side}`, emoji: '🟡' };
    default:
      return { headline: side, emoji: '⚪' };
  }
}

function capVerdict(score: PressureVerdict, max: PressureTimingReadout['maxVerdict']): PressureVerdict {
  const rank: PressureVerdict[] = ['NO_TRADE', 'WATCH', 'EARLY_ENTRY', 'STRONG_SETUP'];
  const si = rank.indexOf(score);
  const mi = rank.indexOf(max);
  return rank[Math.min(si, mi)]!;
}

function mtfPointBuy(mtf: MtfConsensus | null | undefined): boolean {
  if (!mtf) return false;
  return mtf.dominantLane === 'up' && mtf.alignedCount >= 3 && !mtf.hasConflict;
}

function mtfPointSell(mtf: MtfConsensus | null | undefined): boolean {
  if (!mtf) return false;
  return mtf.dominantLane === 'down' && mtf.alignedCount >= 3 && !mtf.hasConflict;
}

function buildBuyRows(
  speed: DeskSpeedSnapshot,
  ctx: { mtf: MtfConsensus | null | undefined; nowSpot: number; pMktUp: number | null; pMktDown: number | null },
  upLabel: string,
  downLabel: string,
  earlyMode: boolean,
): PressureRow[] {
  const spot = speed.spot;
  const ptb = speed.ptbGap;
  const probUp = speed.lanes.up.prob;
  const probDown = speed.lanes.down.prob;
  const gapNow = speed.gapNowUsd ?? 0;
  const motion = ptb?.ptbGapMotion ?? 'FLAT';
  const gapTailwind = ptbSupportForLane('up', gapNow, motion).support === 'TAILWIND';
  const upProbD = probUp ? probSpeedDetailWithGain(probUp, ctx.pMktUp, speed.horizonSec) : null;
  const downProbD = probDown ? probSpeedDetailWithGain(probDown, ctx.pMktDown, speed.horizonSec) : null;
  const spotD = spot ? spotSpeedDetailWithGain(spot, ctx.nowSpot, speed.horizonSec) : null;
  const gapD = ptb ? gapDetailWithGain(ptb, speed, ctx.nowSpot) : null;
  const mtfD = mtfDetailWithGain(ctx.mtf, 'up', ctx.nowSpot);

  return [
    {
      id: 'upProb',
      label: `${upLabel} probability rising`,
      point: earlyMode
        ? probPressurePointEarly(probUp, 'UP')
          ? 1
          : 0
        : probUp?.direction === 'UP'
          ? 1
          : 0,
      detail: upProbD?.detail ?? '—',
      gainPct: upProbD?.gainPct ?? null,
      hitLine: `${upLabel} probability increasing`,
    },
    {
      id: 'downProb',
      label: `${downLabel} probability falling`,
      point: earlyMode
        ? probPressurePointEarly(probDown, 'DOWN')
          ? 1
          : 0
        : probDown?.direction === 'DOWN'
          ? 1
          : 0,
      detail: downProbD?.detail ?? '—',
      gainPct: downProbD?.gainPct ?? null,
      hitLine: `${downLabel} probability decreasing`,
    },
    {
      id: 'spot',
      label: 'Price acceleration up',
      point: spot?.direction === 'UP' ? 1 : 0,
      detail: spotD?.detail ?? '—',
      gainPct: spotD?.gainPct ?? null,
      hitLine: 'Price accelerating upward',
    },
    {
      id: 'gap',
      label: 'Gap closing toward upside target',
      point: gapTailwind ? 1 : 0,
      detail: gapD?.detail ?? '—',
      gainPct: gapD?.gainPct ?? null,
      hitLine: 'Gap closing toward upside target',
    },
    {
      id: 'mtf',
      label: 'Multi-timeframe UP',
      point: mtfPointBuy(ctx.mtf) ? 1 : 0,
      detail: mtfD.detail,
      gainPct: mtfD.gainPct,
      hitLine: 'Multiple timeframes turning UP',
    },
  ];
}

function buildSellRows(
  speed: DeskSpeedSnapshot,
  ctx: { mtf: MtfConsensus | null | undefined; nowSpot: number; pMktUp: number | null; pMktDown: number | null },
  upLabel: string,
  downLabel: string,
  earlyMode: boolean,
): PressureRow[] {
  const spot = speed.spot;
  const ptb = speed.ptbGap;
  const probUp = speed.lanes.up.prob;
  const probDown = speed.lanes.down.prob;
  const gapNow = speed.gapNowUsd ?? 0;
  const motion = ptb?.ptbGapMotion ?? 'FLAT';
  const gapTailwind = ptbSupportForLane('down', gapNow, motion).support === 'TAILWIND';
  const downProbD = probDown ? probSpeedDetailWithGain(probDown, ctx.pMktDown, speed.horizonSec) : null;
  const upProbD = probUp ? probSpeedDetailWithGain(probUp, ctx.pMktUp, speed.horizonSec) : null;
  const spotD = spot ? spotSpeedDetailWithGain(spot, ctx.nowSpot, speed.horizonSec) : null;
  const gapD = ptb ? gapDetailWithGain(ptb, speed, ctx.nowSpot) : null;
  const mtfD = mtfDetailWithGain(ctx.mtf, 'down', ctx.nowSpot);

  return [
    {
      id: 'downProb',
      label: `${downLabel} probability rising`,
      point: earlyMode
        ? probPressurePointEarly(probDown, 'UP')
          ? 1
          : 0
        : probDown?.direction === 'UP'
          ? 1
          : 0,
      detail: downProbD?.detail ?? '—',
      gainPct: downProbD?.gainPct ?? null,
      hitLine: `${downLabel} probability increasing`,
    },
    {
      id: 'upProb',
      label: `${upLabel} probability falling`,
      point: earlyMode
        ? probPressurePointEarly(probUp, 'DOWN')
          ? 1
          : 0
        : probUp?.direction === 'DOWN'
          ? 1
          : 0,
      detail: upProbD?.detail ?? '—',
      gainPct: upProbD?.gainPct ?? null,
      hitLine: `${upLabel} probability decreasing`,
    },
    {
      id: 'spot',
      label: 'Price acceleration down',
      point: spot?.direction === 'DOWN' ? 1 : 0,
      detail: spotD?.detail ?? '—',
      gainPct: spotD?.gainPct ?? null,
      hitLine: 'Price accelerating downward',
    },
    {
      id: 'gap',
      label: 'Gap closing toward downside target',
      point: gapTailwind ? 1 : 0,
      detail: gapD?.detail ?? '—',
      gainPct: gapD?.gainPct ?? null,
      hitLine: 'Gap closing toward downside target',
    },
    {
      id: 'mtf',
      label: 'Multi-timeframe DOWN',
      point: mtfPointSell(ctx.mtf) ? 1 : 0,
      detail: mtfD.detail,
      gainPct: mtfD.gainPct,
      hitLine: 'Multiple timeframes turning DOWN',
    },
  ];
}

function buildSide(rows: PressureRow[], kind: PressureSideKind): PressureSide {
  const score = rows.reduce((s, r) => s + r.point, 0);
  const bullets = rows.filter((r) => r.point === 1).map((r) => r.hitLine);
  const interpretation =
    kind === 'BUY'
      ? score >= 3
        ? 'Pressure is building. Buyers are gaining control. An upside move may develop before a large price expansion.'
        : 'Buy-side pressure is weak or mixed — wait for more alignment.'
      : score >= 3
        ? 'Pressure is building. Sellers are gaining control. A downside move may develop before a large price expansion.'
        : 'Sell-side pressure is weak or mixed — wait for more alignment.';
  return { kind, score, max: rows.length, rows, bullets, interpretation };
}

export function computePressureBuildup(
  earlySpeed: DeskSpeedSnapshot,
  confirmSpeed: DeskSpeedSnapshot,
  opts?: {
    mtf?: MtfConsensus | null;
    upLabel?: string;
    downLabel?: string;
    nowSpot?: number | null;
    pMktUp?: number | null;
    pMktDown?: number | null;
  },
): PressureBuildupSnapshot {
  const upLabel = opts?.upLabel ?? 'UP';
  const downLabel = opts?.downLabel ?? 'DOWN';
  const mtf = opts?.mtf ?? null;
  const nowSpot = opts?.nowSpot ?? NaN;
  const ctx = {
    mtf,
    nowSpot,
    pMktUp: opts?.pMktUp ?? null,
    pMktDown: opts?.pMktDown ?? null,
  };

  const buyEarly = buildSide(buildBuyRows(earlySpeed, ctx, upLabel, downLabel, true), 'BUY');
  const sellEarly = buildSide(buildSellRows(earlySpeed, ctx, upLabel, downLabel, true), 'SELL');
  const buyConfirm = buildSide(buildBuyRows(confirmSpeed, ctx, upLabel, downLabel, false), 'BUY');
  const sellConfirm = buildSide(buildSellRows(confirmSpeed, ctx, upLabel, downLabel, false), 'SELL');

  let bias: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  if (buyEarly.score > sellEarly.score) bias = 'BUY';
  else if (sellEarly.score > buyEarly.score) bias = 'SELL';

  const active = bias === 'SELL' ? sellEarly : buyEarly;
  const confirmActive = bias === 'SELL' ? sellConfirm : buyConfirm;

  const entryJump =
    bias === 'BUY'
      ? computeContractEntryJump({
          prob: confirmSpeed.lanes.up.prob,
          now01: ctx.pMktUp,
          horizonSec: confirmSpeed.horizonSec,
          outcomeLabel: upLabel,
        })
      : bias === 'SELL'
        ? computeContractEntryJump({
            prob: confirmSpeed.lanes.down.prob,
            now01: ctx.pMktDown,
            horizonSec: confirmSpeed.horizonSec,
            outcomeLabel: downLabel,
          })
        : null;

  const earlyEntryJump =
    bias === 'BUY'
      ? computeContractEntryJump({
          prob: earlySpeed.lanes.up.prob,
          now01: ctx.pMktUp,
          horizonSec: earlySpeed.horizonSec,
          outcomeLabel: upLabel,
        })
      : bias === 'SELL'
        ? computeContractEntryJump({
            prob: earlySpeed.lanes.down.prob,
            now01: ctx.pMktDown,
            horizonSec: earlySpeed.horizonSec,
            outcomeLabel: downLabel,
          })
        : null;

  const timingReadout = classifyPressureTiming({ confirm: confirmSpeed, bias, entryJump });

  let rawVerdict =
    bias === 'NEUTRAL' && buyEarly.score <= 2 && sellEarly.score <= 2
      ? 'NO_TRADE'
      : verdictFromScore(active.score);
  const verdict = capVerdict(rawVerdict, timingReadout.maxVerdict);

  const { headline, emoji } =
    bias === 'NEUTRAL' && verdict === 'NO_TRADE'
      ? { headline: 'NO TRADE', emoji: '⚫' }
      : headlineFor(active.kind, verdict, timingReadout.timing);

  const tagline =
    timingReadout.timing === 'CHASING'
      ? 'Too late for fresh entry on 30s confirm — wait for pullback or the next 10s lead.'
      : timingReadout.timing === 'EXTENDED'
        ? '30s confirm is catching up — most of the move is already in. Use 10s lead next time.'
        : verdict === 'NO_TRADE' || verdict === 'WATCH'
          ? 'Watch 10s pressure — do not wait for full 30s confirm.'
          : '10s pressure lead — act before 30s confirm finishes.';

  const leadNote =
    bias !== 'NEUTRAL' ? spotLedLeadNote(earlySpeed, bias, upLabel, downLabel) : null;

  const biasForSummary: 'BUY' | 'SELL' | 'NEUTRAL' = bias === 'NEUTRAL' ? 'BUY' : bias;
  const gainSummary =
    Number.isFinite(nowSpot) && nowSpot > 0
      ? pressureGainSummaryLine({
          speed: earlySpeed,
          nowSpot,
          pMktUp: ctx.pMktUp,
          pMktDown: ctx.pMktDown,
          bias: biasForSummary,
        })
      : null;

  const spotJumpLine =
    Number.isFinite(nowSpot) && nowSpot > 0
      ? spotEntryJumpLine(confirmSpeed.spot, nowSpot, confirmSpeed.horizonSec)
      : null;

  const draft: PressureBuildupSnapshot = {
    earlyHorizonSec: earlySpeed.horizonSec,
    confirmHorizonSec: confirmSpeed.horizonSec,
    horizonSec: earlySpeed.horizonSec,
    buy: buyEarly,
    sell: sellEarly,
    earlyScore: active.score,
    confirmScore: confirmActive.score,
    timing: timingReadout.timing,
    timingReadout,
    leadNote,
    bias,
    verdict,
    headline,
    emoji,
    scoreLine: `${active.score}/${active.max}`,
    tagline,
    gainSummary,
    entryJump,
    earlyEntryJump,
    spotJumpLine,
    contractLead: null,
    active,
    confirmActive,
    mtfSummary: mtf?.summary ?? null,
  };

  return { ...draft, contractLead: computeContractLeadSignal(draft) };
}

export function pressureBuildupShortLabel(snap: PressureBuildupSnapshot): string {
  const timing =
    snap.timing === 'CHASING' || snap.timing === 'EXTENDED' ? ` · ${snap.timing}` : '';
  return `${snap.emoji} ${snap.headline} · ${snap.earlyHorizonSec}s ${snap.scoreLine}${timing}`;
}
