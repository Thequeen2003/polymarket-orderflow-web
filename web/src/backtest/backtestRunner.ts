import { buildSpotCandles, type SpotTick } from '../spotVsPtb';
import { runPtbCoreEngine } from '../ptbCoreEngine';
import { freshPaperAccount, getPaperPosition, paperTrade } from '../paperTradingCore';
import type { BacktestDatasetV1, BacktestResult, BacktestTrade } from './types';
import { decideBothLanes, type StrategyParams, type StrategyState } from './strategy';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function fmtUsdCents(c: number): string {
  const s = (c / 100).toFixed(2);
  return `${c < 0 ? '-' : ''}$${s.replace(/^-/, '')}`;
}

export function runBacktestPaperBothLanes(args: { data: BacktestDatasetV1; params: StrategyParams }): BacktestResult {
  const { data, params } = args;
  const pts = Array.isArray(data.points) ? data.points.slice().sort((a, b) => a.t - b.t) : [];
  const up = String(data.upTokenId ?? '').trim();
  const down = String(data.downTokenId ?? '').trim();

  let account = freshPaperAccount(pts[0]?.t ?? Date.now());
  const trades: BacktestTrade[] = [];
  const state: StrategyState = { lastActionAtMs: null };

  const ticks: SpotTick[] = [];

  for (const p of pts) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.spotUsd) || !Number.isFinite(p.ptbUsd)) continue;
    ticks.push({ t: p.t, v: p.spotUsd });
    // Keep a bounded history (enough for candles + slope). This also keeps the engine fast.
    if (ticks.length > 900) ticks.splice(0, ticks.length - 900);

    const candles = buildSpotCandles(ticks, 24);
    const snap = runPtbCoreEngine({ ticks, candles, ptbUsd: p.ptbUsd });

    const upPos = getPaperPosition(account, up);
    const dnPos = getPaperPosition(account, down);
    const actions = decideBothLanes(
      {
        now: p.t,
        snap,
        upMid01: p.upMid01 == null ? null : clamp01(p.upMid01),
        downMid01: p.downMid01 == null ? null : clamp01(p.downMid01),
        upTokenId: up,
        downTokenId: down,
        upShares: upPos.shares,
        downShares: dnPos.shares,
        upAvg01: upPos.avgCost01,
        downAvg01: dnPos.avgCost01,
      },
      state,
      params,
    );

    let didAct = false;
    for (const a of actions) {
      if (a.kind === 'noop') continue;
      const r = paperTrade({
        account,
        tokenId: a.tokenId,
        side: a.kind === 'buy' ? 'buy' : 'sell',
        shares: a.shares,
        price01: a.price01,
        now: p.t,
      });
      if (!r.ok) continue;
      account = r.account;
      trades.push({
        t: p.t,
        tokenId: r.fill.token,
        side: r.fill.side,
        price01: r.fill.price01,
        shares: r.fill.shares,
        usdCents: r.fill.usdCents,
        note: a.note,
      });
      didAct = true;
    }
    if (didAct) state.lastActionAtMs = p.t;
  }

  // Final equity: mark positions at last known mids.
  const last = pts.length ? pts[pts.length - 1]! : null;
  const upMid = last?.upMid01 ?? null;
  const dnMid = last?.downMid01 ?? null;
  const upPos = getPaperPosition(account, up);
  const dnPos = getPaperPosition(account, down);
  const upValue = upMid != null ? Math.round(clamp01(upMid) * upPos.shares * 100) : 0;
  const dnValue = dnMid != null ? Math.round(clamp01(dnMid) * dnPos.shares * 100) : 0;
  const equity = account.cashUsdCents + upValue + dnValue;

  const summaryLines: string[] = [];
  summaryLines.push(`slug: ${data.slug}`);
  summaryLines.push(`trades: ${trades.length}`);
  summaryLines.push(`cash: ${fmtUsdCents(account.cashUsdCents)} · realizedPnL: ${fmtUsdCents(account.realizedPnlUsdCents)}`);
  summaryLines.push(`equity (marked): ${fmtUsdCents(equity)}`);
  summaryLines.push(
    `pos: up ${upPos.shares.toFixed(4)}sh @ ${upPos.avgCost01 == null ? '—' : `${Math.round(upPos.avgCost01 * 100)}¢`} · down ${dnPos.shares.toFixed(4)}sh @ ${
      dnPos.avgCost01 == null ? '—' : `${Math.round(dnPos.avgCost01 * 100)}¢`
    }`,
  );

  return {
    slug: data.slug,
    points: pts.length,
    startT: pts[0]?.t ?? null,
    endT: pts.length ? pts[pts.length - 1]!.t : null,
    finalCashUsdCents: account.cashUsdCents,
    finalRealizedPnlUsdCents: account.realizedPnlUsdCents,
    finalEquityUsdCents: equity,
    trades,
    summaryLines,
  };
}

