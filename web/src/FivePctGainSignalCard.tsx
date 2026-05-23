import type { ReactElement } from 'react';
import { formatFivePctGainSignalLines, type FivePctGainSignal } from './fivePctGainStrategy';

export function FivePctGainSignalCard(props: {
  signal: FivePctGainSignal | null;
  blockedReason?: string | null;
  active: boolean;
}): ReactElement | null {
  const { signal, blockedReason = null, active } = props;
  if (!active) return null;

  if (!signal) {
    return (
      <div className="mt-2 space-y-1 rounded-lg border border-amber-900/45 bg-amber-950/20 px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-wide text-amber-200/90">5% gain strategy</div>
        <p className="text-[10px] leading-snug text-amber-100/90">
          {blockedReason?.trim() || 'Waiting for aligned entry (48–93¢, momentum, flow, book).'}
        </p>
      </div>
    );
  }

  const lines = formatFivePctGainSignalLines(signal);
  const confTone =
    signal.confidence === 'High'
      ? 'text-emerald-300'
      : signal.confidence === 'Med'
        ? 'text-amber-200'
        : 'text-zinc-400';

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-emerald-800/50 bg-emerald-950/25 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-wide text-emerald-200">5% gain signal</span>
        <span className={`text-[10px] font-bold uppercase ${confTone}`}>{signal.confidence} confidence</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] leading-snug">
        {lines.map((line) => {
          const idx = line.indexOf(':');
          const key = idx > 0 ? line.slice(0, idx) : line;
          const val = idx > 0 ? line.slice(idx + 1).trim() : '';
          return (
            <div key={line} className="contents">
              <dt className="font-semibold text-zinc-500">{key}</dt>
              <dd className="font-medium text-zinc-100">{val || '—'}</dd>
            </div>
          );
        })}
      </dl>
      <p className="text-[9px] text-zinc-500">
        Zone:{' '}
        <span className="font-mono text-zinc-300">
          {signal.entryZone === 'value'
            ? '48–65¢ value'
            : signal.entryZone === 'momentum'
              ? '66–80¢ momentum'
              : '81–93¢ late risk'}
        </span>
        {' · '}
        Reference levels only — take signal does not auto-arm brackets.
      </p>
    </div>
  );
}
