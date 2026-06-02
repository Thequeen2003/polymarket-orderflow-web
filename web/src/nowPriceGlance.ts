/**
 * One-screen summary for the Now Price Signals desk — scannable without scrolling.
 */

import type { DeskSpeedSnapshot } from './deskSpeedLayers';
import { pickSpeedFavoredLane } from './deskSpeedLayers';
import type { NowPriceBandDistances, SpotBandGlance } from './nowPriceSignals';
import type { FairValueGapReadout, FairValueGapSignalReadout } from './fairValueGap';
import type { ProbabilityEdgeScalp } from './probabilityEdgeScalp';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

export type GlanceTone = 'up' | 'down' | 'flat' | 'warn';

export type NowPriceGlanceSummary = {
  geo: string;
  geoTone: GlanceTone;
  spotLabel: string;
  ptbGapLabel: string;
  tradeCall: string;
  tradeCallTone: GlanceTone;
  tradeDetail: string;
  edgeLabel: string | null;
  modelVsMarket: string | null;
  upMidLabel: string | null;
  downMidLabel: string | null;
  upBreakShort: string;
  downBreakShort: string;
  speedLabel: string | null;
  machineLabel: string | null;
  playbookLabel: string | null;
  bannerLine: string | null;
  fairValueLabel: string | null;
  fairGapLabel: string | null;
  fvgSignalLabel: string | null;
};

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(n: number): string {
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtCents(v01: number): string {
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

function fmtDeltaCents(d01: number): string {
  const c = d01 * 100;
  if (Math.abs(c) < 0.05) return '0¢';
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

function fmtEdgePp(edge: number): string {
  const pp = edge * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function fmtProbPct01(p01: number): string {
  const pct = Math.max(0, Math.min(1, p01)) * 100;
  return pct >= 10 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

function fmtPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function geoTone(geo: NowPriceBandDistances['geo']): GlanceTone {
  if (geo === 'ABOVE') return 'up';
  if (geo === 'BELOW') return 'down';
  return 'warn';
}

function tradeFromScalp(scalp: ProbabilityEdgeScalp, upLabel: string, downLabel: string): {
  call: string;
  tone: GlanceTone;
  detail: string;
} {
  if (scalp.scalpSignal === 'LONG_UP') {
    return { call: `LONG ${upLabel}`, tone: 'up', detail: `Scalp SIG · ${scalp.quality}` };
  }
  if (scalp.scalpSignal === 'LONG_DOWN') {
    return { call: `LONG ${downLabel}`, tone: 'down', detail: `Scalp SIG · ${scalp.quality}` };
  }
  return { call: 'NO TRADE', tone: 'flat', detail: scalp.filteredLabel };
}

function tradeFromMachine(readout: SpotPtbMachineReadout, upLabel: string, downLabel: string): {
  call: string;
  tone: GlanceTone;
  detail: string;
} {
  const lane = readout.focusLane;
  const label = lane === 'up' ? upLabel : lane === 'down' ? downLabel : 'SPLIT';
  const call = lane ? `LEAN ${label}` : 'NO CLEAR LANE';
  const tone: GlanceTone = lane === 'up' ? 'up' : lane === 'down' ? 'down' : 'warn';
  return {
    call,
    tone,
    detail: `${readout.agreementScore}% sensors · ${readout.regime}`,
  };
}

/** Compress band + edge + speed + machine into a trader-first glance block. */
export function buildNowPriceGlanceSummary(params: {
  band: NowPriceBandDistances;
  glance: SpotBandGlance;
  upLabel: string;
  downLabel: string;
  edgeScalp: ProbabilityEdgeScalp | null;
  fairValueGap: FairValueGapReadout | null;
  fvgSignal: FairValueGapSignalReadout | null;
  deskSpeed: DeskSpeedSnapshot | null;
  machineReadout: SpotPtbMachineReadout | null;
  bandGauge: SpotBandGaugeSnapshot | null;
  physicsLine: string | null;
  probUp01: number | null;
  probDown01: number | null;
  probUpDelta01: number | null;
  probDownDelta01: number | null;
}): NowPriceGlanceSummary {
  const {
    band,
    glance,
    upLabel,
    downLabel,
    edgeScalp,
    fairValueGap,
    fvgSignal,
    deskSpeed,
    machineReadout,
    bandGauge,
    physicsLine,
    probUp01,
    probDown01,
    probUpDelta01,
    probDownDelta01,
  } = params;

  const trade = edgeScalp
    ? tradeFromScalp(edgeScalp, upLabel, downLabel)
    : machineReadout
      ? tradeFromMachine(machineReadout, upLabel, downLabel)
      : { call: 'WAIT', tone: 'flat' as const, detail: 'Need edge or sensor readout' };

  const speedFav = deskSpeed ? pickSpeedFavoredLane(deskSpeed) : null;
  const speedLabel = speedFav
    ? speedFav.lane === 'split'
      ? `Speed split · ${speedFav.short}`
      : `Speed → ${speedFav.label} · ${speedFav.short}`
    : null;

  const upBreakShort = glance.upBreak.cleared
    ? `✓ ${glance.upBreak.primary}`
    : `○ ${glance.upBreak.primary}`;
  const downBreakShort = glance.downBreak.cleared
    ? `✓ ${glance.downBreak.primary}`
    : `○ ${glance.downBreak.primary}`;

  return {
    geo: band.geo.replace('_', ' '),
    geoTone: geoTone(band.geo),
    spotLabel: fmtUsd(band.now),
    ptbGapLabel: `PTB ${fmtUsd(band.ptb)} · ${fmtUsdSigned(band.distNowFromPtb)}`,
    tradeCall: trade.call,
    tradeCallTone: trade.tone,
    tradeDetail: trade.detail,
    edgeLabel: edgeScalp ? `Edge ${fmtEdgePp(edgeScalp.edge)}` : null,
    modelVsMarket: edgeScalp
      ? `Model ${fmtProbPct01(edgeScalp.pModel)} · Mkt ${fmtProbPct01(edgeScalp.pMkt)}`
      : null,
    upMidLabel:
      probUp01 != null
        ? `${upLabel} ${fmtCents(probUp01)}${probUpDelta01 != null ? ` (${fmtDeltaCents(probUpDelta01)})` : ''}`
        : null,
    downMidLabel:
      probDown01 != null
        ? `${downLabel} ${fmtCents(probDown01)}${probDownDelta01 != null ? ` (${fmtDeltaCents(probDownDelta01)})` : ''}`
        : null,
    upBreakShort,
    downBreakShort,
    speedLabel,
    machineLabel: machineReadout
      ? `Sensors ${machineReadout.agreementScore}% · ${machineReadout.focusLane?.toUpperCase() ?? 'SPLIT'} · ${machineReadout.regime}`
      : null,
    playbookLabel: bandGauge ? `${bandGauge.glanceVerb} · ${bandGauge.separation}` : null,
    bannerLine: physicsLine?.trim() || machineReadout?.lines[0]?.trim() || glance.subline,
    fairValueLabel: fairValueGap
      ? `Fair ${fmtProbPct01(fairValueGap.fairValueUp)} · ${fmtPp(fairValueGap.fairEdgePp)} vs odds`
      : null,
    fairGapLabel: fairValueGap
      ? fairValueGap.meanReady
        ? `Gap ${fmtPp(fairValueGap.rawGapPp)} · μ ${fmtPp(fairValueGap.meanGapPp!)} → ${fmtPp(fairValueGap.gapFromMeanPp)}`
        : `Gap ${fmtPp(fairValueGap.rawGapPp)} (expected − market)`
      : null,
    fvgSignalLabel: fvgSignal
      ? fvgSignal.signalReady
        ? `${fvgSignal.label} · ${fvgSignal.signal!.toFixed(1)} (Z×edge)`
        : `${fvgSignal.label} · Z warming`
      : null,
  };
}
