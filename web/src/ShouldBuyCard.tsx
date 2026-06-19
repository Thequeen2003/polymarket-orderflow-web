import { useState, type ReactElement } from 'react';
import type { BuySideAdvisory } from './shouldBuyWhichSide';

type Props = {
  advisory: BuySideAdvisory | null;
  onAsk: () => void;
  upLabel?: string;
  downLabel?: string;
  /** When true, advisory refreshes automatically — no manual ask button when empty. */
  autoAsk?: boolean;
};

function verdictColor(verdict: BuySideAdvisory['verdict']): string {
  if (verdict === 'BUY_UP') return 'text-emerald-200';
  if (verdict === 'BUY_DOWN') return 'text-rose-200';
  return 'text-zinc-400';
}

function verdictBorder(verdict: BuySideAdvisory['verdict']): string {
  if (verdict === 'BUY_UP') return 'border-emerald-600/50';
  if (verdict === 'BUY_DOWN') return 'border-rose-600/50';
  return 'border-zinc-700/60';
}

function verdictBg(verdict: BuySideAdvisory['verdict']): string {
  if (verdict === 'BUY_UP') return 'bg-emerald-950/30';
  if (verdict === 'BUY_DOWN') return 'bg-rose-950/30';
  return 'bg-zinc-950/35';
}

function confBadge(conf: BuySideAdvisory['confidence']): ReactElement {
  const cls =
    conf === 'HIGH'
      ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/40'
      : conf === 'MED'
        ? 'bg-amber-900/40 text-amber-300 border-amber-700/40'
        : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/40';
  return (
    <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${cls}`}>
      {conf}
    </span>
  );
}

function shortOutcomeLabel(name: string | undefined, fallback: string): string {
  const s = (name ?? fallback).trim();
  if (!s) return fallback;
  if (s.length <= 12) return s.toUpperCase();
  const first = s.split(/\s+/)[0] ?? s;
  return first.length > 10 ? `${first.slice(0, 9)}…` : first.toUpperCase();
}

export function shouldBuyPromptLabel(upLabel?: string, downLabel?: string): string {
  const up = (upLabel ?? 'UP').toUpperCase();
  const down = (downLabel ?? 'DOWN').toUpperCase();
  if (up === 'UP' && down === 'DOWN') return 'Should I buy UP or DOWN?';
  return `Should I buy ${shortOutcomeLabel(upLabel, 'UP')} or ${shortOutcomeLabel(downLabel, 'DOWN')}?`;
}

export function ShouldBuyCard({ advisory, onAsk, upLabel, downLabel, autoAsk = false }: Props): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const scoreUp = shortOutcomeLabel(upLabel, 'UP');
  const scoreDown = shortOutcomeLabel(downLabel, 'DOWN');

  if (!advisory) {
    if (autoAsk) {
      return (
        <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-zinc-400">{shouldBuyPromptLabel(upLabel, downLabel)}</span>
            <span className="text-[10px] font-medium text-zinc-500">Auto-asking…</span>
          </div>
        </div>
      );
    }
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-3">
        <button
          type="button"
          onClick={onAsk}
          className="w-full rounded-xl border border-indigo-600/50 bg-indigo-950/40 px-4 py-2.5 text-sm font-semibold text-indigo-200 transition-colors hover:border-indigo-500/70 hover:bg-indigo-950/60 hover:text-indigo-100 active:scale-[0.98]"
        >
          {shouldBuyPromptLabel(upLabel, downLabel)}
        </button>
      </div>
    );
  }

  const { verdict, confidence, recommendation, reasons, risks, suggestedSize, edgePerShareUsd, winProb, mid, scores, cautionFresh } = advisory;

  const verdictText =
    verdict === 'BUY_UP'
      ? `BUY ${(upLabel ?? 'UP').toUpperCase()}`
      : verdict === 'BUY_DOWN'
        ? `BUY ${(downLabel ?? 'DOWN').toUpperCase()}`
        : 'NEITHER — STAY FLAT';

  return (
    <div className={`rounded-2xl border ${verdictBorder(verdict)} ${verdictBg(verdict)} p-3 space-y-2`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold tracking-tight ${verdictColor(verdict)}`}>
            {verdictText}
          </span>
          {confBadge(confidence)}
          {cautionFresh && (
            <span className="inline-block rounded-md border border-amber-700/40 bg-amber-900/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
              FRESH
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onAsk}
          className="rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-2 py-1 text-[10px] font-semibold text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
        >
          Re-ask
        </button>
      </div>

      <p className="text-[11px] leading-snug text-zinc-300">{recommendation}</p>

      {verdict !== 'NEITHER' && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-400">
          {edgePerShareUsd != null && (
            <span>Edge <span className="font-semibold text-zinc-200">{edgePerShareUsd >= 0 ? '+' : ''}{edgePerShareUsd.toFixed(3)}</span>/sh</span>
          )}
          {winProb != null && (
            <span>P(win) <span className="font-semibold text-zinc-200">{Math.round(winProb * 100)}%</span></span>
          )}
          {mid != null && (
            <span>Mid <span className="font-semibold text-zinc-200">{mid.toFixed(2)}</span></span>
          )}
          <span>Size <span className="font-semibold text-zinc-200">{Math.round(suggestedSize * 100)}%</span></span>
        </div>
      )}

      <div className="flex items-center gap-2 text-[9px] text-zinc-500">
        <span>{scoreUp} {scores.up.toFixed(1)}</span>
        <div className="relative h-1.5 flex-1 rounded-full bg-zinc-800/60 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-600/60"
            style={{ width: `${(scores.up / Math.max(scores.up + scores.down, 1)) * 100}%` }}
          />
        </div>
        <span>{scoreDown} {scores.down.toFixed(1)}</span>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {expanded ? '▾ Hide details' : '▸ Show details'}
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-zinc-800/50 pt-2">
          {reasons.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500 mb-0.5">Why</p>
              <ul className="space-y-0.5">
                {reasons.map((r, i) => (
                  <li key={i} className="text-[10px] leading-snug text-zinc-300 pl-2 border-l-2 border-zinc-700/50">
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {risks.length > 0 && (
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-wider text-amber-500/80 mb-0.5">Risks</p>
              <ul className="space-y-0.5">
                {risks.map((r, i) => (
                  <li key={i} className="text-[10px] leading-snug text-amber-200/80 pl-2 border-l-2 border-amber-700/40">
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
