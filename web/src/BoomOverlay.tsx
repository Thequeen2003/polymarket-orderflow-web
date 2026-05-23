import type { ReactElement } from 'react';

import type { TradeEdge } from './tradeEdgeCalculator';
import type { TradeLevels } from './tradeLevels';

export type BoomOverlayKind = 'OPPOSITE_INCOMING' | 'EXIT_NOW' | 'TRIPLE_CONFIRM_ENTRY';

export function BoomOverlay({
  kind,
  lane,
  laneLabel,
  oppositeLabel,
  headline,
  reason,
  etaSec,
  levels,
  agreementScore,
  crossProb,
  incomingEdge,
  oppositeMid,
  warmupNotice = false,
  structuralVsCardClash = false,
  onDismiss,
}: {
  kind: BoomOverlayKind;
  lane: 'up' | 'down';
  laneLabel: string;
  oppositeLabel: string;
  headline: string;
  reason: string;
  etaSec: number | null;
  levels: TradeLevels | null;
  agreementScore: number | null;
  crossProb: number | null;
  incomingEdge: TradeEdge | null;
  oppositeMid: number | null;
  /** No trade directive yet — alert is structural; sync with card when it appears. */
  warmupNotice?: boolean;
  /** Card exists but verdict is STAND_DOWN — structural boom still visible; execution defers to card. */
  structuralVsCardClash?: boolean;
  onDismiss: () => void;
}): ReactElement {
  const palette = (() => {
    if (kind === 'TRIPLE_CONFIRM_ENTRY') {
      return lane === 'up'
        ? {
            ring: 'ring-emerald-300',
            glow: 'shadow-[0_0_60px_rgba(52,211,153,0.55),inset_0_0_20px_rgba(52,211,153,0.35)]',
            bg: 'from-emerald-500/40 via-emerald-700/30 to-emerald-950/40',
            stripe: 'bg-emerald-300',
            chip: 'bg-emerald-200 text-emerald-950',
            text: 'text-emerald-50',
            icon: '🟢',
            tag: 'TRIPLE CONFIRM',
          }
        : {
            ring: 'ring-rose-300',
            glow: 'shadow-[0_0_60px_rgba(248,113,113,0.55),inset_0_0_20px_rgba(248,113,113,0.35)]',
            bg: 'from-rose-500/40 via-rose-700/30 to-rose-950/40',
            stripe: 'bg-rose-300',
            chip: 'bg-rose-200 text-rose-950',
            text: 'text-rose-50',
            icon: '🔴',
            tag: 'TRIPLE CONFIRM',
          };
    }
    if (kind === 'EXIT_NOW') {
      return {
        ring: 'ring-amber-300',
        glow: 'shadow-[0_0_60px_rgba(252,211,77,0.55),inset_0_0_20px_rgba(252,165,165,0.35)]',
        bg: 'from-amber-500/45 via-rose-700/35 to-amber-950/40',
        stripe: 'bg-amber-300',
        chip: 'bg-amber-200 text-amber-950',
        text: 'text-amber-50',
        icon: '🛑',
        tag: 'EXIT NOW',
      };
    }
    return lane === 'up'
      ? {
          ring: 'ring-amber-300',
          glow: 'shadow-[0_0_60px_rgba(252,211,77,0.65),inset_0_0_22px_rgba(52,211,153,0.30)]',
          bg: 'from-amber-500/45 via-emerald-600/35 to-indigo-900/40',
          stripe: 'bg-amber-300',
          chip: 'bg-emerald-200 text-emerald-950',
          text: 'text-amber-50',
          icon: '⚡',
          tag: 'OPPOSITE MOMENTUM',
        }
      : {
          ring: 'ring-amber-300',
          glow: 'shadow-[0_0_60px_rgba(252,211,77,0.65),inset_0_0_22px_rgba(248,113,113,0.30)]',
          bg: 'from-amber-500/45 via-rose-600/35 to-indigo-900/40',
          stripe: 'bg-amber-300',
          chip: 'bg-rose-200 text-rose-950',
          text: 'text-amber-50',
          icon: '⚡',
          tag: 'OPPOSITE MOMENTUM',
        };
  })();

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`relative mb-2 overflow-hidden rounded-3xl border-4 border-double bg-gradient-to-r ${palette.bg} px-4 py-4 ring-4 ${palette.ring} ${palette.glow} sm:px-6 sm:py-5`}
    >
      <span className={`absolute inset-x-0 top-0 h-1 ${palette.stripe} animate-pulse`} />
      <span className={`absolute inset-x-0 bottom-0 h-1 ${palette.stripe} animate-pulse`} />
      <span
        className="pointer-events-none absolute -left-3 top-0 h-full w-6 opacity-60"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 8px, rgba(0,0,0,0.45) 8px 16px)',
        }}
      />
      <div className="relative flex flex-wrap items-center gap-3 sm:gap-5">
        <span
          className={`inline-flex h-12 w-12 shrink-0 animate-bounce items-center justify-center rounded-2xl ${palette.chip} text-2xl shadow-lg shadow-black/40 sm:h-14 sm:w-14 sm:text-3xl`}
        >
          {palette.icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.2em] ${palette.chip}`}
            >
              {palette.tag}
            </span>
            <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${palette.text}/85`}>
              {kind === 'TRIPLE_CONFIRM_ENTRY'
                ? warmupNotice
                  ? `Sensors aligned · ${laneLabel}`
                  : `Spot · Sectional · Flow ✓ · Lane ${laneLabel}`
                : kind === 'EXIT_NOW'
                  ? warmupNotice
                    ? `Rotate toward ${laneLabel}`
                    : `Lane ${oppositeLabel} → ${laneLabel} taking over`
                  : `Incoming ${laneLabel} · fading ${oppositeLabel}`}
            </span>
            {etaSec != null && kind === 'OPPOSITE_INCOMING' ? (
              <span className="rounded-md border border-amber-200/70 bg-amber-200/15 px-2 py-0.5 text-[10px] font-black tracking-wide text-amber-50">
                ETA ~{etaSec}s
              </span>
            ) : null}
          </div>
          <div className={`text-xl font-black uppercase leading-tight tracking-tight sm:text-3xl ${palette.text}`}>
            {headline}
          </div>
          <p className={`text-[11px] leading-relaxed ${palette.text}/85 sm:text-xs`}>{reason}</p>
          {(kind === 'OPPOSITE_INCOMING' || kind === 'EXIT_NOW') && (
            <div className="mt-2 grid max-w-md gap-2 sm:grid-cols-2">
              {agreementScore != null ? (
                <div>
                  <div className={`flex justify-between text-[9px] font-bold uppercase tracking-wide ${palette.text}/60`}>
                    <span>Sensor agree</span>
                    <span className="tabular-nums">{Math.round(agreementScore)}%</span>
                  </div>
                  <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/15">
                    <div
                      className="h-full rounded-full bg-emerald-300/90"
                      style={{ width: `${Math.min(100, Math.round(agreementScore))}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {crossProb != null ? (
                <div>
                  <div className={`flex justify-between text-[9px] font-bold uppercase tracking-wide ${palette.text}/60`}>
                    <span>PTB cross</span>
                    <span className="tabular-nums">{Math.round(crossProb * 100)}%</span>
                  </div>
                  <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-black/40 ring-1 ring-white/15">
                    <div
                      className={`h-full rounded-full ${
                        crossProb >= 0.7 ? 'bg-fuchsia-400/90' : crossProb >= 0.4 ? 'bg-amber-300/90' : 'bg-emerald-300/85'
                      }`}
                      style={{ width: `${Math.min(100, Math.round(crossProb * 100))}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}
          {warmupNotice ? (
            <p className="mt-1 rounded-md border border-zinc-600/50 bg-black/40 px-2 py-1 text-[10px] leading-snug text-zinc-400">
              <span className="font-bold text-zinc-200">Chart only</span> — no trade card yet; use card TP/SL when it
              appears.
            </p>
          ) : structuralVsCardClash && (kind === 'OPPOSITE_INCOMING' || kind === 'EXIT_NOW') ? (
            <p className="mt-1 rounded-md border border-amber-500/40 bg-amber-950/35 px-2 py-1 text-[10px] leading-snug text-amber-100/90">
              <span className="font-bold text-amber-50">Trade card says wait</span> — this boom is structural tape;
              follow card TP/SL and verdict when guards clear.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={`shrink-0 rounded-lg border border-white/30 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${palette.text} hover:bg-white/10`}
          aria-label="Dismiss confirmation"
        >
          Dismiss
        </button>
      </div>

      <div className={`relative mt-3 border-t border-white/25 pt-3 ${palette.text}`}>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[9px] font-black uppercase tracking-[0.15em] text-white/45">
            {warmupNotice ? 'Desk' : 'Signals'}
          </span>
          {agreementScore != null ? (
            <span
              className="rounded-md border border-white/25 bg-black/35 px-2 py-0.5 text-[10px] font-black tabular-nums text-white/95"
              title="Machine sensor agreement score"
            >
              agree {Math.round(agreementScore)}%
            </span>
          ) : (
            <span className="rounded-md border border-white/15 bg-black/25 px-2 py-0.5 text-[10px] text-white/40">agree —</span>
          )}
          {crossProb != null ? (
            <span
              className="rounded-md border border-sky-300/35 bg-sky-950/40 px-2 py-0.5 text-[10px] font-bold tabular-nums text-sky-100"
              title="PTB cross probability before bell"
            >
              cross {Math.round(crossProb * 100)}%
            </span>
          ) : null}
          {incomingEdge ? (
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-black tabular-nums ${
                incomingEdge.edgePerShareUsd >= 0.05
                  ? 'border-emerald-300/45 bg-emerald-950/45 text-emerald-50'
                  : incomingEdge.edgePerShareUsd >= 0.015
                    ? 'border-amber-300/40 bg-amber-950/35 text-amber-50'
                    : incomingEdge.edgePerShareUsd > 0
                      ? 'border-zinc-500/50 bg-zinc-950/40 text-zinc-200'
                      : 'border-rose-400/45 bg-rose-950/40 text-rose-100'
              }`}
              title={incomingEdge.summary}
            >
              edge {incomingEdge.edgePerShareUsd >= 0 ? '+' : ''}
              {incomingEdge.edgePerShareUsd.toFixed(2)}{' '}
              <span className="font-bold opacity-90">{incomingEdge.quality}</span>
            </span>
          ) : (
            <span className="rounded-md border border-white/15 bg-black/25 px-2 py-0.5 text-[10px] text-white/45">
              edge —
            </span>
          )}
          {incomingEdge ? (
            <span className="rounded-md border border-white/20 bg-black/30 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-white/85">
              model {Math.round(incomingEdge.pWin * 100)}% vs mid {incomingEdge.mid.toFixed(2)}
            </span>
          ) : null}
        </div>

        {levels?.collapsed ? (
          <p className="rounded-lg border border-amber-400/45 bg-amber-950/30 px-2.5 py-2 text-[11px] leading-snug text-amber-50">
            {levels.summary}
          </p>
        ) : levels ? (
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/20 bg-black/35 px-3 py-2.5">
            <div className="flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-wider text-white/45">Entry</span>
              <span className="font-mono text-sm font-bold tabular-nums text-white">{levels.entry.toFixed(2)}</span>
            </div>
            <div className="flex flex-col">
              <span
                className={`text-[9px] font-black uppercase tracking-wider ${
                  lane === 'down' ? 'text-sky-300/90' : 'text-emerald-300/90'
                }`}
              >
                Take profit
              </span>
              <span
                className={`font-mono text-sm font-black tabular-nums ${
                  lane === 'down' ? 'text-sky-100' : 'text-emerald-100'
                }`}
              >
                {levels.takeProfit.toFixed(2)}{' '}
                <span
                  className={`text-[10px] font-semibold ${
                    lane === 'down' ? 'text-sky-300/90' : 'text-emerald-300/90'
                  }`}
                >
                  +{levels.takeProfitGain.toFixed(2)}
                </span>
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] font-black uppercase tracking-wider text-rose-300/90">Stop loss</span>
              <span className="font-mono text-sm font-black tabular-nums text-rose-100">
                {levels.stopLoss.toFixed(2)}{' '}
                <span className="text-[10px] font-semibold text-rose-300/90">
                  −{levels.stopLossLoss.toFixed(2)}
                </span>
              </span>
            </div>
            <div className="col-span-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2 text-[10px]">
              <span className="font-bold uppercase tracking-wider text-white/50">
                R:R{' '}
                <strong
                  className={`tabular-nums ${
                    levels.rrRatio >= 1.3
                      ? lane === 'down'
                        ? 'text-sky-200'
                        : 'text-emerald-200'
                      : levels.rrRatio >= 1
                        ? 'text-amber-200'
                        : 'text-white/70'
                  }`}
                >
                  {levels.rrRatio.toFixed(2)}
                </strong>
              </span>
              <span className="max-w-full truncate text-[10px] font-semibold text-white/55" title={levels.summary}>
                {laneLabel} lane · {warmupNotice ? 'matches card math when card loads' : 'same TP/SL math as trade card'}
              </span>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-white/15 bg-black/30 px-2.5 py-2 text-[11px] leading-relaxed text-white/75">
            {incomingEdge && incomingEdge.edgePerShareUsd <= 0
              ? `No auto TP/SL on this alert — ${laneLabel} is flat or −EV vs the terminal model at the current mid. Use TRIM / EXIT / trade card for risk.`
              : incomingEdge == null
                ? 'TP/SL appear when implied mids and terminal probabilities are both available.'
                : 'Edge too thin for mechanical TP/SL — trail with HOLD / TRIM / EXIT signals.'}
          </p>
        )}

        {kind === 'EXIT_NOW' && oppositeMid != null ? (
          <p className="mt-2 text-[11px] leading-snug text-white/85">
            <span className="font-black uppercase tracking-wide text-amber-200/95">Exit focus — </span>
            trim or close <strong className="text-white">{oppositeLabel}</strong> exposure — implied mid{' '}
            <span className="font-mono font-bold tabular-nums text-white">{oppositeMid.toFixed(2)}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
