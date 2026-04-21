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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {tabs.map((t) => {
          const isActive = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`group flex max-w-[min(100%,14rem)] items-center gap-0.5 rounded-lg border px-1.5 py-1 text-[10px] font-semibold transition-colors ${
                isActive
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-100'
                  : 'border-zinc-800/80 bg-black/20 text-zinc-400 hover:border-zinc-700/80 hover:text-zinc-200'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="min-w-0 flex-1 truncate text-left"
                title={`${t.label} · ${t.slug} · ${t.lane.toUpperCase()}`}
              >
                {t.label}
              </button>
              <button
                type="button"
                onClick={() => onClose(t.id)}
                className="shrink-0 rounded px-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                title="Close tab"
                aria-label={`Close ${t.label}`}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg border border-dashed border-zinc-600/60 bg-zinc-950/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:border-amber-600/50 hover:text-amber-200/90"
          title="Copy current market into a new tab (use several browser windows to trade in parallel)"
        >
          + Session
        </button>
      </div>
      <p className="text-[9px] leading-relaxed text-zinc-500">
        Tabs switch which market is loaded in this page (one order book at a time). For multiple live UIs, open this app in more than one window and keep a different session tab in each.
      </p>
    </div>
  );
}
