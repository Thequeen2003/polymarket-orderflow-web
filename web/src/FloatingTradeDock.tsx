import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

type DockState = {
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
};

const STORAGE_KEY = 'pmof.floatingTradeDock.v1';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readState(): DockState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('missing');
    const parsed = JSON.parse(raw) as Partial<DockState>;
    const open = parsed.open === true;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    const w = Number(parsed.w);
    const h = Number(parsed.h);
    if (![x, y, w, h].every((v) => Number.isFinite(v))) throw new Error('bad');
    return {
      open,
      x: clamp(x, 12, 10_000),
      y: clamp(y, 12, 10_000),
      w: clamp(w, 320, 10_000),
      h: clamp(h, 360, 10_000),
    };
  } catch {
    // Default: bottom-right-ish on desktop.
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const w = 420;
    const h = 560;
    return { open: false, x: Math.max(12, vw - w - 18), y: Math.max(12, vh - h - 18), w, h };
  }
}

function writeState(s: DockState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export type FloatingTradeDockProps = {
  title?: string;
  /** Disable floating trade when we don't have outcome tokens yet. */
  enabled: boolean;
  /** Hide the bottom launcher button (use your own trigger). */
  hideLauncher?: boolean;
  /** When this number changes, dock opens (if enabled). */
  openNonce?: number;
  /** Inline panel still exists in the page layout when the dock is closed. */
  inline: ReactElement;
  /** Panel rendered inside the floating dock when open. */
  floating: ReactElement;
};

export function FloatingTradeDock(props: FloatingTradeDockProps): ReactElement {
  const { title = 'Trade', enabled, hideLauncher = false, openNonce, inline, floating } = props;

  const [st, setSt] = useState<DockState>(() => readState());

  useEffect(() => writeState(st), [st]);

  // External trigger: open the dock when nonce changes.
  useEffect(() => {
    if (openNonce == null) return;
    setSt((s) => ({ ...s, open: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNonce]);

  // Keep dock on screen on resize.
  useEffect(() => {
    const onResize = () => {
      setSt((s) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const x = clamp(s.x, 8, Math.max(8, vw - 160));
        const y = clamp(s.y, 8, Math.max(8, vh - 120));
        const w = clamp(s.w, 320, Math.max(320, vw - 16));
        const h = clamp(s.h, 360, Math.max(360, vh - 16));
        return { ...s, x, y, w, h };
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ESC closes the dock.
  useEffect(() => {
    if (!st.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSt((s) => ({ ...s, open: false }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [st.open]);

  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const onDragDown = (e: React.PointerEvent) => {
    if (!st.open) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, x: st.x, y: st.y };
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setSt((s) => ({ ...s, x: d.x + dx, y: d.y + dy }));
  };
  const onDragUp = () => {
    dragRef.current = null;
  };

  const resizeRef = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    if (!st.open) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeRef.current = { startX: e.clientX, startY: e.clientY, w: st.w, h: st.h };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dw = e.clientX - r.startX;
    const dh = e.clientY - r.startY;
    setSt((s) => ({ ...s, w: Math.max(320, r.w + dw), h: Math.max(360, r.h + dh) }));
  };
  const onResizeUp = () => {
    resizeRef.current = null;
  };

  const showInline = !st.open;
  const launcherLabel = useMemo(() => (enabled ? `Open ${title}` : `Trade unavailable`), [enabled, title]);

  return (
    <>
      {showInline ? inline : null}

      {/* Launcher tab */}
      {!hideLauncher ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[120] flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-end sm:pr-4">
          <div className="pointer-events-auto">
            <button
              type="button"
              disabled={!enabled}
              onClick={() => setSt((s) => ({ ...s, open: true }))}
              className={`min-h-[44px] rounded-full border px-4 text-[12px] font-black tracking-wide shadow-2xl shadow-black/50 ring-1 ring-white/[0.05] transition-colors ${
                enabled
                  ? 'border-amber-500/35 bg-zinc-950/85 text-amber-100 hover:bg-zinc-900/85'
                  : 'border-zinc-800/60 bg-zinc-950/60 text-zinc-500'
              }`}
              title={launcherLabel}
            >
              {enabled ? 'Trade' : 'Trade (needs tokens)'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Floating dock */}
      {st.open ? (
        <div
          className="fixed z-[140] rounded-3xl border border-zinc-700/70 bg-zinc-950/88 shadow-2xl shadow-black/60 ring-1 ring-white/[0.06] backdrop-blur-xl"
          style={{ left: st.x, top: st.y, width: st.w, height: st.h }}
        >
          <div
            className="flex h-[52px] cursor-grab items-center justify-between gap-2 rounded-t-3xl border-b border-zinc-800/70 bg-black/25 px-3 active:cursor-grabbing"
            onPointerDown={onDragDown}
            onPointerMove={onDragMove}
            onPointerUp={onDragUp}
          >
            <div className="min-w-0">
              <div className="truncate text-[11px] font-black uppercase tracking-[0.16em] text-amber-200/90">{title}</div>
              <div className="truncate text-[10px] text-zinc-500">Drag · Resize · Esc to close</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setSt((s) => ({
                    ...s,
                    w: 420,
                    h: 560,
                    x: Math.max(12, window.innerWidth - 420 - 18),
                    y: Math.max(12, window.innerHeight - 560 - 18),
                  }))
                }
                className="rounded-xl border border-zinc-800/70 bg-black/15 px-2.5 py-1.5 text-[10px] font-bold text-zinc-300 hover:bg-black/25"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => setSt((s) => ({ ...s, open: false }))}
                className="rounded-xl border border-zinc-800/70 bg-black/15 px-2.5 py-1.5 text-[10px] font-bold text-zinc-300 hover:bg-black/25"
              >
                Close
              </button>
            </div>
          </div>

          <div className="h-[calc(100%-52px)] overflow-auto p-3">{floating}</div>

          {/* Resize handle */}
          <div
            className="absolute bottom-1.5 right-1.5 h-6 w-6 cursor-nwse-resize rounded-xl border border-zinc-800/70 bg-black/25"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            title="Resize"
          />
        </div>
      ) : null}
    </>
  );
}

