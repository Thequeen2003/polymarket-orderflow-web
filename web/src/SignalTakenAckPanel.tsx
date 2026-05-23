import { type ReactElement } from 'react';
import type { SignalTakenPlaybook } from './signalTakenPlaybook';
import type { PositionDeskAlert } from './positionDeskAlerts';
import type { HeldSideDeskMetrics } from './heldSideDeskMetrics';

export function SignalTakenAckPanel(props: {
  upLabel: string;
  downLabel: string;
  manualLane: 'up' | 'down' | null;
  /** Take-signal / auto-trade waiting for wallet shares before I hold lights up. */
  pendingHoldLane?: 'up' | 'down' | null;
  onPickLane: (lane: 'up' | 'down' | null) => void;
  /** One control: clears saved desk state, side tag, journal, and chart mini-tape for this market. */
  onResetDesk: () => void;
  /** Clears I hold tags on every market saved in this browser (keeps journals). */
  onClearAllHolds?: () => void;
  playbook: SignalTakenPlaybook | null;
  /** EXIT / switch / tape vs held shares — shown when positioned. */
  positionAlerts?: PositionDeskAlert[] | null;
  /** Live glance numbers for the outcome you marked (implied mid, bell, cross, tape, …). */
  heldMetrics?: HeldSideDeskMetrics | null;
}): ReactElement {
  const {
    upLabel,
    downLabel,
    manualLane,
    pendingHoldLane = null,
    onPickLane,
    onResetDesk,
    onClearAllHolds,
    playbook,
    positionAlerts = null,
    heldMetrics = null,
  } = props;

  const toneRing =
    playbook?.tone === 'risk'
      ? 'border-rose-800/50 bg-rose-950/20 ring-rose-900/25'
      : playbook?.tone === 'caution'
        ? 'border-amber-800/45 bg-amber-950/18 ring-amber-900/22'
        : 'border-emerald-800/40 bg-emerald-950/15 ring-emerald-900/20';

  return (
    <div className="rounded-2xl border border-zinc-800/55 bg-zinc-950/40 p-4 ring-1 ring-white/[0.03]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        {manualLane == null
          ? 'Mark your Polymarket fill'
          : heldMetrics
            ? `You are in · ${heldMetrics.holdBanner}`
            : `You are in · ${manualLane === 'up' ? upLabel : downLabel}`}
      </div>
      {manualLane != null && heldMetrics ? (
        <div className="mt-3 space-y-2">
          {heldMetrics.holdAnchorMid !== '—' ? (
            <div
              className="rounded-lg border border-teal-600/35 bg-teal-950/20 px-2.5 py-2 ring-1 ring-teal-500/10"
              title="Touch mid for your outcome when you tapped I hold — your price anchor for this round."
            >
              <div className="text-[9px] font-bold uppercase tracking-wider text-teal-300/90">Price signal · your tag</div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-mono text-[15px] font-black tabular-nums text-teal-50">{heldMetrics.holdAnchorMid}</span>
                <span className="font-mono text-[11px] font-semibold tabular-nums text-teal-200/85">{heldMetrics.vsHoldTag}</span>
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div
              className="rounded-lg border border-violet-500/40 bg-violet-950/25 px-2.5 py-2 ring-1 ring-violet-500/15"
              title="CLOB touch mid for the outcome you tapped — not spot USD."
            >
              <div className="text-[9px] font-bold uppercase tracking-wider text-violet-300/90">Your token mid</div>
              <div className="mt-0.5 font-mono text-[14px] font-black tabular-nums text-violet-50">{heldMetrics.impliedMid}</div>
            </div>
            <div className="rounded-lg border border-zinc-700/60 bg-black/35 px-2.5 py-2" title="Since you tapped I hold · …">
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">In trade</div>
              <div className="mt-0.5 font-mono text-[14px] font-black tabular-nums text-zinc-100">{heldMetrics.inTrade}</div>
            </div>
            <div className="rounded-lg border border-zinc-700/60 bg-black/35 px-2.5 py-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Bell</div>
              <div className="mt-0.5 font-mono text-[14px] font-black tabular-nums text-zinc-100">{heldMetrics.bell}</div>
            </div>
            <div className="rounded-lg border border-zinc-700/60 bg-black/35 px-2.5 py-2">
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">PTB cross</div>
              <div className="mt-0.5 font-mono text-[14px] font-black tabular-nums text-zinc-100">{heldMetrics.cross}</div>
            </div>
            <div
              className="rounded-lg border border-zinc-700/60 bg-black/35 px-2.5 py-2"
              title="Fused sensor vote on the machine’s current focus lane — can differ from the side you marked."
            >
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Sensor agree</div>
              <div className="mt-0.5 font-mono text-[14px] font-black tabular-nums text-zinc-100">{heldMetrics.agreement}</div>
            </div>
            <div className="rounded-lg border border-zinc-700/60 bg-black/35 px-2.5 py-2" title="Desk tape on your outcome’s prints">
              <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Desk tape</div>
              <div className="mt-0.5 text-[12px] font-semibold leading-snug text-zinc-200">{heldMetrics.tape}</div>
            </div>
          </div>
          <div
            className="rounded-lg border border-zinc-600/55 bg-zinc-900/50 px-2.5 py-2"
            title="Live trade card line — may differ from your fill if the model rotated."
          >
            <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Trade card</div>
            <div className="mt-0.5 font-mono text-[12px] font-bold leading-snug text-zinc-100">{heldMetrics.card}</div>
          </div>
        </div>
      ) : null}
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
        {manualLane == null ? (
          <>
            After you read the <span className="font-medium text-zinc-300">Do this now</span> strip and <span className="font-medium text-zinc-300">trade card</span> and place on Polymarket, tap the outcome shares you{' '}
            <span className="font-medium text-zinc-300">actually hold</span> ({upLabel} or {downLabel}). The card already lists TP/SL for both outcomes; that tap adds the <span className="font-medium text-zinc-300">You</span> tag, exit timing, and tape-aware alerts for your side.{' '}
            <span className="text-zinc-600">
              WAIT / DON&apos;T TRADE on the card is the model read — if it fights what you did, use <span className="font-medium text-zinc-400">Reset desk</span> below (one place) to clear your tag and saved desk; the card keeps updating live.
            </span>
          </>
        ) : (
          <>
            Live <span className="font-medium text-zinc-300">Exit & timing</span> on the card; your <span className="font-medium text-zinc-300">Do this now</span> strip above stays the single action line while you hold. TP/SL shows both outcomes; red/amber strips here add detail on EXIT, switch, or tape.
            <span className="mt-1.5 block text-[10px] leading-snug text-zinc-500">
              This tag is saved in <span className="font-medium text-zinc-400">this browser</span> for this market (refresh keeps it). If you didn&apos;t mean to be in a side, tap <span className="font-medium text-zinc-400">Reset desk</span> — it wasn&apos;t the model guessing; it was a stored pick from an earlier visit.
            </span>
            <span className="text-zinc-600">
              Done with this round or the card feels wrong vs your fill? <span className="font-medium text-zinc-400">Reset desk</span> below clears your tag and saved desk in one tap.
            </span>
          </>
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onPickLane(manualLane === 'up' ? null : 'up')}
          className={`min-h-[40px] rounded-xl border px-4 py-2 text-sm font-bold transition-colors ${
            manualLane === 'up'
              ? 'border-emerald-500/60 bg-emerald-950/35 text-emerald-100 shadow-md shadow-emerald-950/25'
              : pendingHoldLane === 'up'
                ? 'border-emerald-600/45 bg-emerald-950/20 text-emerald-200/90 ring-1 ring-emerald-500/30 animate-pulse'
                : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300 hover:border-emerald-700/40 hover:text-emerald-100/90'
          }`}
        >
          {pendingHoldLane === 'up' && manualLane !== 'up' ? `Filling · ${upLabel}…` : `I hold · ${upLabel}`}
        </button>
        <button
          type="button"
          onClick={() => onPickLane(manualLane === 'down' ? null : 'down')}
          className={`min-h-[40px] rounded-xl border px-4 py-2 text-sm font-bold transition-colors ${
            manualLane === 'down'
              ? 'border-rose-500/55 bg-rose-950/35 text-rose-100 shadow-md shadow-rose-950/25'
              : pendingHoldLane === 'down'
                ? 'border-rose-600/45 bg-rose-950/20 text-rose-200/90 ring-1 ring-rose-500/30 animate-pulse'
                : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300 hover:border-rose-700/40 hover:text-rose-100/90'
          }`}
        >
          {pendingHoldLane === 'down' && manualLane !== 'down' ? `Filling · ${downLabel}…` : `I hold · ${downLabel}`}
        </button>
      </div>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => onResetDesk()}
          className="w-full min-h-[44px] rounded-xl border border-amber-500/55 bg-amber-950/35 px-4 py-2.5 text-center text-sm font-bold text-amber-50 hover:border-amber-400/70 hover:bg-amber-950/50"
        >
          I didn&apos;t buy this — reset
        </button>
        <p className="mt-1.5 text-center text-[10px] leading-snug text-zinc-600">
          Clears <span className="font-medium text-zinc-400">I hold</span> tags (all markets), share display latch, and saved desk state — then re-reads balances. Does not sell on Polymarket.
        </p>
        {onClearAllHolds ? (
          <button
            type="button"
            onClick={() => onClearAllHolds()}
            className="mt-2 w-full min-h-[36px] rounded-xl border border-zinc-700/60 bg-zinc-950/40 px-3 py-2 text-center text-[11px] font-semibold text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          >
            Clear I hold tags only (keep journal)
          </button>
        ) : null}
      </div>

      {manualLane != null && positionAlerts && positionAlerts.length > 0 ? (
        <div className="mt-3 space-y-2">
          {positionAlerts.map((a, i) => (
            <div
              key={i}
              className={`rounded-xl border px-3 py-2 text-[11px] font-semibold leading-snug ${
                a.kind === 'danger'
                  ? 'border-rose-600/50 bg-rose-950/35 text-rose-50'
                  : a.kind === 'warn'
                    ? 'border-amber-600/45 bg-amber-950/25 text-amber-50'
                    : 'border-sky-700/45 bg-sky-950/20 text-sky-100'
              }`}
            >
              {a.text}
            </div>
          ))}
        </div>
      ) : null}

      {manualLane != null && playbook ? (
        <div className={`mt-4 rounded-xl border px-3 py-3 ring-1 ${toneRing}`}>
          <div className="text-[12px] font-bold tracking-tight text-zinc-100">{playbook.headline}</div>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[11px] leading-snug text-zinc-300">
            {playbook.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : manualLane != null ? (
        <p className="mt-3 text-[11px] text-zinc-600">Locking your entry side — filling trade-entry playbook…</p>
      ) : null}
    </div>
  );
}
