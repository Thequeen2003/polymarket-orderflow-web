import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Rnd } from 'react-rnd';
import { buildSettlementBiasDualReadout, buildSettlementBiasWarning } from './binaryOutcomeBias';
import { useSettlementBiasDesk } from './SettlementBiasDeskContext';
import { SETTLEMENT_BIAS_SLIDE_PX } from './settlementBiasDesk';
import { SettlementBiasPanelBody } from './SettlementBiasPanelBody';

type WinState = { x: number; y: number; w: number; h: number };

const STORAGE_KEY = 'pmof.settlementBiasHang.v1';
const MIN_W = 280;
const MIN_H = 240;
const TAB_W = 28;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function defaultWin(): WinState {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const w = Math.min(SETTLEMENT_BIAS_SLIDE_PX, vw - TAB_W - 24);
  const h = w;
  const x = Math.max(8, vw - w - TAB_W - 12);
  const y = Math.max(72, (vh - h) * 0.22);
  return { x, y, w, h };
}

function readWin(): WinState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error('missing');
    const p = JSON.parse(raw) as Partial<WinState>;
    const x = Number(p.x);
    const y = Number(p.y);
    const w = Number(p.w);
    const h = Number(p.h);
    if (![x, y, w, h].every(Number.isFinite)) throw new Error('bad');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nw = clamp(w, MIN_W, vw - 16);
    const nh = clamp(h, MIN_H, vh - 16);
    return {
      x: clamp(x, 8, Math.max(8, vw - nw - 8)),
      y: clamp(y, 8, Math.max(8, vh - nh - 8)),
      w: nw,
      h: nh,
    };
  } catch {
    return defaultWin();
  }
}

function writeWin(s: WinState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/**
 * Persistent right-edge hang tab + square floating window — visible on every screen.
 */
export function SettlementBiasHangDock(): ReactElement {
  const { open, togglePanel, closePanel, snapshot } = useSettlementBiasDesk();
  const [win, setWin] = useState<WinState>(() => readWin());

  const warning =
    snapshot != null
      ? buildSettlementBiasWarning({
          estimate: snapshot.estimate,
          marketUp01: snapshot.normMarketUp,
          upLabel: snapshot.upLabel,
          downLabel: snapshot.downLabel,
          probDeltaUp01: snapshot.probDeltaUp01,
          probDeltaDown01: snapshot.probDeltaDown01,
        })
      : null;
  const dual =
    snapshot != null
      ? buildSettlementBiasDualReadout({
          estimate: snapshot.estimate,
          upLabel: snapshot.upLabel,
          downLabel: snapshot.downLabel,
          probDeltaUp01: snapshot.probDeltaUp01,
          probDeltaDown01: snapshot.probDeltaDown01,
        })
      : null;
  const warnHot = warning != null && warning.level !== 'none';
  const tabHint =
    dual != null
      ? dual.splitNote
        ? '⇅'
        : dual.momentum.active
          ? `${dual.finish.lane === 'up' ? '↑' : '↓'}${Math.round(dual.finish.probPct)} · ${Math.round(dual.momentum.up.scorePct)}/${Math.round(dual.momentum.down.scorePct)}`
          : `${dual.finish.lane === 'up' ? '↑' : '↓'}${Math.round(dual.finish.probPct)}`
      : '';

  useEffect(() => writeWin(win), [win]);

  useEffect(() => {
    const onResize = () =>
      setWin((s) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nw = clamp(s.w, MIN_W, vw - 16);
        const nh = clamp(s.h, MIN_H, vh - 16);
        return {
          w: nw,
          h: nh,
          x: clamp(s.x, 8, Math.max(8, vw - nw - 8)),
          y: clamp(s.y, 8, Math.max(8, vh - nh - 8)),
        };
      });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closePanel]);

  const tabDragRef = useRef<{ startY: number; y: number } | null>(null);
  const tabMovedRef = useRef(false);
  const [tabTop, setTabTop] = useState<number | null>(null);

  const onTabDragDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    tabMovedRef.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    tabDragRef.current = { startY: e.clientY, y: rect.top + rect.height / 2 };
  };
  const onTabDragMove = (e: React.PointerEvent) => {
    const d = tabDragRef.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 4) tabMovedRef.current = true;
    const vh = window.innerHeight;
    setTabTop(clamp(d.y + dy, 80, vh - 80));
  };
  const onTabDragUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    tabDragRef.current = null;
  };
  const onTabClick = () => {
    if (tabMovedRef.current) {
      tabMovedRef.current = false;
      return;
    }
    togglePanel();
  };

  const tabStyle =
    tabTop != null
      ? { top: tabTop, transform: 'translateY(-50%)' as const }
      : { top: '42%', transform: 'translateY(-50%)' as const };

  return (
    <>
      <button
        type="button"
        onClick={onTabClick}
        onPointerDown={onTabDragDown}
        onPointerMove={onTabDragMove}
        onPointerUp={onTabDragUp}
        onPointerCancel={onTabDragUp}
        className={`pointer-events-auto fixed right-0 z-[155] flex touch-none flex-col items-center gap-1 rounded-l-xl border border-r-0 py-3 pl-1 pr-1.5 shadow-[-6px_0_24px_rgba(0,0,0,0.45)] backdrop-blur-md transition-colors ${
          open
            ? 'border-violet-400/60 bg-violet-900/90 ring-2 ring-violet-400/30'
            : warnHot
              ? 'border-amber-500/55 bg-violet-950/92 ring-1 ring-amber-500/35 animate-pulse'
              : 'border-violet-600/50 bg-violet-950/88 hover:bg-violet-900/85'
        }`}
        style={tabStyle}
        title="Settlement bias — drag tab vertically · click to open square desk"
      >
        {warnHot ? (
          <span className="text-[11px] leading-none text-amber-200" aria-hidden>
            ⚠
          </span>
        ) : tabHint ? (
          <span className="font-mono text-[9px] font-bold leading-none text-violet-200/90">{tabHint}</span>
        ) : null}
        <span
          className="select-none text-[9px] font-black uppercase tracking-[0.22em] text-violet-100"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Settle
        </span>
        <span className="text-[8px] text-violet-400/70" aria-hidden>
          ⠿
        </span>
      </button>

      {open ? (
        <Rnd
          bounds="window"
          size={{ width: win.w, height: win.h }}
          position={{ x: win.x, y: win.y }}
          minWidth={MIN_W}
          minHeight={MIN_H}
          maxWidth={typeof window !== 'undefined' ? window.innerWidth - 16 : 900}
          maxHeight={typeof window !== 'undefined' ? window.innerHeight - 16 : 900}
          dragHandleClassName="settlement-bias-win-drag"
          enableResizing={{
            top: false,
            right: false,
            bottom: true,
            left: true,
            topRight: false,
            bottomRight: true,
            bottomLeft: true,
            topLeft: false,
          }}
          resizeHandleStyles={{
            left: { width: '8px', left: 0 },
            bottom: { height: '8px', bottom: 0 },
            bottomRight: { width: '16px', height: '16px', right: 0, bottom: 0 },
            bottomLeft: { width: '16px', height: '16px', left: 0, bottom: 0 },
          }}
          onDragStop={(_e, d) => setWin((s) => ({ ...s, x: d.x, y: d.y }))}
          onResizeStop={(_e, _dir, ref, _delta, pos) => {
            setWin({
              x: pos.x,
              y: pos.y,
              w: ref.offsetWidth,
              h: ref.offsetHeight,
            });
          }}
          className="pointer-events-auto fixed z-[157] !flex flex-col overflow-hidden rounded-2xl border border-violet-700/55 bg-zinc-950/97 shadow-2xl shadow-black/55 ring-1 ring-violet-500/20 backdrop-blur-md"
        >
            <div className="settlement-bias-win-drag flex shrink-0 cursor-grab touch-none items-center justify-between gap-2 border-b border-violet-800/50 bg-violet-950/40 px-3 py-2 active:cursor-grabbing">
              <div className="flex min-w-0 select-none items-center gap-2">
                <span className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-300/90">Settlement bias</span>
                {warnHot ? (
                  <span className="rounded border border-amber-500/40 bg-amber-950/50 px-1.5 py-0.5 text-[8px] font-bold uppercase text-amber-100">
                    Early warning
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={closePanel}
                className="shrink-0 rounded-md border border-zinc-700/55 bg-zinc-900/80 px-2 py-1 text-[9px] font-semibold text-zinc-400 hover:text-zinc-200"
              >
                ×
              </button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {snapshot ? (
                <SettlementBiasPanelBody
                  estimate={snapshot.estimate}
                  upLabel={snapshot.upLabel}
                  downLabel={snapshot.downLabel}
                  normMarketUp={snapshot.normMarketUp}
                  probDeltaUp01={snapshot.probDeltaUp01}
                  probDeltaDown01={snapshot.probDeltaDown01}
                  compact
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
                  <p className="text-sm font-medium text-zinc-300">Waiting for model inputs</p>
                  <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                    Open any up/down market — live spot + PTB feed the settlement bias desk automatically.
                  </p>
                </div>
              )}
            </div>
          </Rnd>
      ) : null}
    </>
  );
}
