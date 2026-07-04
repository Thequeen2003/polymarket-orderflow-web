/**
 * Pocket Option–style BTC binary desk — CALL/PUT vs strike at expiry.
 * Practice only; uses Binance BTC/USDT as the reference feed.
 */

import type { BinaryExpirySec, BinaryPrediction } from './binaryCandlePredictor';
import { expiryBucketProgress } from './binaryCandlePredictor';

/** Pocket Option turbo expiries (practice desk). */
export const POCKET_OPTION_EXPIRY_OPTIONS: { sec: BinaryExpirySec; label: string; poLabel: string }[] = [
  { sec: 10, label: '10s', poLabel: 'S10' },
  { sec: 30, label: '30s', poLabel: 'S30' },
  { sec: 60, label: '1m', poLabel: 'M1' },
  { sec: 180, label: '3m', poLabel: 'M3' },
  { sec: 300, label: '5m', poLabel: 'M5' },
  { sec: 600, label: '10m', poLabel: 'M10' },
  { sec: 900, label: '15m', poLabel: 'M15' },
];

/** Typical Pocket Option win payout (~92% profit on stake). */
export const POCKET_OPTION_PAYOUT_MULT = 0.92;

export type PocketOptionTiming = 'early' | 'mid' | 'late';

export type PocketOptionConfirmation = {
  label: string;
  ok: boolean;
};

export type PocketOptionMomentumReadout = {
  side: 'call' | 'put';
  direction: 'up' | 'down';
  headline: string;
  tapeLine: string;
  actionHint: string;
  timing: PocketOptionTiming;
  bucketPct: number;
  confirmations: PocketOptionConfirmation[];
  canTrade: boolean;
  confidencePct: number;
  probUp: number;
  emoji: string;
};

function timingFromBucket(pct: number): PocketOptionTiming {
  if (pct < 0.28) return 'early';
  if (pct < 0.72) return 'mid';
  return 'late';
}

export function buildPocketOptionMomentumReadout(args: {
  prediction: BinaryPrediction;
  expirySec: BinaryExpirySec;
  nowMs: number;
  livePrice: number | null;
  strikePrice: number | null;
  buyVolRecent: number;
  sellVolRecent: number;
}): PocketOptionMomentumReadout {
  const { prediction, expirySec, nowMs, livePrice, strikePrice, buyVolRecent, sellVolRecent } = args;
  const bucketPct = expiryBucketProgress(nowMs, expirySec);
  const timing = timingFromBucket(bucketPct);
  const direction = prediction.direction;
  const side: 'call' | 'put' = direction === 'up' ? 'call' : 'put';
  const confidencePct = prediction.confidencePct;
  const probUp = prediction.probUp;

  const flowTotal = buyVolRecent + sellVolRecent;
  const flowImbalance = flowTotal > 0 ? (buyVolRecent - sellVolRecent) / flowTotal : 0;
  const flowCall = flowImbalance > 0.12;
  const flowPut = flowImbalance < -0.12;

  const vsStrike =
    livePrice != null && strikePrice != null && Number.isFinite(strikePrice)
      ? livePrice - strikePrice
      : null;

  const barCall = prediction.reasons.some((r) => /green|above|up|buy-side|floor/i.test(r));
  const barPut = prediction.reasons.some((r) => /red|below|down|sell-side|top|rejection/i.test(r));

  const confirmations: PocketOptionConfirmation[] = [
    { label: 'Model lean', ok: confidencePct >= 55 },
    { label: 'Live bar', ok: direction === 'up' ? barCall : barPut },
    { label: 'Agg flow', ok: direction === 'up' ? flowCall : flowPut },
    {
      label: 'Vs strike',
      ok: vsStrike != null && (direction === 'up' ? vsStrike >= 0 : vsStrike <= 0),
    },
    { label: 'Window timing', ok: timing !== 'late' },
  ];

  const passCount = confirmations.filter((c) => c.ok).length;
  const canTrade = confidencePct >= 58 && timing !== 'late' && passCount >= 3;

  const sideWord = side === 'call' ? 'CALL ▲' : 'PUT ▼';
  const arrow = side === 'call' ? '↑' : '↓';

  let headline: string;
  if (timing === 'late') {
    headline = `${sideWord} · late in bucket — wait next ${POCKET_OPTION_EXPIRY_OPTIONS.find((o) => o.sec === expirySec)?.label ?? 'window'}`;
  } else if (timing === 'early' && canTrade) {
    headline = `${arrow} ${sideWord} · early momentum — catch before expiry`;
  } else if (canTrade) {
    headline = `${arrow} ${sideWord} · ${confidencePct}% conf · ${passCount}/5 checks`;
  } else {
    headline = `${arrow} Lean ${sideWord} · ${confidencePct}% — need ${Math.max(0, 3 - passCount)} more confirms`;
  }

  const tapeParts: string[] = [];
  tapeParts.push(`${(probUp * 100).toFixed(0)}% higher at expiry`);
  if (flowTotal > 0) tapeParts.push(`flow ${flowImbalance >= 0 ? '+' : ''}${(flowImbalance * 100).toFixed(0)}% buy`);
  if (vsStrike != null) tapeParts.push(`vs strike ${vsStrike >= 0 ? '+' : ''}$${Math.abs(vsStrike).toFixed(2)}`);
  tapeParts.push(`${Math.round(bucketPct * 100)}% through bucket`);

  let actionHint: string;
  if (timing === 'late') {
    actionHint = 'Bucket almost done — don’t open; wait for fresh strike on next candle.';
  } else if (canTrade) {
    actionHint =
      side === 'call'
        ? `Open CALL — price finishing above strike. Payout ~${Math.round(POCKET_OPTION_PAYOUT_MULT * 100)}% on win.`
        : `Open PUT — price finishing below strike. Payout ~${Math.round(POCKET_OPTION_PAYOUT_MULT * 100)}% on win.`;
  } else {
    actionHint = `Watch for ${side === 'call' ? 'green bar + buy flow' : 'red bar + sell flow'} before entry.`;
  }

  return {
    side,
    direction,
    headline,
    tapeLine: tapeParts.join(' · '),
    actionHint,
    timing,
    bucketPct,
    confirmations,
    canTrade,
    confidencePct,
    probUp,
    emoji: side === 'call' ? '🟢' : '🔴',
  };
}
