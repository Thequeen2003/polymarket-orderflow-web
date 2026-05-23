/**
 * Tiny operator-note input that lives above the chart. Persists to
 * `localStorage` keyed by slug so notes survive reloads but are scoped to a
 * specific market. Use it for "watching FOMC", "illiquid book", "test session"
 * — anything that makes a stale screenshot meaningful tomorrow.
 *
 * Hidden when the user has the `pinnedNote` feature flag off.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';

const KEY_PREFIX = 'polyof:round-note:';

function readNote(slug: string | null | undefined): string {
  if (!slug || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(KEY_PREFIX + slug) ?? '';
  } catch {
    return '';
  }
}

function writeNote(slug: string | null | undefined, value: string): void {
  if (!slug || typeof window === 'undefined') return;
  try {
    if (value.trim() === '') window.localStorage.removeItem(KEY_PREFIX + slug);
    else window.localStorage.setItem(KEY_PREFIX + slug, value.slice(0, 200));
  } catch {
    /* ignore */
  }
}

export function RoundNote(props: { slug?: string | null; visible?: boolean }): ReactElement | null {
  const { slug, visible = true } = props;
  const [value, setValue] = useState<string>(() => readNote(slug ?? ''));
  const [editing, setEditing] = useState(false);

  // Re-load when the slug changes.
  useEffect(() => {
    setValue(readNote(slug ?? ''));
    setEditing(false);
  }, [slug]);

  const onChange = useCallback(
    (next: string) => {
      setValue(next);
      writeNote(slug ?? '', next);
    },
    [slug],
  );

  if (!visible) return null;
  if (!slug) return null;

  if (editing || value.length === 0) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5 text-[10px]">
        <span className="font-bold uppercase tracking-wider text-zinc-500">📝 Note</span>
        <input
          type="text"
          autoFocus={editing}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              (e.target as HTMLInputElement).blur();
            }
          }}
          maxLength={200}
          placeholder="One-liner for this round (e.g. watching FOMC, illiquid)"
          className="flex-1 rounded-md border border-zinc-800/70 bg-zinc-950/70 px-2 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/55 focus:outline-none"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="mb-2 flex w-full items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/30 px-2 py-1.5 text-left text-[11px] text-amber-100 hover:border-amber-500/60 hover:bg-amber-950/45"
      title="Click to edit round note"
    >
      <span className="font-bold uppercase tracking-wider text-amber-300/85">📝 Note</span>
      <span className="flex-1 truncate">{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-amber-300/55">click to edit</span>
    </button>
  );
}
