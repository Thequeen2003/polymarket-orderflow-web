import type { ReactElement } from 'react';

/** Shared segmented control for Market/Limit and similar toggles (Signals + Book tab). */
export function TradeSegmentedControl<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  /** Wider min height for primary toolbars */
  size?: 'sm' | 'md';
  className?: string;
}): ReactElement {
  const { value, onChange, options, size = 'sm', className = '' } = props;
  const h = size === 'md' ? 'min-h-[44px]' : 'min-h-[40px]';
  return (
    <div
      className={`inline-flex rounded-xl border border-zinc-800/70 bg-black/30 p-1 shadow-inner shadow-black/40 ${className}`}
      role="group"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`${h} flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
            value === o.value ? 'bg-zinc-800 text-zinc-50 shadow-sm ring-1 ring-zinc-700/50' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
