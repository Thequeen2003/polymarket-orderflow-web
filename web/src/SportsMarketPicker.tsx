import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { marketsSportsLive, type SportsLiveRow } from './lib/api';
import { SPORTS_LEAGUE_CHIPS, sportsLeagueLabel, type SportsLeagueId } from './sportsLeagues';

function fmtGameTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isOk<T>(res: { ok: true; data: T } | { ok: false }): res is { ok: true; data: T } {
  return res.ok === true;
}

export function SportsMarketPicker(props: {
  activeLeague: SportsLeagueId | null;
  busyLeague: SportsLeagueId | null;
  selectedSlug: string;
  onPickLeague: (league: SportsLeagueId) => void;
  onOpenSlug: (slug: string, market?: unknown) => void;
}): ReactElement {
  const { activeLeague, busyLeague, selectedSlug, onPickLeague, onOpenSlug } = props;
  const [liveRows, setLiveRows] = useState<SportsLiveRow[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  const loadLive = useCallback(async (league: SportsLeagueId | null) => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const res = await marketsSportsLive(league ?? undefined, 16);
      if (!isOk(res)) {
        setLiveError('Could not load live sports markets');
        setLiveRows([]);
        return;
      }
      setLiveRows(res.data);
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
      setLiveRows([]);
    } finally {
      setLiveLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLive(activeLeague);
    const id = window.setInterval(() => void loadLive(activeLeague), 60_000);
    return () => window.clearInterval(id);
  }, [activeLeague, loadLive]);

  return (
    <div className="mb-4 rounded-2xl border border-emerald-900/40 bg-emerald-950/15 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-300/90">Sports</div>
          <p className="mt-1 text-[11px] leading-snug text-zinc-400">
            League shortcuts like Polymarket — dual belief, Now Prob Signals, and PLM on live game markets.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadLive(activeLeague)}
          disabled={liveLoading}
          className="rounded-lg border border-zinc-700/50 px-2.5 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-900/50 disabled:opacity-50"
        >
          {liveLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {SPORTS_LEAGUE_CHIPS.map((chip) => {
          const busy = busyLeague === chip.id;
          const active = activeLeague === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              disabled={busy}
              onClick={() => onPickLeague(chip.id)}
              className={`min-w-[3.25rem] rounded-xl border px-3 py-2 text-center text-xs font-bold uppercase tracking-wide transition-colors disabled:cursor-wait disabled:opacity-50 ${
                active
                  ? 'border-emerald-500/60 bg-emerald-900/40 text-emerald-50'
                  : 'border-emerald-800/45 bg-emerald-950/25 text-emerald-100 hover:bg-emerald-950/45'
              }`}
            >
              {busy ? '…' : chip.label}
            </button>
          );
        })}
      </div>

      {liveError ? <p className="mt-2 text-[11px] text-amber-300/90">{liveError}</p> : null}

      <div className="mt-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-500">
          Live {activeLeague ? sportsLeagueLabel(activeLeague) : 'games'}
        </div>
        {liveLoading && liveRows.length === 0 ? (
          <p className="mt-2 text-[11px] text-zinc-500">Loading live markets…</p>
        ) : liveRows.length === 0 ? (
          <p className="mt-2 text-[11px] text-zinc-500">No open markets with books — try another league.</p>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {liveRows.map((row) => {
              const selected = selectedSlug.trim().toLowerCase() === row.slug.trim().toLowerCase();
              const when = fmtGameTime(row.gameStartTime ?? row.endDate);
              return (
                <button
                  key={row.slug}
                  type="button"
                  onClick={() => onOpenSlug(row.slug, row.market)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? 'border-emerald-500/55 bg-emerald-950/35 ring-1 ring-emerald-500/20'
                      : 'border-zinc-800/60 bg-black/20 hover:border-emerald-800/45 hover:bg-emerald-950/15'
                  }`}
                >
                  <div className="text-[11px] font-semibold leading-snug text-zinc-100">
                    {row.question ?? row.slug}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[9px] text-zinc-500">
                    {row.league ? <span>{row.league.toUpperCase()}</span> : null}
                    {when ? <span>{when}</span> : null}
                    {row.volume24hr != null && row.volume24hr > 0 ? (
                      <span>Vol {Math.round(row.volume24hr).toLocaleString()}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
