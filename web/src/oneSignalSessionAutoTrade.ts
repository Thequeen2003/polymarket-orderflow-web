/**
 * One-signal session auto-trade — up to one $150 buy per crypto per 25-minute wall-clock
 * session. Mean-implied mids set take-profit; stop is watch-only via bracket % (no SL order).
 */

import { roundPrice01ToCent } from './displayCents';
import { formatBracketCentsFrom01 } from './armRiskFromSignal';
import type { UpdownShortcutAsset, UpdownInterval } from './lib/api';
import {
  executeTakeSignal,
  type ExecuteTakeSignalResult,
  type TakeSignalPlan,
} from './takeSignalDesk';

export const ONE_SIGNAL_SESSION_MS = 25 * 60_000;
export const ONE_SIGNAL_TRADE_USD = 150;
export const ONE_SIGNAL_ASSETS: readonly UpdownShortcutAsset[] = ['btc', 'eth', 'sol', 'hype'];
export const ONE_SIGNAL_DEFAULT_INTERVAL: UpdownInterval = '15m';

export const ENTRY_MIN_01 = 0.48;
export const ENTRY_MAX_01 = 0.93;
export const DEFAULT_TP_GAIN_PCT = 0.05;
export const DEFAULT_WATCH_STOP_PCT = 0.06;

export type OneSignalSessionKey = string;

export type OneSignalSessionTradeRecord = {
  asset: UpdownShortcutAsset;
  slug: string;
  lane: 'up' | 'down';
  entry01: number;
  takeProfit01: number;
  watchStop01: number;
  sizeUsd: number;
  tradedAtMs: number;
};

export type AgentSnapshotOutcome = {
  lane: 'up' | 'down';
  impliedMid: number | null;
  recentTrades?: { price: number; side: string }[];
};

export type AgentSnapshotPayload = {
  market: { slug: string };
  window?: { remainingMs?: number | null };
  underlying?: {
    spotVsPtbUsd?: number | null;
    spot?: { history?: { usd: number }[] };
  };
  outcomes?: {
    up?: AgentSnapshotOutcome;
    down?: AgentSnapshotOutcome;
  };
};

export type OneSignalEval = {
  ok: boolean;
  lane: 'up' | 'down' | null;
  entry01: number | null;
  takeProfit01: number | null;
  watchStop01: number | null;
  gainPct: number | null;
  mean01: number | null;
  reason: string | null;
};

export type OneSignalTradeRequest = {
  asset: UpdownShortcutAsset;
  slug: string;
  plan: TakeSignalPlan;
  takeProfit01: number;
  watchStop01: number;
  sizeUsd: number;
  endsInMs: number | null;
  market?: unknown;
};

/** Wall-clock 25-minute session bucket id. */
export function oneSignalSessionKey(nowMs = Date.now()): OneSignalSessionKey {
  return String(Math.floor(nowMs / ONE_SIGNAL_SESSION_MS));
}

export function sharesFromUsdNotional(usd: number, entry01: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  if (!Number.isFinite(entry01) || entry01 <= 0 || entry01 >= 1) return 0;
  return Math.round((usd / entry01) * 10000) / 10000;
}

/** Mean of recent implied/trade mids → take-profit % above entry (3–8%). */
export function computeMeanGainTakeProfit(
  entry01: number,
  recentMids01: readonly number[],
  floorPct = DEFAULT_TP_GAIN_PCT,
): { takeProfit01: number; mean01: number; gainPct: number } {
  const entry = roundPrice01ToCent(entry01);
  const valid = recentMids01.filter((m) => Number.isFinite(m) && m > 0 && m < 1);
  const mean01 =
    valid.length > 0
      ? roundPrice01ToCent(valid.reduce((a, b) => a + b, 0) / valid.length)
      : entry;
  const driftPct = Math.abs(mean01 - entry) / Math.max(entry, 0.01);
  const gainPct = Math.max(0.03, Math.min(0.08, floorPct + driftPct * 0.5));
  const rawTp = entry * (1 + gainPct);
  const takeProfit01 = roundPrice01ToCent(Math.min(0.99, Math.max(entry + 0.01, rawTp)));
  return { takeProfit01, mean01, gainPct };
}

/** Watch stop below entry (monitor only — not submitted as SL order). */
export function computeWatchStopFromPct(
  entry01: number,
  watchStopPct: number,
  lane: 'up' | 'down',
): number {
  const entry = roundPrice01ToCent(entry01);
  const pct = Math.max(0.01, Math.min(0.2, watchStopPct));
  const dist = entry * pct;
  if (lane === 'up') return roundPrice01ToCent(Math.max(0.01, entry - dist));
  return roundPrice01ToCent(Math.min(0.99, entry + dist));
}

function tapeSupportsLane(lane: 'up' | 'down', trades: { price: number; side: string }[]): boolean {
  if (trades.length < 2) return true;
  let buy = 0;
  let sell = 0;
  for (const t of trades.slice(0, 12)) {
    const side = t.side?.toLowerCase() ?? '';
    if (side.includes('buy')) buy += 1;
    else if (side.includes('sell')) sell += 1;
  }
  if (lane === 'up') return buy >= sell;
  return sell >= buy;
}

function collectRecentMids(outcome: AgentSnapshotOutcome | undefined): number[] {
  const mids: number[] = [];
  if (outcome?.impliedMid != null && Number.isFinite(outcome.impliedMid)) mids.push(outcome.impliedMid);
  for (const t of outcome?.recentTrades ?? []) {
    const p = Number(t.price);
    if (Number.isFinite(p) && p > 0 && p < 1) mids.push(p);
  }
  return mids;
}

/** Evaluate agent snapshot for a single perfect entry (spot vs PTB + tape + entry band). */
export function evaluateOneSignalSnapshot(
  snap: AgentSnapshotPayload,
  watchStopPct = DEFAULT_WATCH_STOP_PCT,
  tpGainPctFloor = DEFAULT_TP_GAIN_PCT,
): OneSignalEval {
  const fail = (reason: string): OneSignalEval => ({
    ok: false,
    lane: null,
    entry01: null,
    takeProfit01: null,
    watchStop01: null,
    gainPct: null,
    mean01: null,
    reason,
  });

  const remaining = snap.window?.remainingMs;
  if (remaining != null && Number.isFinite(remaining)) {
    if (remaining < 90_000) return fail('Round ending — wait for next 25m session window.');
    if (remaining > 14 * 60_000) return fail('Round too fresh — wait for structure (under ~14:00 left).');
  }

  const delta = snap.underlying?.spotVsPtbUsd;
  if (delta == null || !Number.isFinite(delta)) return fail('Spot vs PTB not ready.');
  if (Math.abs(delta) < 4) return fail('Spot too close to PTB — need a clear one-signal side.');

  const lane: 'up' | 'down' = delta > 0 ? 'up' : 'down';
  const outcome = lane === 'up' ? snap.outcomes?.up : snap.outcomes?.down;
  const entry01 = outcome?.impliedMid;
  if (entry01 == null || !Number.isFinite(entry01) || entry01 <= 0 || entry01 >= 1) {
    return fail('No implied mid on signal lane.');
  }
  if (entry01 < ENTRY_MIN_01 || entry01 > ENTRY_MAX_01) {
    return fail(`Entry ${Math.round(entry01 * 100)}¢ outside ${Math.round(ENTRY_MIN_01 * 100)}–${Math.round(ENTRY_MAX_01 * 100)}¢ band.`);
  }

  const tape = outcome?.recentTrades ?? [];
  if (!tapeSupportsLane(lane, tape)) {
    return fail(`Tape flow fights ${lane.toUpperCase()} — wait for alignment.`);
  }

  const spotHist = snap.underlying?.spot?.history ?? [];
  const spotMids = spotHist.slice(-8).map((p) => {
    const implied = lane === 'up' ? entry01 + 0.01 : entry01 - 0.01;
    return implied;
  });
  const tradeMids = collectRecentMids(outcome);
  const other = lane === 'up' ? snap.outcomes?.down : snap.outcomes?.up;
  const crossMids = collectRecentMids(other);
  const recentMids = [...tradeMids, ...crossMids, ...spotMids];

  const bracket = computeMeanGainTakeProfit(entry01, recentMids, tpGainPctFloor);
  const watchStop01 = computeWatchStopFromPct(entry01, watchStopPct, lane);

  return {
    ok: true,
    lane,
    entry01,
    takeProfit01: bracket.takeProfit01,
    watchStop01,
    gainPct: bracket.gainPct,
    mean01: bracket.mean01,
    reason: null,
  };
}

export function buildOneSignalTakePlan(evalResult: OneSignalEval, asset: UpdownShortcutAsset): TakeSignalPlan {
  if (!evalResult.ok || !evalResult.lane || evalResult.entry01 == null) {
    return {
      canTake: false,
      disabledReason: evalResult.reason ?? 'One-signal not ready.',
      lane: null,
      entry01: null,
      takeProfit01: null,
      stopLoss01: null,
      buttonLabel: 'One signal — wait',
    };
  }
  const lane = evalResult.lane;
  const entryC = Math.round(evalResult.entry01 * 1000) / 10;
  return {
    canTake: true,
    disabledReason: null,
    lane,
    entry01: evalResult.entry01,
    takeProfit01: evalResult.takeProfit01,
    stopLoss01: null,
    buttonLabel: `One signal · ${asset.toUpperCase()} ${lane.toUpperCase()} @ ${entryC}¢`,
  };
}

function prefillTpAndWatchStop(args: {
  lane: 'up' | 'down';
  takeProfit01: number;
  watchStop01: number;
  sizeShares?: number;
}): void {
  if (typeof window === 'undefined') return;
  const tpCents = Math.round(args.takeProfit01 * 100);
  const stopCents = Math.round(args.watchStop01 * 100);
  window.dispatchEvent(
    new CustomEvent('bpx-risk-prefill', {
      detail: {
        lane: args.lane,
        tpCents,
        tpCentsStr: formatBracketCentsFrom01(args.takeProfit01),
        arm: true,
        forceLevels: true,
        sizeShares: args.sizeShares,
      },
    }),
  );
  window.dispatchEvent(
    new CustomEvent('bpx-risk-prefill', {
      detail: {
        lane: args.lane,
        stopCents,
        stopCentsStr: formatBracketCentsFrom01(args.watchStop01),
        arm: false,
      },
    }),
  );
}

/** Buy $150, arm TP sell-up only; watch stop prefilled but not armed. */
export function executeOneSignalSessionTrade(
  plan: TakeSignalPlan,
  slug: string,
  opts: {
    sizeUsd?: number;
    takeProfit01: number;
    watchStop01: number;
    endsInMs?: number | null;
  },
): ExecuteTakeSignalResult {
  if (!plan.canTake || !plan.lane || plan.entry01 == null) {
    return { prefilled: false, buySubmitted: false, buySkippedReason: plan.disabledReason };
  }
  const sizeUsd = opts.sizeUsd ?? ONE_SIGNAL_TRADE_USD;
  const sizeShares = sharesFromUsdNotional(sizeUsd, plan.entry01);

  prefillTpAndWatchStop({
    lane: plan.lane,
    takeProfit01: opts.takeProfit01,
    watchStop01: opts.watchStop01,
    sizeShares: sizeShares > 0 ? sizeShares : undefined,
  });

  return executeTakeSignal(plan, slug, {
    submitBuy: true,
    sizeUsd,
    armSlTp: false,
    endsInMs: opts.endsInMs,
  });
}

export function formatOneSignalSessionSummary(records: readonly OneSignalSessionTradeRecord[]): string {
  if (records.length === 0) return 'No trades this 25m session.';
  return records
    .map((r) => `${r.asset.toUpperCase()} ${r.lane.toUpperCase()} @ ${Math.round(r.entry01 * 100)}¢ → TP ${Math.round(r.takeProfit01 * 100)}¢`)
    .join(' · ');
}
