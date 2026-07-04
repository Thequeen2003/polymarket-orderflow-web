import type { ReactElement } from 'react';
import type { BinaryBiasSignal, BinaryOutcomeEstimate, SettlementBiasDualReadout } from './binaryOutcomeBias';

function fmtProbPct01(p01: number | null | undefined): string {
  if (p01 == null || !Number.isFinite(p01)) return '—';
  const clamped = Math.max(0, Math.min(1, p01));
  const pct = clamped * 100;
  if (pct > 0 && pct < 0.01) return '<0.01%';
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return pct >= 10 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

function fmtPctDelta(model: number | null, market: number | null): string {
  if (model == null || market == null || !Number.isFinite(model) || !Number.isFinite(market)) return '';
  const d = (model - market) * 100;
  if (Math.abs(d) < 0.05) return '≈ market';
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}pp vs book`;
}

function signalTone(bounded: number): 'up' | 'down' | 'flat' {
  if (bounded > 0.12) return 'up';
  if (bounded < -0.12) return 'down';
  return 'flat';
}

function biasArrow(bounded: number): string {
  if (bounded > 0.08) return '↑';
  if (bounded < -0.08) return '↓';
  return '→';
}

export function SettlementBiasModelCard(props: {
  estimate: BinaryOutcomeEstimate;
  upLabel: string;
  downLabel: string;
  normMarketUp: number | null;
  dual?: SettlementBiasDualReadout | null;
  embedded?: boolean;
  compactSignals?: boolean;
}): ReactElement {
  const { estimate, upLabel, normMarketUp, dual = null, embedded = false, compactSignals = false } = props;

  return (
    <div className={embedded ? 'min-w-0' : 'rounded-xl border border-violet-800/45 bg-violet-950/20 px-3 py-3 sm:px-4'}>
      {!embedded ? (
        <div className="mb-3 min-w-0">
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-300/90">
            Signal breakdown
          </div>
          <p className="mt-1 max-w-2xl text-[10px] leading-snug text-zinc-500">
            Finish score = σ(all factors). Momentum now = spot drift or contract tape when it moves.
          </p>
        </div>
      ) : dual ? (
        <div className="mb-2 rounded-lg border border-zinc-800/50 bg-black/20 px-2 py-1.5 text-[9px] text-zinc-500">
          <span className="font-semibold text-zinc-400">A+C+D</span> drive finish ·{' '}
          <span className="font-semibold text-violet-300/90">B+tape</span> = momentum tile above
        </div>
      ) : null}
      <div className={`flex flex-wrap gap-2 ${embedded ? '' : 'mb-3'}`}>
        <div className="rounded-lg border border-zinc-700/45 bg-black/20 px-2 py-1.5 text-center">
          <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">P_mkt {upLabel}</div>
          <div className="font-mono text-sm font-semibold tabular-nums text-zinc-400">{fmtProbPct01(normMarketUp)}</div>
        </div>
        <div className="rounded-lg border border-zinc-700/45 bg-black/20 px-2 py-1.5 text-center">
          <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Model edge</div>
          <div className="font-mono text-sm font-semibold tabular-nums text-violet-200/90">
            {fmtPctDelta(estimate.probUp, normMarketUp) || '—'}
          </div>
        </div>
      </div>

      <div className={`grid gap-2 ${compactSignals ? 'sm:grid-cols-2' : 'sm:grid-cols-2'}`}>
        {estimate.signals.map((sig: BinaryBiasSignal) => (
          <div
            key={sig.id}
            className={`rounded-lg border px-2.5 py-2 ${
              sig.id === 'momentumNorm'
                ? 'border-violet-600/45 bg-violet-950/25 ring-1 ring-violet-500/20'
                : signalTone(sig.bounded) === 'up'
                  ? 'border-emerald-800/40 bg-emerald-950/15'
                  : signalTone(sig.bounded) === 'down'
                    ? 'border-rose-800/40 bg-rose-950/15'
                    : 'border-zinc-800/50 bg-black/20'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[10px] font-semibold text-zinc-200">
                {sig.label}{' '}
                <span
                  className={
                    signalTone(sig.bounded) === 'up'
                      ? 'text-emerald-300'
                      : signalTone(sig.bounded) === 'down'
                        ? 'text-rose-300'
                        : 'text-zinc-500'
                  }
                  aria-hidden
                >
                  {biasArrow(sig.bounded)}
                </span>
              </div>
              <div className="font-mono text-[11px] tabular-nums text-violet-200/90">
                {sig.contribution >= 0 ? '+' : ''}
                {sig.contribution.toFixed(2)} score
              </div>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{sig.formula}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-zinc-400">
              <span>
                raw{' '}
                {sig.id === 'ptbDistance'
                  ? `${sig.raw >= 0 ? '+' : ''}${(sig.raw * 100).toFixed(3)}%`
                  : `${sig.raw >= 0 ? '+' : ''}${sig.raw.toFixed(4)}`}
              </span>
              <span>
                bounded {sig.bounded >= 0 ? '+' : ''}
                {sig.bounded.toFixed(3)}
              </span>
              <span>
                w×b {sig.contribution >= 0 ? '+' : ''}
                {sig.contribution.toFixed(2)}
              </span>
            </div>
            <div className="mt-1 text-[10px] leading-snug text-zinc-500">{sig.interpretation}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/5 pt-2 font-mono text-[10px] tabular-nums text-zinc-500">
        <span>
          Score{' '}
          <span className="font-semibold text-violet-200/90">
            {estimate.score >= 0 ? '+' : ''}
            {estimate.score.toFixed(3)}
          </span>
        </span>
        <span>σ(score) → P̂({upLabel}) {fmtProbPct01(estimate.probUp)}</span>
        <span>horizon {estimate.horizonSec}s</span>
        {estimate.missing.length ? (
          <span className="text-amber-400/90">partial: {estimate.missing.join(', ')}</span>
        ) : null}
      </div>
    </div>
  );
}
