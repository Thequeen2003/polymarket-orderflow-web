import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { spreadBracketFromFillPrice01, type BookTouchForArmRisk } from './armRiskFromSignal';
import { buildQuoteAssistTargets, loadEmergencyStopBundlePrefs } from './buyBundleStaging';
import {
  AUTO_DESK_SCALP_COOLDOWN_MS,
  buildNowPriceDeskScalpPlan,
  deskScalpAutoBlockReason,
  deskScalpMeaningKey,
  executeNowPriceDeskScalp,
  loadNowPriceDeskScalpPrefs,
  saveNowPriceDeskScalpPrefs,
  shouldSubmitDeskScalpBuy,
  type NowPriceDeskScalpPrefs,
} from './nowPriceDeskScalp';
import { computePreBuyTpOutlook, type PositionTpOutlook } from './positionTpOutlook';
import { loadAutoTradeSizeShares, saveAutoTradeSizeShares } from './signalsPagePersist';
import { shouldBuyPromptLabel, BuyAdvisoryMetricsStrip } from './ShouldBuyCard';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { EntryMoment } from './entryMoment';
import type { NowPriceDeskTradeSignal } from './nowPriceDeskTradeSignal';
import type { ContractLeadSignal } from './contractLeadSignal';
import type { PressureTiming } from './pressureTiming';
import { EntryMomentStrip } from './EntryMomentStrip';
import { BPX_DESK_TOAST_EVENT, BPX_SIGNALS_LANE_SYNC_EVENT, BPX_TRADE_PANEL_OPEN_EVENT } from './takeSignalDesk';

function fmtCents01(v01: number | null | undefined): string {
  if (v01 == null || !Number.isFinite(v01)) return '—';
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

function laneEntry01(touch: BookTouchForArmRisk | null | undefined, mid01: number | null): number | null {
  const ask = touch?.bestAsk;
  if (ask != null && ask > 0 && ask < 1) return ask;
  if (mid01 != null && mid01 > 0 && mid01 < 1) return mid01;
  return null;
}

function resolveLaneTpCents(entry01: number, touch: BookTouchForArmRisk | null | undefined): string {
  const prefs = loadEmergencyStopBundlePrefs();
  if (prefs.autoTpOnFill) {
    const q = buildQuoteAssistTargets({
      quote01: entry01,
      bestBid: touch?.bestBid ?? null,
      bestAsk: touch?.bestAsk ?? null,
    });
    if (q?.tpCents?.trim()) return q.tpCents.trim();
  }
  return spreadBracketFromFillPrice01(entry01, touch ?? {}).tpCents;
}

export function openNowPriceBuyLane(args: {
  slug: string;
  lane: 'up' | 'down';
  entry01: number | null;
}): void {
  if (typeof window === 'undefined') return;
  const { slug, lane, entry01 } = args;
  const slugTrim = slug.trim();
  if (slugTrim) {
    window.dispatchEvent(
      new CustomEvent(BPX_SIGNALS_LANE_SYNC_EVENT, {
        detail: { slug: slugTrim, lane, force: true },
      }),
    );
  }
  if (entry01 != null && Number.isFinite(entry01) && entry01 > 0 && entry01 < 1) {
    const priceCents = Math.round(entry01 * 1000) / 10;
    window.dispatchEvent(
      new CustomEvent('bpx-trade-prefill', {
        detail: { lane, tone: 'ask' as const, price01: entry01, priceCents },
      }),
    );
  }
  window.dispatchEvent(
    new CustomEvent(BPX_TRADE_PANEL_OPEN_EVENT, {
      detail: { lane, slug: slugTrim || undefined },
    }),
  );
}

function laneOutlook(args: {
  lane: 'up' | 'down';
  touch: BookTouchForArmRisk | null | undefined;
  mid01: number | null;
  probSeries: SpotPoint[];
  endsInMs?: number | null;
}): {
  entry01: number | null;
  tpCents: string | null;
  outlook: PositionTpOutlook | null;
} {
  const entry01 = laneEntry01(args.touch, args.mid01);
  if (entry01 == null) return { entry01: null, tpCents: null, outlook: null };
  const tpCents = resolveLaneTpCents(entry01, args.touch);
  const outlook = computePreBuyTpOutlook({
    entry01,
    tpCents,
    current01: args.mid01,
    probSeries: args.probSeries,
    endsInMs: args.endsInMs ?? null,
  });
  return { entry01, tpCents, outlook };
}

function TpPreview(props: { outlook: PositionTpOutlook | null; tpCents: string | null }): ReactElement {
  const { outlook, tpCents } = props;
  if (!tpCents?.trim()) {
    return <p className="mt-1 text-[10px] text-zinc-500">Set TP in trade panel after open</p>;
  }
  if (!outlook) {
    return (
      <p className="mt-1 font-mono text-[10px] tabular-nums text-zinc-400">
        TP target <span className="font-bold text-zinc-200">{tpCents}¢</span>
      </p>
    );
  }
  const hitPct = Math.round(outlook.tpHitProb01 * 100);
  return (
    <div className="mt-1.5 space-y-1">
      <p className="font-mono text-[10px] tabular-nums text-zinc-300">
        TP <span className="font-bold text-emerald-200">{outlook.tpCents.toFixed(1)}¢</span>
        <span className="text-zinc-600"> · </span>
        <span className="font-bold text-zinc-100">{hitPct}%</span> hit odds
        <span className="text-zinc-600"> · </span>
        {outlook.distanceToTpCents >= 0
          ? `${outlook.distanceToTpCents.toFixed(1)}¢ left`
          : `${Math.abs(outlook.distanceToTpCents).toFixed(1)}¢ past`}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-900/80">
        <div
          className={`h-full ${hitPct >= 55 ? 'bg-emerald-400/80' : hitPct >= 35 ? 'bg-amber-300/75' : 'bg-zinc-500/70'}`}
          style={{ width: `${Math.max(4, hitPct)}%` }}
        />
      </div>
    </div>
  );
}

function LaneBuyButton(props: {
  lane: 'up' | 'down';
  label: string;
  entry01: number | null;
  tpCents: string | null;
  outlook: PositionTpOutlook | null;
  favored: boolean;
  advisoryPick: boolean;
  onBuy: () => void;
}): ReactElement {
  const isUp = props.lane === 'up';
  const shell = props.favored
    ? isUp
      ? 'border-emerald-500/60 bg-emerald-950/35 ring-2 ring-emerald-500/25'
      : 'border-rose-500/60 bg-rose-950/35 ring-2 ring-rose-500/25'
    : isUp
      ? 'border-emerald-800/45 bg-emerald-950/20 hover:border-emerald-600/55'
      : 'border-rose-800/45 bg-rose-950/20 hover:border-rose-600/55';

  return (
    <div className={`flex min-w-0 flex-1 flex-col rounded-xl border p-3 transition-colors ${shell}`}>
      <button
        type="button"
        onClick={props.onBuy}
        className={`w-full rounded-lg px-3 py-2.5 text-left transition active:scale-[0.99] ${
          isUp
            ? 'bg-emerald-600/90 text-white hover:bg-emerald-500'
            : 'bg-rose-600/90 text-white hover:bg-rose-500'
        }`}
      >
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-90">I&apos;m about to buy</div>
        <div className="mt-0.5 text-base font-black tracking-tight sm:text-lg">{props.label}</div>
        {props.entry01 != null ? (
          <div className="mt-0.5 font-mono text-[11px] tabular-nums opacity-90">@ {fmtCents01(props.entry01)} ask</div>
        ) : null}
      </button>
      {props.advisoryPick ? (
        <span className="mt-1.5 inline-flex w-fit rounded-md border border-indigo-500/40 bg-indigo-950/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-indigo-200">
          Desk pick
        </span>
      ) : null}
      <TpPreview outlook={props.outlook} tpCents={props.tpCents} />
    </div>
  );
}

export function NowPriceBuyStrip(props: {
  slug: string;
  upLabel: string;
  downLabel: string;
  buySideAdvisory?: BuySideAdvisory | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  midUp01: number | null;
  midDown01: number | null;
  bookTouchUp?: BookTouchForArmRisk | null;
  bookTouchDown?: BookTouchForArmRisk | null;
  endsInMs?: number | null;
  leanLane?: 'up' | 'down' | null;
  entryMoment?: EntryMoment | null;
  deskTradeSignal?: NowPriceDeskTradeSignal | null;
  contractLead?: ContractLeadSignal | null;
  pressureTiming?: PressureTiming | null;
}): ReactElement {
  const {
    slug,
    upLabel,
    downLabel,
    buySideAdvisory = null,
    probUp,
    probDown,
    midUp01,
    midDown01,
    bookTouchUp = null,
    bookTouchDown = null,
    endsInMs,
    leanLane = null,
    entryMoment = null,
    deskTradeSignal = null,
    contractLead = null,
    pressureTiming = null,
  } = props;

  const [scalpPrefs, setScalpPrefs] = useState<NowPriceDeskScalpPrefs>(() => loadNowPriceDeskScalpPrefs());
  const [sizeSharesStr, setSizeSharesStr] = useState(() => String(loadAutoTradeSizeShares()));
  const lastAutoKeyRef = useRef<string | null>(null);
  const lastAutoAtRef = useRef(0);

  const persistPrefs = useCallback((next: NowPriceDeskScalpPrefs) => {
    setScalpPrefs(next);
    saveNowPriceDeskScalpPrefs(next);
  }, []);

  const sizeShares = useMemo(() => {
    const n = Number(sizeSharesStr.trim());
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(100_000, n);
  }, [sizeSharesStr]);

  const scalpPlan = useMemo(
    () =>
      buildNowPriceDeskScalpPlan({
        advisory: buySideAdvisory,
        bookTouchUp,
        bookTouchDown,
        midUp01,
        midDown01,
        endsInMs,
        slug,
        scalpPrefs,
        entryMoment,
        contractLead,
        pressureTiming,
      }),
    [buySideAdvisory, bookTouchUp, bookTouchDown, midUp01, midDown01, endsInMs, slug, scalpPrefs, entryMoment, contractLead, pressureTiming],
  );

  const autoBlockReason = useMemo(
    () =>
      deskScalpAutoBlockReason({
        plan: scalpPlan,
        autoEnabled: scalpPrefs.autoDeskScalp,
        submitBuyOnTake: scalpPrefs.submitBuyOnTake,
        sizeShares,
        endsInMs,
        slug,
      }),
    [scalpPlan, scalpPrefs.autoDeskScalp, scalpPrefs.submitBuyOnTake, sizeShares, endsInMs, slug],
  );

  const submitBuy = useMemo(
    () => shouldSubmitDeskScalpBuy(scalpPrefs, sizeShares),
    [scalpPrefs, sizeShares],
  );

  const onTakeDeskScalp = useCallback(() => {
    if (!scalpPlan.canTake) return;
    const result = executeNowPriceDeskScalp(scalpPlan, slug, {
      sizeShares: sizeShares ?? undefined,
      submitBuy,
      endsInMs,
    });
    if (typeof window !== 'undefined') {
      const msg = result.buySubmitted
        ? `Desk scalp submitted · ${scalpPlan.lane === 'up' ? upLabel : downLabel}`
        : result.buySkippedReason ?? 'Desk scalp prefilled — confirm in trade panel.';
      window.dispatchEvent(
        new CustomEvent(BPX_DESK_TOAST_EVENT, {
          detail: { kind: result.buySubmitted ? ('ok' as const) : ('info' as const), message: msg, ttlMs: 7200 },
        }),
      );
    }
  }, [scalpPlan, slug, sizeShares, submitBuy, endsInMs, upLabel, downLabel]);

  const scalpPlanRef = useRef(scalpPlan);
  scalpPlanRef.current = scalpPlan;
  const autoCtxRef = useRef({ slug, sizeShares, submitBuy, endsInMs });
  autoCtxRef.current = { slug, sizeShares, submitBuy, endsInMs };

  useEffect(() => {
    lastAutoKeyRef.current = null;
  }, [slug]);

  useEffect(() => {
    if (!scalpPrefs.autoDeskScalp) return;
    const tick = () => {
      const plan = scalpPlanRef.current;
      const ctx = autoCtxRef.current;
      const block = deskScalpAutoBlockReason({
        plan,
        autoEnabled: true,
        submitBuyOnTake: scalpPrefs.submitBuyOnTake,
        sizeShares: ctx.sizeShares,
        endsInMs: ctx.endsInMs,
        slug: ctx.slug,
      });
      if (block) return;
      if (!plan.canTake || !plan.lane || plan.entry01 == null) return;
      const now = Date.now();
      if (now - lastAutoAtRef.current < AUTO_DESK_SCALP_COOLDOWN_MS) return;
      const sizeKey = ctx.sizeShares != null ? String(ctx.sizeShares) : '';
      const key = `${ctx.slug}|${deskScalpMeaningKey(plan)}|${sizeKey}`;
      if (lastAutoKeyRef.current === key) return;
      lastAutoKeyRef.current = key;
      lastAutoAtRef.current = now;
      executeNowPriceDeskScalp(plan, ctx.slug, {
        sizeShares: ctx.sizeShares ?? undefined,
        submitBuy: ctx.submitBuy,
        endsInMs: ctx.endsInMs,
      });
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [scalpPrefs.autoDeskScalp, scalpPrefs.submitBuyOnTake]);

  const upPrep = useMemo(
    () =>
      laneOutlook({
        lane: 'up',
        touch: bookTouchUp,
        mid01: midUp01,
        probSeries: probUp,
        endsInMs,
      }),
    [bookTouchUp, midUp01, probUp, endsInMs],
  );

  const downPrep = useMemo(
    () =>
      laneOutlook({
        lane: 'down',
        touch: bookTouchDown,
        mid01: midDown01,
        probSeries: probDown,
        endsInMs,
      }),
    [bookTouchDown, midDown01, probDown, endsInMs],
  );

  const deskLane: 'up' | 'down' | null =
    buySideAdvisory?.verdict === 'BUY_UP' ? 'up' : buySideAdvisory?.verdict === 'BUY_DOWN' ? 'down' : null;

  const advisoryLine =
    buySideAdvisory?.verdict === 'NEITHER'
      ? buySideAdvisory.recommendation
      : buySideAdvisory?.verdict === 'BUY_UP' || buySideAdvisory?.verdict === 'BUY_DOWN'
        ? buySideAdvisory.recommendation
        : null;

  const takeDisabled = !scalpPlan.canTake;

  return (
    <div className="rounded-xl border border-indigo-800/40 bg-indigo-950/15 px-3 py-3 ring-1 ring-indigo-500/10">
      {entryMoment &&
      (entryMoment.phase === 'ENTER_NOW' || entryMoment.phase === 'CONFIRMING') ? (
        <div className="mb-3">
          <EntryMomentStrip moment={entryMoment} compact showChecks={false} />
        </div>
      ) : deskTradeSignal && !deskTradeSignal.canTrade && deskTradeSignal.blockers.length > 0 ? (
        <p className="mb-2 text-[10px] leading-snug text-amber-200/90">
          Waiting on: {deskTradeSignal.blockers.join(' · ')}
        </p>
      ) : null}
      <div className="text-[11px] font-semibold text-zinc-300">{shouldBuyPromptLabel(upLabel, downLabel)}</div>
      {buySideAdvisory ? (
        <div className="mt-1.5">
          <BuyAdvisoryMetricsStrip advisory={buySideAdvisory} upLabel={upLabel} downLabel={downLabel} compact />
        </div>
      ) : null}
      {advisoryLine ? (
        <p className="mt-1 text-[10px] leading-snug text-zinc-400">{advisoryLine}</p>
      ) : (
        <p className="mt-1 text-[10px] text-zinc-500">Opens trade panel with limit at ask · TP from your auto-fill prefs</p>
      )}

      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <LaneBuyButton
          lane="up"
          label={upLabel}
          entry01={upPrep.entry01}
          tpCents={upPrep.tpCents}
          outlook={upPrep.outlook}
          favored={deskLane === 'up' || (deskLane == null && leanLane === 'up')}
          advisoryPick={deskLane === 'up'}
          onBuy={() => openNowPriceBuyLane({ slug, lane: 'up', entry01: upPrep.entry01 })}
        />
        <LaneBuyButton
          lane="down"
          label={downLabel}
          entry01={downPrep.entry01}
          tpCents={downPrep.tpCents}
          outlook={downPrep.outlook}
          favored={deskLane === 'down' || (deskLane == null && leanLane === 'down')}
          advisoryPick={deskLane === 'down'}
          onBuy={() => openNowPriceBuyLane({ slug, lane: 'down', entry01: downPrep.entry01 })}
        />
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={takeDisabled}
            onClick={onTakeDeskScalp}
            title={scalpPlan.disabledReason ?? undefined}
            className={`rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-wide transition ${
              takeDisabled
                ? 'cursor-not-allowed border border-zinc-700/50 bg-zinc-900/50 text-zinc-500'
                : 'border border-indigo-500/50 bg-indigo-600/90 text-white hover:bg-indigo-500 active:scale-[0.99]'
            }`}
          >
            {scalpPlan.buttonLabel}
          </button>
          {scalpPlan.stopCentsStr ? (
            <span className="font-mono text-[10px] tabular-nums text-zinc-400">
              SL {scalpPlan.stopCentsStr}¢
              {scalpPlan.tpCentsStr ? ` · TP ${scalpPlan.tpCentsStr}¢` : ''}
            </span>
          ) : null}
        </div>
        {takeDisabled && scalpPlan.disabledReason ? (
          <p className="mt-1.5 text-[10px] text-amber-200/90">{scalpPlan.disabledReason}</p>
        ) : null}

        {scalpPrefs.checklistVisible ? (
          <>
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-zinc-800/50 pt-2.5">
              <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">Auto-trade options</span>
              <button
                type="button"
                onClick={() => persistPrefs({ ...scalpPrefs, checklistVisible: false })}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-700/50 text-zinc-500 transition-colors hover:border-zinc-600 hover:bg-zinc-900/80 hover:text-zinc-200"
                title="Hide auto-trade options"
                aria-label="Close auto-trade options"
              >
                <span className="text-sm leading-none" aria-hidden>
                  ×
                </span>
              </button>
            </div>

            <div className="mt-2 space-y-2">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={scalpPrefs.autoDeskScalp}
              onChange={(e) => persistPrefs({ ...scalpPrefs, autoDeskScalp: e.target.checked })}
            />
            <span className="text-[10px] leading-snug text-zinc-300">
              <span className="font-bold text-indigo-200/95">Auto trade desk pick</span>
              {' — '}
              when Should I buy flips to{' '}
              <span className="font-semibold text-zinc-100">BUY UP/DOWN</span>, run desk scalp once per stable
              signal (45s cooldown). Prefills lane + SL/TP; buy only if Take the buy is on.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={scalpPrefs.submitBuyOnTake}
              onChange={(e) => persistPrefs({ ...scalpPrefs, submitBuyOnTake: e.target.checked })}
            />
            <span className="text-[10px] leading-snug text-zinc-300">
              <span className="font-bold text-indigo-200/95">Take the buy</span>
              {' — '}
              submit limit buy at desk entry in{' '}
              <span className="font-semibold text-zinc-100">Live</span> using share size below. Off = open trade
              panel + arm brackets only.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={scalpPrefs.trailingProfit}
              onChange={(e) => persistPrefs({ ...scalpPrefs, trailingProfit: e.target.checked })}
            />
            <span className="text-[10px] leading-snug text-zinc-300">
              <span className="font-bold text-indigo-200/95">Trailing profit</span>
              {' — '}
              after +2¢ gain, exit on 2¢ pullback from peak (live TP automation). Off = fixed TP only.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-indigo-500"
              checked={scalpPrefs.takeLossWhenDeskTpBelowEntry}
              onChange={(e) =>
                persistPrefs({ ...scalpPrefs, takeLossWhenDeskTpBelowEntry: e.target.checked })
              }
            />
            <span className="text-[10px] leading-snug text-zinc-300">
              <span className="font-bold text-indigo-200/95">Take loss when desk TP below entry</span>
              {' — '}
              exit immediately when live Targets TP drops under your fill (cut before SL).
            </span>
          </label>
        </div>

        {scalpPrefs.autoDeskScalp && autoBlockReason ? (
          <p className="mt-2 text-[10px] leading-snug text-amber-200/90">{autoBlockReason}</p>
        ) : scalpPrefs.autoDeskScalp && scalpPlan.canTake ? (
          <p className="mt-2 text-[10px] leading-snug text-indigo-200/70">
            Auto armed · fires when desk pick is ready
            {scalpPrefs.submitBuyOnTake ? ` · ${sizeSharesStr.trim() || '—'} sh` : ' · prefill only'}
          </p>
        ) : null}

        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Shares</span>
            <input
              type="text"
              inputMode="decimal"
              value={sizeSharesStr}
              onChange={(e) => setSizeSharesStr(e.target.value)}
              onBlur={() => {
                if (sizeShares != null) saveAutoTradeSizeShares(sizeShares);
              }}
              className="rounded border border-zinc-700/60 bg-zinc-900/80 px-2 py-1 font-mono text-[11px] text-zinc-100"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Global SL (¢ below fill)</span>
            <input
              type="text"
              inputMode="decimal"
              value={scalpPrefs.globalStopLossCents}
              onChange={(e) =>
                persistPrefs({ ...scalpPrefs, globalStopLossCents: e.target.value })
              }
              placeholder="e.g. 8"
              className="rounded border border-zinc-700/60 bg-zinc-900/80 px-2 py-1 font-mono text-[11px] text-zinc-100"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 self-end">
            <input
              type="checkbox"
              className="accent-indigo-500"
              checked={scalpPrefs.useGlobalStopOnEveryBuy}
              onChange={(e) =>
                persistPrefs({ ...scalpPrefs, useGlobalStopOnEveryBuy: e.target.checked })
              }
            />
            <span className="text-[10px] text-zinc-300">SL on every buy</span>
          </label>
        </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => persistPrefs({ ...scalpPrefs, checklistVisible: true })}
            className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-zinc-700/50 bg-zinc-900/30 px-2.5 py-1.5 text-left transition-colors hover:border-indigo-600/40 hover:bg-indigo-950/20"
            title="Show auto-trade options"
          >
            <span className="text-[10px] font-semibold text-zinc-400">Auto-trade options</span>
            <span className="text-[10px] text-indigo-300/80">Show</span>
          </button>
        )}
      </div>
    </div>
  );
}
