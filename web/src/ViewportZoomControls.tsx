import type { ReactElement } from 'react';
import type { ViewportZoomMode } from './viewportZoom';

export function ViewportZoomControls(props: {
  scaleLabel: string;
  mode: ViewportZoomMode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onAutoFit: () => void;
  onReset: () => void;
  /** Header chip vs always-visible floating dock */
  variant?: 'inline' | 'floating';
  /** Floating dock was dismissed — inline header can restore it */
  floatingDockHidden?: boolean;
  onShowFloatingDock?: () => void;
  /** Close the floating dock (inline controls remain) */
  onCloseFloating?: () => void;
}): ReactElement {
  const {
    scaleLabel,
    mode,
    onZoomIn,
    onZoomOut,
    onAutoFit,
    onReset,
    variant = 'inline',
    floatingDockHidden = false,
    onShowFloatingDock,
    onCloseFloating,
  } = props;

  if (variant === 'floating') {
    return (
      <div
        className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-[200]"
        aria-label="Viewport zoom"
      >
        <div className="pointer-events-auto flex flex-col gap-2 rounded-2xl border border-indigo-500/35 bg-zinc-950/95 p-3 shadow-2xl shadow-black/60 ring-1 ring-indigo-400/20 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3 px-0.5">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-indigo-200/90">View zoom</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold tabular-nums text-zinc-100">{scaleLabel}</span>
              {onCloseFloating ? (
                <button
                  type="button"
                  onClick={onCloseFloating}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700/50 text-zinc-500 transition-colors hover:border-zinc-600 hover:bg-zinc-900/80 hover:text-zinc-200"
                  title="Hide view zoom dock"
                  aria-label="Close view zoom dock"
                >
                  <span className="text-base leading-none" aria-hidden>
                    ×
                  </span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              className="min-h-[48px] min-w-[48px] rounded-xl border border-zinc-600/60 bg-zinc-900/80 text-2xl font-bold leading-none text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
              onClick={onZoomOut}
              aria-label="Zoom out"
              title="Zoom out — stops at normal (100%)"
            >
              −
            </button>
            <button
              type="button"
              className={`min-h-[48px] flex-1 rounded-xl border px-3 text-sm font-bold transition-colors ${
                mode === 'auto'
                  ? 'border-indigo-500/50 bg-indigo-600/30 text-indigo-50'
                  : 'border-zinc-600/60 bg-zinc-900/80 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800'
              }`}
              onClick={onAutoFit}
              aria-label="Auto fit to screen"
              title="Fit screen — auto scale to window"
            >
              Fit screen
            </button>
            <button
              type="button"
              className="min-h-[48px] min-w-[48px] rounded-xl border border-indigo-500/45 bg-indigo-600/25 text-2xl font-bold leading-none text-indigo-50 transition-colors hover:bg-indigo-600/40"
              onClick={onZoomIn}
              aria-label="Zoom in"
              title="Zoom in — larger text & charts"
            >
              +
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="min-h-[36px] flex-1 rounded-lg border border-zinc-700/50 bg-zinc-900/50 text-xs font-bold uppercase tracking-wide text-zinc-400 transition-colors hover:text-zinc-200"
              onClick={onReset}
              title="Reset to auto fit (normal size)"
            >
              Reset
            </button>
            <span className="flex min-h-[36px] flex-[2] items-center justify-center rounded-lg bg-zinc-900/30 px-2 text-[10px] leading-snug text-zinc-500">
              Out stops at 100% · auto boosts small windows
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      <div
        className="inline-flex items-center gap-1 rounded-xl border border-indigo-500/30 bg-zinc-950/70 p-1 ring-1 ring-indigo-500/15"
        role="group"
        aria-label="Viewport zoom"
        title="App viewport zoom — does not change browser zoom"
      >
        <span className="hidden px-1 text-[10px] font-bold uppercase tracking-wide text-indigo-300/80 sm:inline">Zoom</span>
        <button
          type="button"
          className="min-h-[36px] min-w-[36px] rounded-lg text-lg font-bold text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50"
          onClick={onZoomOut}
          aria-label="Zoom out"
          title="Zoom out — stops at normal (100%)"
        >
          −
        </button>
        <button
          type="button"
          className={`min-h-[36px] rounded-lg px-2.5 font-mono text-xs font-bold tabular-nums transition-colors ${
            mode === 'auto' ? 'bg-indigo-600/30 text-indigo-100' : 'text-zinc-300 hover:bg-zinc-800'
          }`}
          onClick={onAutoFit}
          aria-label="Auto fit to screen"
          title="Fit screen"
        >
          {mode === 'auto' ? `Fit ${scaleLabel}` : scaleLabel}
        </button>
        <button
          type="button"
          className="min-h-[36px] min-w-[36px] rounded-lg text-lg font-bold text-indigo-100 transition-colors hover:bg-indigo-600/30"
          onClick={onZoomIn}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
      </div>
      {floatingDockHidden && onShowFloatingDock ? (
        <button
          type="button"
          onClick={onShowFloatingDock}
          className="min-h-[36px] rounded-xl border border-dashed border-indigo-500/35 bg-zinc-950/40 px-2.5 text-[10px] font-bold uppercase tracking-wide text-indigo-300/90 transition-colors hover:border-indigo-500/50 hover:text-indigo-100"
          title="Show bottom-left view zoom dock"
        >
          View zoom · Show
        </button>
      ) : null}
    </div>
  );
}
