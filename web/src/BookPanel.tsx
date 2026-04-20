import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { displayPrice, groupLevelsByDime, type BookLevel } from './bookLevels';

function displaySize(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const t = s.toFixed(4).replace(/\.?0+$/, '');
  return t === '' ? '0' : t;
}

function bandLabel(lo: number, hi: number): string {
  return `${displayPrice(lo)}–${displayPrice(hi)}`;
}

function centsBandLabel(lo: number, hi: number): string {
  // bands are 0.10 wide; convert to integer cents for a cleaner tab label
  const a = Math.round(lo * 100);
  const b = Math.round(hi * 100);
  return `${a}–${b}¢`;
}

export function BookSideGrouped({
  title,
  levels,
  tone,
}: {
  title: string;
  levels: BookLevel[];
  tone: 'ask' | 'bid';
}): ReactElement {
  const empty = levels.length === 0;
  const groups = useMemo(() => groupLevelsByDime(levels, tone), [levels, tone]);
  const isAsk = tone === 'ask';
  const [selected, setSelected] = useState<number | null>(groups[0]?.bandLo ?? null);

  useEffect(() => {
    const first = groups[0]?.bandLo ?? null;
    if (first == null) {
      queueMicrotask(() => setSelected(null));
      return;
    }
    const stillThere = selected != null && groups.some((g) => g.bandLo === selected);
    if (!stillThere) queueMicrotask(() => setSelected(first));
  }, [groups, selected]);

  const activeGroup = selected == null ? null : groups.find((g) => g.bandLo === selected) ?? null;

  const bandTotal = (g: { levels: BookLevel[] }) => g.levels.reduce((acc, l) => acc + (Number.isFinite(l.size) ? l.size : 0), 0);

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/20 ring-1 ring-white/[0.02]">
      <div
        className={`text-[13px] font-medium tracking-wide ${isAsk ? 'text-emerald-300/90' : 'text-sky-300/90'}`}
      >
        {title}
      </div>
      <div className="mt-3 text-[13px] leading-snug">
        {empty ? (
          <div className="rounded-lg bg-zinc-900/25 px-2 py-3 text-center text-zinc-500">No levels yet.</div>
        ) : (
          <>
            <div className="flex gap-1 overflow-x-auto rounded-xl bg-zinc-900/35 p-1 ring-1 ring-zinc-800/50">
              {groups.map((g) => {
                const on = g.bandLo === selected;
                const total = bandTotal(g);
                return (
                  <button
                    key={`${tone}-${g.bandLo}`}
                    type="button"
                    onClick={() => setSelected(g.bandLo)}
                    className={`shrink-0 rounded-lg px-2.5 py-2 text-[12px] font-medium transition-all ${
                      on
                        ? 'bg-zinc-800 text-zinc-50 shadow-sm ring-1 ring-zinc-700/60'
                        : 'text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
                    }`}
                    title={`${bandLabel(g.bandLo, g.bandHi)} (10¢)`}
                  >
                    <div className="font-mono">{centsBandLabel(g.bandLo, g.bandHi)}</div>
                    <div className="mt-0.5 text-[10px] text-zinc-500">Σ {displaySize(total)}</div>
                  </button>
                );
              })}
            </div>

            {activeGroup ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800/40 bg-black/15">
                <div className="flex items-center justify-between gap-2 border-b border-zinc-800/50 bg-zinc-900/30 px-3 py-2">
                  <div
                    className={`inline-flex items-baseline gap-2 rounded-full border px-2.5 py-1 font-mono text-[11px] tracking-tight ${
                      isAsk
                        ? 'border-emerald-800/35 bg-emerald-950/25 text-emerald-200/85'
                        : 'border-sky-800/35 bg-sky-950/25 text-sky-200/85'
                    }`}
                  >
                    <span>{centsBandLabel(activeGroup.bandLo, activeGroup.bandHi)}</span>
                    <span className="font-sans text-[10px] font-normal normal-case tracking-normal text-zinc-500">10¢ band</span>
                  </div>
                  <div className="font-mono text-[10px] text-zinc-600">levels: {activeGroup.levels.length}</div>
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-zinc-800/50 bg-zinc-900/20 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  <span>Price</span>
                  <span className="text-right">Size</span>
                </div>
                {activeGroup.levels.map((l, i) => (
                  <div
                    key={`${activeGroup.bandLo}-${i}-${l.price}`}
                    className={`grid grid-cols-[1fr_auto] gap-x-4 border-b border-zinc-800/25 px-3 py-1.5 font-mono tabular-nums last:border-b-0 ${
                      i % 2 === 0 ? 'bg-transparent' : 'bg-zinc-900/15'
                    }`}
                  >
                    <span className={`text-zinc-100 ${isAsk ? 'text-emerald-100/95' : 'text-sky-100/95'}`}>{displayPrice(l.price)}</span>
                    <span className="text-right text-zinc-400">{displaySize(l.size)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
