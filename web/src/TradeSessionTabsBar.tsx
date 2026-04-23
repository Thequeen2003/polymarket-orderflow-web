import type { ReactElement } from 'react';

export type TradeSessionTab = {
  id: string;
  /** Short label shown on the tab */
  label: string;
  slug: string;
  lane: 'up' | 'down';
};

export function shortTradeTabLabel(question: string | undefined, slug: string): string {
  const raw = (question ?? '').trim() || slug;
  if (raw.length <= 34) return raw;
  return `${raw.slice(0, 31)}…`;
}

type Props = {
  tabs: TradeSessionTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
};

/**
 * Multiple trade “sessions” as tabs. Only one is active; switching is meant to
 * re-point the app’s loaded market (single CLOB) — open several browser windows
 * for true parallel UIs.
 */
export function TradeSessionTabsBar(props: Props): ReactElement {
  const { tabs, activeId, onSelect, onAdd, onClose } = props;

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-black/15 p-2.5 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((t) => {
          const isActive = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`group flex max-w-[min(100%,16rem)] min-h-[36px] items-stretch overflow-hidden rounded-xl border text-[11px] font-medium transition-colors ${
                isActive
                  ? 'border-amber-500/45 bg-amber-500/10 text-amber-50 shadow-sm shadow-amber-950/20'
                  : 'border-zinc-700/60 bg-black/25 text-zinc-400 hover:border-zinc-600/70 hover:bg-black/35 hover:text-zinc-200'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="min-w-0 flex-1 truncate px-3 py-2 text-left transition-colors"
                title={`Open: ${t.label}\n${t.slug}\nLast side: ${t.lane === 'up' ? 'Up / first outcome' : 'Down / second outcome'}`}
              >
                {t.label}
              </button>
              <button
                type="button"
                onClick={() => onClose(t.id)}
                className="flex w-9 shrink-0 items-center justify-center border-l border-zinc-700/40 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100"
                title="Close this tab"
                aria-label={`Close tab ${t.label}`}
              >
                <span className="text-lg leading-none" aria-hidden>
                  ×
                </span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          className="flex min-h-[36px] items-center gap-1.5 rounded-xl border border-dashed border-zinc-600/55 bg-zinc-950/30 px-3 py-2 text-[11px] font-semibold text-zinc-400 transition-colors hover:border-amber-500/45 hover:bg-amber-950/15 hover:text-amber-100"
          title="Duplicate the current market in a new tab so you can flip between setups quickly"
        >
          <span className="text-base font-light leading-none text-amber-400/90" aria-hidden>
            +
          </span>
          New tab
        </button>
      </div>
    </div>
  );
}
