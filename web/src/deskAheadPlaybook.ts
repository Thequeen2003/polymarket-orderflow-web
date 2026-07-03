/**
 * Structured playbook — tells the operator what to do *before* the desk signal fires.
 */

import { spreadBracketFromFillPrice01 } from './armRiskFromSignal';
import { formatCentsLabelFrom01 } from './displayCents';
import type { ContractLeadSignal } from './contractLeadSignal';
import type { EntryMoment } from './entryMoment';
import type { ExecutionSignal } from './executionSignal';
import type { NowPriceBandDistances } from './nowPriceSignals';
import type { NowPriceDeskTradeSignal } from './nowPriceDeskTradeSignal';
import type { PressureTiming } from './pressureTiming';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';

export type DeskCatchMode = 'go' | 'arm' | 'watch' | 'wait' | 'skip';

export type DeskBracketPlan = {
  entry: string | null;
  tp: string | null;
  sl: string | null;
};

export type DeskAheadPlaybook = {
  mode: DeskCatchMode;
  /** One giant line — entry side + timing. */
  catchLine: string;
  /** Full bracket plan — always show when entry+TP known. */
  bracket: DeskBracketPlan;
  tpHitProbPct: number | null;
  side: 'up' | 'down' | null;
  confirmSec: number | null;
  when: string;
  do: string;
  skip?: string;
};

const MAX = 120;
const CATCH_MAX = 88;

function clip(s: string, max = MAX): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function priceLabel(bid01: number | null, ask01: number | null, preferBid: boolean): string | null {
  const p = preferBid ? (bid01 ?? ask01) : (ask01 ?? bid01);
  if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return formatCentsLabelFrom01(p);
}

function centLabel(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.endsWith('¢') ? s : `${s}¢`;
}

function resolveBracket(args: {
  bid01: number | null;
  ask01: number | null;
  signalTpCents: number | null;
}): DeskBracketPlan {
  const entry01 = args.bid01 ?? args.ask01;
  if (entry01 == null || !Number.isFinite(entry01) || entry01 <= 0 || entry01 >= 1) {
    const tp = args.signalTpCents != null ? centLabel(Math.round(args.signalTpCents)) : null;
    return { entry: null, tp, sl: null };
  }
  const touch = { bestBid: args.bid01, bestAsk: args.ask01 };
  const spread = spreadBracketFromFillPrice01(entry01, touch);
  const signalTp = args.signalTpCents != null ? centLabel(Math.round(args.signalTpCents)) : null;
  return {
    entry: formatCentsLabelFrom01(entry01),
    tp: signalTp ?? centLabel(spread.tpCents),
    sl: centLabel(spread.stopCents),
  };
}

function withExit(doAction: string, bracket: DeskBracketPlan): string {
  if (!bracket.tp) return doAction;
  if (doAction.includes(bracket.tp)) return clip(doAction);
  const slNote = bracket.sl ? ` · SL ${bracket.sl}` : '';
  return clip(`${doAction} · exit at TP ${bracket.tp}${slNote}`);
}

function buyDo(label: string, bracket: DeskBracketPlan): string {
  if (bracket.entry && bracket.tp) {
    const sl = bracket.sl ? ` · SL ${bracket.sl}` : '';
    return clip(`Limit buy ${label} at ${bracket.entry} · TP ${bracket.tp}${sl}`);
  }
  if (bracket.entry) return clip(`Limit buy ${label} at ${bracket.entry}`);
  return clip(`Buy ${label}`);
}

function maxPaySkip(ask: string | null): string | undefined {
  if (!ask) return 'Do not chase a wide ask';
  return clip(`Do not pay above ${ask}`);
}

function sideUpper(label: string | null): string {
  return (label ?? 'SIDE').toUpperCase();
}

function buildCatchLine(args: {
  mode: DeskCatchMode;
  label: string | null;
  bracket: DeskBracketPlan;
  when: string;
  confirmSec: number | null;
}): string {
  const { mode, label, bracket, when, confirmSec } = args;
  const side = sideUpper(label);
  const at = bracket.entry ? ` @ ${bracket.entry}` : '';
  const tpTail = bracket.tp ? ` · TP ${bracket.tp}` : '';

  if (mode === 'go') return clip(`BUY ${side} NOW${at}${tpTail}`, CATCH_MAX);
  if (mode === 'skip') return clip(label ? `NO TRADE · SKIP ${side}` : 'NO TRADE · STAND ASIDE', CATCH_MAX);
  if (mode === 'arm') {
    if (confirmSec != null && confirmSec > 0) {
      return clip(`BUY ${side}${at}${tpTail} IN ${confirmSec}s`, CATCH_MAX);
    }
    return clip(`ARM ${side}${at}${tpTail}`, CATCH_MAX);
  }
  if (mode === 'watch') {
    return clip(`WATCH ${side} → BUY${at}${tpTail}`, CATCH_MAX);
  }
  const shortWhen = when.length <= 28 ? when : `${when.slice(0, 25)}…`;
  return clip(`WAIT · ${shortWhen} → BUY ${side}${at}${tpTail}`, CATCH_MAX);
}

function pb(
  mode: DeskCatchMode,
  when: string,
  doAction: string,
  args: {
    label: string | null;
    lane: 'up' | 'down' | null;
    bracket: DeskBracketPlan;
    tpHitProbPct: number | null;
    confirmSec?: number | null;
    skip?: string;
  },
): DeskAheadPlaybook {
  const confirmSec = args.confirmSec ?? null;
  const doLine = withExit(doAction, args.bracket);
  return {
    mode,
    side: args.lane,
    confirmSec,
    bracket: args.bracket,
    tpHitProbPct: args.tpHitProbPct,
    when: clip(when),
    do: doLine,
    skip: args.skip ? clip(args.skip) : undefined,
    catchLine: buildCatchLine({
      mode,
      label: args.label,
      bracket: args.bracket,
      when,
      confirmSec,
    }),
  };
}

export function deskCatchModeLabel(mode: DeskCatchMode): string {
  switch (mode) {
    case 'go':
      return 'Go now';
    case 'arm':
      return 'Get ready';
    case 'watch':
      return 'Watch tick';
    case 'wait':
      return 'Wait for trigger';
    case 'skip':
      return 'No trade';
  }
}

export function formatDeskBracketLine(bracket: DeskBracketPlan, tpHitProbPct: number | null): string | null {
  if (!bracket.entry || !bracket.tp) return null;
  const sl = bracket.sl ? ` · SL ${bracket.sl}` : '';
  const odds =
    tpHitProbPct != null && Number.isFinite(tpHitProbPct)
      ? ` (~${Math.round(tpHitProbPct)}% TP odds)`
      : '';
  return `ENTRY ${bracket.entry} → TP ${bracket.tp}${sl}${odds}`;
}

export function buildDeskAheadPlaybook(args: {
  signal: NowPriceDeskTradeSignal;
  entryMoment: EntryMoment | null;
  contractLead: ContractLeadSignal | null;
  pressureTiming: PressureTiming | null;
  bandGauge: SpotBandGaugeSnapshot | null;
  band: NowPriceBandDistances | null;
  execution: ExecutionSignal | null;
  advisory: BuySideAdvisory | null;
  bid01: number | null;
  ask01: number | null;
}): DeskAheadPlaybook {
  const { signal, entryMoment, contractLead, pressureTiming, bandGauge, band, execution, advisory } = args;
  const lane = signal.lane;
  const label = signal.laneLabel;
  const ask = priceLabel(args.bid01, args.ask01, false);
  const bracket = resolveBracket({
    bid01: args.bid01,
    ask01: args.ask01,
    signalTpCents: signal.tpCents,
  });
  const tpHitProbPct = signal.tpHitProbPct;
  const pack = (mode: DeskCatchMode, when: string, doAction: string, skip?: string, confirmSec?: number | null) =>
    pb(mode, when, doAction, { label, lane, bracket, tpHitProbPct, skip, confirmSec });

  if (signal.canTrade && signal.phase === 'ENTER' && label) {
    return pack(
      'go',
      'Desk is GO — enter now',
      buyDo(label, bracket),
      maxPaySkip(ask) ?? 'Do not wait for another tick',
    );
  }

  const confirmSec = entryMoment?.confirmSecRemaining ?? signal.confirmSecRemaining;
  if (confirmSec != null && confirmSec > 0 && label) {
    const when =
      confirmSec <= 3
        ? `${confirmSec}s left — confirm almost done`
        : `${confirmSec}s left on 7s confirm hold`;
    const doLine =
      confirmSec <= 3
        ? bracket.entry
          ? `Buy ${label} at ${bracket.entry} as soon as confirm hits`
          : `Buy ${label} as soon as confirm hits`
        : bracket.entry
          ? `Stage limit buy ${label} at ${bracket.entry}`
          : `Stage limit buy ${label}`;
    return pack('arm', when, doLine, maxPaySkip(ask) ?? 'Do not enter before confirm finishes', confirmSec);
  }

  if (contractLead?.phase === 'WATCH' && label) {
    return pack(
      'watch',
      `${label} +1–2¢ on 10s tape (score 4/5)`,
      bracket.entry ? `Bid join ${label} at ${bracket.entry}` : `Bid join ${label}`,
      'Do not wait for 30s confirm',
    );
  }

  if (
    (pressureTiming === 'EARLY' || pressureTiming === 'BUILDING') &&
    label &&
    lane &&
    !signal.canTrade
  ) {
    if (contractLead?.phase === 'ENTER') {
      return pack('go', 'Inside-momentum tick is live', buyDo(label, bracket), maxPaySkip(ask));
    }
    return pack(
      'arm',
      'Next inside-momentum tick on 10s tape',
      bracket.entry && bracket.tp
        ? `Arm ${label} at ${bracket.entry} · plan TP ${bracket.tp}`
        : ask
          ? `Arm ${label} limit at ${ask}`
          : `Arm ${label} limit at ask`,
      'Skip if 30s confirm is already +6¢',
    );
  }

  if (band && lane && label && band.geo === 'IN_BAND') {
    const breakLevel = lane === 'up' ? fmtUsd(band.bandHi) : fmtUsd(band.bandLo);
    const dir = lane === 'up' ? 'above' : 'below';
    return pack(
      'wait',
      `Spot holds ${dir} ${breakLevel}`,
      bracket.entry ? `Buy ${label} at ${bracket.entry} bid` : `Buy ${label} on bid`,
      'Do not buy until the break holds',
    );
  }

  if (bandGauge?.inBand && lane && label) {
    const breakAt = lane === 'up' ? fmtUsd(bandGauge.bandHi) : fmtUsd(bandGauge.bandLo);
    const dir = lane === 'up' ? 'above' : 'below';
    return pack(
      'wait',
      `Spot breaks ${dir} ${breakAt}`,
      bracket.entry ? `Buy ${label} at ${bracket.entry} bid` : `Buy ${label} on bid`,
      'Do not front-run the break',
    );
  }

  if (
    (pressureTiming === 'CHASING' || pressureTiming === 'EXTENDED' || signal.phase === 'WAIT') &&
    label &&
    lane
  ) {
    return pack(
      'wait',
      `10s pressure turns EARLY on ${label}`,
      bracket.entry ? `Bid join ${label} near ${bracket.entry}` : `Bid join ${label}`,
      'Do not chase the ask — move already ran',
    );
  }

  if (execution?.phase === 'ALERT' && signal.blockers.length > 0 && label) {
    const blocker = signal.blockers[0]!;
    return pack(
      'arm',
      `"${blocker}" clears`,
      bracket.entry ? `ENTER ${label} — limit at ${bracket.entry}` : `ENTER ${label} when desk flips GO`,
      'Do not size up before ENTER',
    );
  }

  if (signal.phase === 'LEAN' && label && lane) {
    return pack(
      'arm',
      `Early 10s pressure on ${label}`,
      bracket.entry ? `Bid join ${label} at ${bracket.entry}` : `Bid join ${label}`,
      maxPaySkip(ask),
    );
  }

  if (signal.phase === 'ALERT' && label && lane) {
    return pack(
      'arm',
      `Desk flips to ENTER ${label}`,
      bracket.entry ? `Limit buy ${label} at ${bracket.entry}` : `Limit buy ${label}`,
      maxPaySkip(ask) ?? 'Do not chase before ENTER',
    );
  }

  if (signal.phase === 'NO_TRADE' || entryMoment?.phase === 'NO_TRADE') {
    return pack('skip', 'No clear BUY side yet', 'Stand aside — no order to place', 'Do not force a trade');
  }

  if (advisory?.recommendation && lane && label) {
    return pack(
      'watch',
      `Desk leans ${label}`,
      bracket.entry ? `Watch for ENTER — limit ${bracket.entry}` : `Watch for ENTER on ${label}`,
      advisory.cautionFresh ? 'Wait 1–3s — side just flipped' : maxPaySkip(ask),
    );
  }

  if (label && bracket.entry) {
    return pack('watch', `Desk confirms ${label}`, `Bid join at ${bracket.entry}`, maxPaySkip(ask));
  }

  return pack('wait', 'Setup still forming', clip(signal.exactAction, 140));
}

/** Flat sentence for logs / compact UI. */
export function formatDeskAheadPlaybookLine(playbook: DeskAheadPlaybook): string {
  const bracket = formatDeskBracketLine(playbook.bracket, playbook.tpHitProbPct);
  const skip = playbook.skip ? ` Skip: ${playbook.skip}` : '';
  const bracketBit = bracket ? ` ${bracket}.` : '';
  return clip(`${playbook.catchLine}.${bracketBit} When ${playbook.when} → ${playbook.do}.${skip}`, 240);
}
