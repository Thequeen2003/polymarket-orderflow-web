import type { ReactElement, ReactNode } from 'react';

export function DeskScreenSection(props: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactElement {
  const { title, summary, open, onToggle, children } = props;

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-800/55 bg-zinc-950/25">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-zinc-900/40 sm:px-3.5"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-zinc-500">{title}</div>
          {!open ? (
            <div className="mt-0.5 truncate text-sm font-semibold text-zinc-200" title={summary}>
              {summary}
            </div>
          ) : null}
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
            open
              ? 'border-zinc-600/60 bg-zinc-800/50 text-zinc-200'
              : 'border-cyan-500/40 bg-cyan-950/35 text-cyan-100'
          }`}
        >
          {open ? 'Close' : 'Open'}
        </span>
      </button>
      {open ? <div className="border-t border-zinc-800/45 [&>*]:rounded-t-none [&>*]:border-t-0">{children}</div> : null}
    </section>
  );
}

export function DeskScreenSectionTabs(props: {
  tabs: ReadonlyArray<{ id: string; label: string; open: boolean; onToggle: () => void }>;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Desk screen panels">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={tab.onToggle}
          aria-pressed={tab.open}
          className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
            tab.open
              ? 'border-zinc-600/55 bg-zinc-800/55 text-zinc-100'
              : 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500 hover:border-zinc-600/50 hover:text-zinc-300'
          }`}
        >
          {tab.label}
          <span className="ml-1 opacity-70">{tab.open ? '▾' : '▸'}</span>
        </button>
      ))}
    </div>
  );
}
