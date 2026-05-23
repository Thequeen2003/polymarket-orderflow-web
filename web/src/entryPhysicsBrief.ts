/**
 * Trade physics for Up/Down markets — spot vs PTB, book flow, outcome tokens, brackets, bell.
 * Plain language only; answers what must happen in the world vs on the CLOB.
 */

import { formatCentsLabelFrom01 } from './displayCents';
import type { TradeLevels } from './tradeLevels';

export type EntryPhysicsInput = {
  spot: number | null;
  ptb: number | null;
  /** Half-width of the PTB reaction band in USD (same as chart). */
  bandUsd: number;
  /** Trade card / Do this now entry lane — outcome token you'd buy. */
  entryLane: 'up' | 'down' | null;
  /** Walls + book + tape majority. */
  flowWinningLane: 'up' | 'down' | null;
  lastProbUp: number | null;
  lastProbDown: number | null;
  wallHeadline: string | null;
  upLabel: string;
  downLabel: string;
  /** Ms until round bell — tightens bracket copy near settlement. */
  endsInMs?: number | null;
  /** P(spot crosses PTB before bell) 0..1. */
  crossProb?: number | null;
  /** Card TP/SL row for bracket physics line. */
  levels?: TradeLevels | null;
  /** When set, exit/hold physics for the side you marked. */
  heldLane?: 'up' | 'down' | null;
};

export type TradePhysicsBlock = {
  id: 'settlement' | 'spot' | 'book' | 'bracket' | 'bell' | 'warn';
  text: string;
};

const MAX_LINE = 200;
const MAX_JOIN = 280;

function clip(s: string, max = MAX_LINE): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function fmtUsdPhysics(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtCents01(p: number): string {
  return formatCentsLabelFrom01(p);
}

/** Which side wins at settlement if spot stayed where it is (geometric). */
export function spotGeometricWinner(
  spot: number,
  ptb: number,
  bandUsd: number,
): 'up' | 'down' | 'at' {
  const band = Math.max(bandUsd, 0.25);
  const d = spot - ptb;
  if (Math.abs(d) <= band) return 'at';
  return d > 0 ? 'up' : 'down';
}

function spotVsPtbPhrase(spot: number, ptb: number, band: number): string {
  const d = spot - ptb;
  const b = Math.max(band, 0.25);
  const geo = spotGeometricWinner(spot, ptb, band);
  if (geo === 'at') {
    return `spot ${fmtUsdPhysics(spot)} is inside the PTB band around ${fmtUsdPhysics(ptb)} (±${fmtUsdPhysics(b)}) — no clear winner yet`;
  }
  if (geo === 'up') {
    return `spot ${fmtUsdPhysics(spot)} is ${fmtUsdPhysics(d)} above PTB ${fmtUsdPhysics(ptb)} — geometry favors Up at the bell`;
  }
  return `spot ${fmtUsdPhysics(spot)} is ${fmtUsdPhysics(Math.abs(d))} below PTB ${fmtUsdPhysics(ptb)} — geometry favors Down at the bell`;
}

function settlementRule(lane: 'up' | 'down', upLabel: string, downLabel: string): string {
  const name = lane === 'up' ? upLabel : downLabel;
  if (lane === 'up') {
    return `Buying ${name}: you win $1/share if settlement spot finishes above PTB; lose stake if below`;
  }
  return `Buying ${name}: you win $1/share if settlement spot finishes below PTB; lose stake if above`;
}

function bookPhrase(
  flowLane: 'up' | 'down' | null,
  probUp: number | null,
  probDown: number | null,
  wallHeadline: string | null,
  upLabel: string,
  downLabel: string,
): string | null {
  const parts: string[] = [];
  if (wallHeadline?.trim()) parts.push(wallHeadline.trim());
  let u = probUp;
  let d = probDown;
  if (u != null && Number.isFinite(u) && (d == null || !Number.isFinite(d))) d = 1 - u;
  if (d != null && Number.isFinite(d) && (u == null || !Number.isFinite(u))) u = 1 - d;
  if (u != null && d != null && Number.isFinite(u) && Number.isFinite(d)) {
    const uC = fmtCents01(u);
    const dC = fmtCents01(d);
    if (d > u + 0.02) parts.push(`market prices ${downLabel} ${dC} vs ${upLabel} ${uC}`);
    else if (u > d + 0.02) parts.push(`market prices ${upLabel} ${uC} vs ${downLabel} ${dC}`);
    else parts.push(`market ~50/50 (${upLabel} ${uC} · ${downLabel} ${dC})`);
  }
  if (flowLane) {
    const fl = flowLane === 'up' ? upLabel : downLabel;
    if (!parts.some((p) => p.toLowerCase().includes(fl.toLowerCase()))) {
      parts.push(`order flow favors ${fl}`);
    }
  }
  if (!parts.length) return null;
  return parts.join(' · ');
}

function bellPhrase(endsInMs: number | null | undefined): string | null {
  if (endsInMs == null || !Number.isFinite(endsInMs) || endsInMs <= 0) return null;
  const sec = Math.max(0, Math.round(endsInMs / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const clock = m > 0 ? `${m}:${String(s).padStart(2, '0')} to bell` : `${s}s to bell`;
  if (endsInMs <= 15_000) {
    return `${clock} — TP/SL pin to mid; use market sells, not fresh limits`;
  }
  if (endsInMs <= 60_000) {
    return `${clock} — brackets tighten; scalp into the bell`;
  }
  return `${clock} — time left for spot to commit vs PTB`;
}

function crossPhrase(crossProb: number | null | undefined, ptb: number | null): string | null {
  if (crossProb == null || !Number.isFinite(crossProb) || ptb == null) return null;
  const pct = Math.round(crossProb * 100);
  if (pct >= 70) return `~${pct}% chance spot crosses PTB again before bell — volatile round`;
  if (pct <= 15) return `~${pct}% chance spot crosses PTB — current side of PTB likely holds`;
  return `~${pct}% chance spot crosses PTB before bell`;
}

function bracketPhrase(
  lane: 'up' | 'down',
  levels: TradeLevels,
  upLabel: string,
  downLabel: string,
): string {
  const name = lane === 'up' ? upLabel : downLabel;
  const entry = fmtCents01(levels.entry);
  const tp = fmtCents01(levels.takeProfit);
  const sl = fmtCents01(levels.stopLoss);
  if (levels.collapsed) {
    return `Brackets collapsed near bell — exit on ${name} at ~${entry} mid, not wide TP/SL`;
  }
  const settleHint =
    lane === 'up'
      ? 'bell still needs spot above PTB for Up to pay $1'
      : 'bell still needs spot below PTB for Down to pay $1';
  return (
    `On ${name}: buy ~${entry} · TP ${tp} sells when bid rises · SL ${sl} when bid falls · ${settleHint}`
  );
}

function spotBookConflict(
  spot: number,
  ptb: number,
  band: number,
  entryLane: 'up' | 'down',
  flowLane: 'up' | 'down',
  upLabel: string,
  downLabel: string,
): string | null {
  const geo = spotGeometricWinner(spot, ptb, band);
  if (geo === 'at') return null;
  const entryName = entryLane === 'up' ? upLabel : downLabel;
  const flowName = flowLane === 'up' ? upLabel : downLabel;
  if (geo === entryLane && flowLane !== entryLane) {
    return `Spot geometry favors ${entryName} but book flow favors ${flowName} — size down or wait for alignment`;
  }
  if (geo !== entryLane && flowLane === entryLane) {
    return `Book favors ${flowName} but spot is still on the ${geo === 'up' ? upLabel : downLabel} side of PTB — risky entry`;
  }
  if (geo !== entryLane && flowLane !== entryLane) {
    const geoName = geo === 'up' ? upLabel : downLabel;
    return `Neither spot (${geoName} vs PTB) nor book (${flowName}) matches your ${entryName} entry — wait`;
  }
  return null;
}

/** Structured blocks for UI bullets / tooltips. */
export function buildTradePhysicsBlocks(input: EntryPhysicsInput): TradePhysicsBlock[] {
  const {
    spot,
    ptb,
    bandUsd,
    entryLane,
    flowWinningLane,
    lastProbUp,
    lastProbDown,
    wallHeadline,
    upLabel,
    downLabel,
    endsInMs,
    crossProb,
    levels,
    heldLane,
  } = input;

  const band = Math.max(bandUsd, 0.25);
  const hasSpot = spot != null && ptb != null && Number.isFinite(spot) && Number.isFinite(ptb) && ptb > 0;
  const blocks: TradePhysicsBlock[] = [];

  const lane = entryLane ?? heldLane;
  if (lane) {
    blocks.push({ id: 'settlement', text: clip(settlementRule(lane, upLabel, downLabel)) });
  }

  if (hasSpot) {
    blocks.push({ id: 'spot', text: clip(spotVsPtbPhrase(spot!, ptb!, band)) });
    const cross = crossPhrase(crossProb, ptb);
    if (cross) blocks.push({ id: 'spot', text: clip(cross) });
  }

  const book = bookPhrase(flowWinningLane, lastProbUp, lastProbDown, wallHeadline, upLabel, downLabel);
  if (book) blocks.push({ id: 'book', text: clip(book) });

  if (entryLane && levels && levels.lane === entryLane && !levels.collapsed) {
    blocks.push({ id: 'bracket', text: clip(bracketPhrase(entryLane, levels, upLabel, downLabel)) });
  } else if (entryLane && levels?.collapsed) {
    blocks.push({ id: 'bracket', text: clip(bracketPhrase(entryLane, levels, upLabel, downLabel)) });
  }

  const bell = bellPhrase(endsInMs);
  if (bell) blocks.push({ id: 'bell', text: clip(bell) });

  if (hasSpot && entryLane && flowWinningLane) {
    const warn = spotBookConflict(spot!, ptb!, band, entryLane, flowWinningLane, upLabel, downLabel);
    if (warn) blocks.push({ id: 'warn', text: clip(warn) });
  }

  return blocks;
}

/** One paragraph for Do this now / sensor strip. */
export function buildEntryPhysicsBrief(input: EntryPhysicsInput): string | null {
  const blocks = buildTradePhysicsBlocks(input);
  if (!blocks.length) return null;
  const order: TradePhysicsBlock['id'][] = ['settlement', 'spot', 'book', 'bracket', 'bell', 'warn'];
  const texts: string[] = [];
  for (const id of order) {
    for (const b of blocks) {
      if (b.id === id) texts.push(b.text);
    }
  }
  if (!texts.length) return null;
  return clip(texts.join('. ') + '.', MAX_JOIN);
}

/** Exit / hold physics when operator tagged a side. */
export function buildExitPhysicsBrief(input: EntryPhysicsInput): string | null {
  const held = input.heldLane;
  if (!held) return null;
  const hasSpot =
    input.spot != null &&
    input.ptb != null &&
    Number.isFinite(input.spot) &&
    Number.isFinite(input.ptb) &&
    input.ptb > 0;
  const band = Math.max(input.bandUsd, 0.25);
  const name = held === 'up' ? input.upLabel : input.downLabel;
  const parts: string[] = [
    `You marked ${name} — you need settlement spot ${held === 'up' ? 'above' : 'below'} PTB at the bell to win`,
  ];
  if (hasSpot) {
    const geo = spotGeometricWinner(input.spot!, input.ptb!, band);
    if (geo === held) {
      parts.push(`spot is on your side of PTB right now — thesis intact if it holds`);
    } else if (geo === 'at') {
      parts.push(`spot is in the PTB band — one push through the band decides the round`);
    } else {
      parts.push(
        `spot is on the wrong side of PTB for ${name} — consider exit unless book flow is saving you`,
      );
    }
  }
  const book = bookPhrase(
    input.flowWinningLane,
    input.lastProbUp,
    input.lastProbDown,
    input.wallHeadline,
    input.upLabel,
    input.downLabel,
  );
  if (book) parts.push(book);
  const bell = bellPhrase(input.endsInMs);
  if (bell) parts.push(bell);
  return clip(parts.join('. ') + '.', MAX_JOIN);
}

/** Short hint under Take signal button. */
export function buildTakeSignalPhysicsHint(input: EntryPhysicsInput): string | null {
  const lane = input.entryLane;
  if (!lane || !input.levels || input.levels.lane !== lane) {
    return buildEntryPhysicsBrief(input);
  }
  const name = lane === 'up' ? input.upLabel : input.downLabel;
  const entry = fmtCents01(input.levels.entry);
  const tp = fmtCents01(input.levels.takeProfit);
  const sl = fmtCents01(input.levels.stopLoss);
  const geo =
    input.spot != null && input.ptb != null
      ? spotGeometricWinner(input.spot, input.ptb, Math.max(input.bandUsd, 0.25))
      : null;
  const geoOk = geo === lane || geo === 'at';
  const parts = [
    `Limit buy ${name} ~${entry}`,
    `TP ${tp} / SL ${sl} on that token`,
    geoOk
      ? `settlement geometry OK for ${name}`
      : `check physics — spot may not match ${name} at bell`,
  ];
  return clip(parts.join(' · '));
}

/** One-line bracket rule for automation readout. */
export function buildBracketPhysicsOneLiner(
  lane: 'up' | 'down',
  levels: TradeLevels,
  upLabel: string,
  downLabel: string,
): string {
  return clip(bracketPhrase(lane, levels, upLabel, downLabel), 160);
}
