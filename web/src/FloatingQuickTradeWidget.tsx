import { useEffect, useRef, useState, type ReactElement } from 'react';

type WidgetState = {
  x: number;
  y: number;
  open: boolean;
};

const STORAGE_KEY = 'pmof.quickTradeWidget.v1';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readState(): WidgetState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('missing');
    const parsed = JSON.parse(raw) as Partial<WidgetState>;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    const open = parsed.open !== false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('bad');
    return { x: clamp(x, 8, 10_000), y: clamp(y, 8, 10_000), open };
  } catch {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    return { x: Math.max(10, vw - 220), y: Math.max(10, vh - 240), open: true };
  }
}

function writeState(s: WidgetState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function FloatingQuickTradeWidget(props: {
  enabled: boolean;
  onOpenTrade: () => void;
}): ReactElement | null {
  const { enabled, onOpenTrade } = props;
  const [st, setSt] = useState<WidgetState>(() => readState());

  useEffect(() => writeState(st), [st]);

  useEffect(() => {
    const onResize = () => {
      setSt((s) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        return { ...s, x: clamp(s.x, 8, Math.max(8, vw - 120)), y: clamp(s.y, 8, Math.max(8, vh - 80)) };
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const onDragDown = (e: React.PointerEvent) => {
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

  if (!st.open) {
    return (
      <div className="pointer-events-none fixed inset-0 z-[160]">
        <button
          type="button"
          onClick={() => setSt((s) => ({ ...s, open: true }))}
          className="pointer-events-auto fixed bottom-[max(0.85rem,env(safe-area-inset-bottom))] right-3 rounded-full border border-amber-500/35 bg-zinc-950/85 px-4 py-2 text-[12px] font-black tracking-wide text-amber-100 shadow-2xl shadow-black/50"
        >
          Trade
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[160]">
      <div
        className="pointer-events-auto fixed w-[220px] rounded-2xl border border-zinc-700/70 bg-zinc-950/88 shadow-2xl shadow-black/60 ring-1 ring-white/[0.06] backdrop-blur-xl"
        style={{ left: st.x, top: st.y }}
      >
        <div
          className="flex cursor-grab items-center justify-between gap-2 rounded-t-2xl border-b border-zinc-800/70 bg-black/25 px-3 py-2 active:cursor-grabbing"
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragUp}
        >
          <div className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-200/90">Quick trade</div>
          <button
            type="button"
            onClick={() => setSt((s) => ({ ...s, open: false }))}
            className="rounded-lg border border-zinc-800/70 bg-black/20 px-2 py-1 text-[10px] font-bold text-zinc-300 hover:bg-black/30"
            title="Hide"
          >
            ×
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            disabled={!enabled}
            onClick={onOpenTrade}
            className={`w-full rounded-xl px-3 py-2 text-[12px] font-bold shadow-md ${
              enabled ? 'bg-amber-400 text-black hover:bg-amber-300' : 'bg-zinc-800 text-zinc-500'
            }`}
            title={enabled ? 'Open the full floating trade panel' : 'Load a 2-outcome market first'}
          >
            Open trade panel
          </button>
          <div className="mt-2 text-[11px] text-zinc-500">Drag header to move.</div>
        </div>
      </div>
    </div>
  );
}

