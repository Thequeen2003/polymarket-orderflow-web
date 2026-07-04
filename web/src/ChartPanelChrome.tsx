import type { ReactElement, ReactNode } from 'react';
import { formatChartPanelScalePct } from './chartPanelZoom';
import { ChartPanelScaleContext } from './chartPanelScaleContext';

export function ChartPanelChrome(props: {
  title: string;
  /** Pin this chart into the multi-panel workspace grid. */
  workspaceChecked?: boolean;
  onWorkspaceCheckedChange?: (on: boolean) => void;
  showWorkspaceCheckbox?: boolean;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  /** Tile chrome vs slim bar above a single-tab chart. */
  variant?: 'tile' | 'inline';
  /** When true, use CSS zoom (Book tab). Signals PTB charts grow layout via ChartPanelScaleContext instead. */
  useCssZoom?: boolean;
  children: ReactNode;
}): ReactElement {
  const {
    title,
    workspaceChecked = false,
    onWorkspaceCheckedChange,
    showWorkspaceCheckbox = false,
    scale,
    onZoomIn,
    onZoomOut,
    onResetZoom,
    variant = 'tile',
    useCssZoom = false,
    children,
  } = props;

  const scaleLabel = formatChartPanelScalePct(scale);
  const headerClass =
    variant === 'tile'
      ? 'shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/50 px-2.5 py-1.5'
      : 'mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/50 bg-zinc-950/40 px-2.5 py-1.5';

  return (
    <ChartPanelScaleContext.Provider value={scale}>
      <div className={variant === 'tile' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'flex min-w-0 flex-col'}>
        <div className={headerClass}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {showWorkspaceCheckbox && onWorkspaceCheckedChange ? (
              <label
                className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10px] font-semibold text-zinc-300"
                title="Show this chart side-by-side in your workspace"
              >
                <input
                  type="checkbox"
                  className="rounded border-zinc-600"
                  checked={workspaceChecked}
                  onChange={(e) => onWorkspaceCheckedChange(e.target.checked)}
                />
                <span className="hidden sm:inline">Pin</span>
              </label>
            ) : null}
            <span className="truncate text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">{title}</span>
          </div>
          <div
            className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-indigo-500/25 bg-zinc-950/60 p-0.5 ring-1 ring-indigo-500/10"
            role="group"
            aria-label={`${title} zoom`}
            title="Chart zoom — grows plot area (+/−), not browser zoom"
          >
            <button
              type="button"
              className="min-h-[28px] min-w-[28px] rounded-md text-sm font-bold text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-50"
              onClick={onZoomOut}
              aria-label={`Zoom out ${title}`}
              title="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="min-h-[28px] rounded-md px-1.5 font-mono text-[10px] font-bold tabular-nums text-indigo-100 transition-colors hover:bg-zinc-800"
              onClick={onResetZoom}
              aria-label={`Reset zoom for ${title}`}
              title="Reset to 100%"
            >
              {scaleLabel}
            </button>
            <button
              type="button"
              className="min-h-[28px] min-w-[28px] rounded-md text-sm font-bold text-indigo-100 transition-colors hover:bg-indigo-600/25"
              onClick={onZoomIn}
              aria-label={`Zoom in ${title}`}
              title="Zoom in — larger chart area"
            >
              +
            </button>
          </div>
        </div>
        <div className={variant === 'tile' ? 'min-h-0 flex-1 overflow-visible p-1.5' : 'min-w-0 overflow-visible'}>
          <div className="min-w-0 origin-top-left" style={useCssZoom ? { zoom: scale } : undefined}>
            {children}
          </div>
        </div>
      </div>
    </ChartPanelScaleContext.Provider>
  );
}
