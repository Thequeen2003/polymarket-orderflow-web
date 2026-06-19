import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { TradeFloatChromeProvider } from './TradeFloatChromeContext';

/** @deprecated Slide width constant kept for callers that adjust layout padding. */
export const TRADE_SLIDE_PANEL_WIDTH_PX = 380;

export type TradeSlidePanelProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
};

/**
 * Fixed right trade column — no drag/resize. App.tsx adds matching right padding when open
 * so the main dashboard sits left of the panel instead of underneath it.
 */
export function TradeSlidePanel(props: TradeSlidePanelProps): ReactElement {
  const { open, onClose, title = 'Trade', children } = props;
  const [subHeader, setSubHeader] = useState<ReactNode>(null);
  const floatChrome = useMemo(() => ({ setSubHeader }), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <button
        type="button"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`fixed inset-0 z-[134] bg-black/60 transition-opacity duration-200 md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        title="Close"
      />
      <div
        className={`fixed inset-y-0 right-0 z-[135] flex w-[min(380px,100vw)] flex-col border-l border-zinc-700/80 bg-zinc-950 shadow-[-12px_0_40px_rgba(0,0,0,0.45)] will-change-transform transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'pointer-events-none translate-x-full'
        }`}
        aria-hidden={!open}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Trade</div>
            <div className="truncate text-[13px] font-semibold text-zinc-100">{title}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-zinc-600/60 bg-zinc-900/80 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800/90"
            title="Close (Esc)"
          >
            Close
          </button>
        </div>
        <TradeFloatChromeProvider value={floatChrome}>
          {subHeader ? (
            <div className="shrink-0 border-b border-zinc-800/70 bg-zinc-950/95 px-3 py-2.5 backdrop-blur-sm">{subHeader}</div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 py-3 [overflow-anchor:none]">
            {children}
          </div>
        </TradeFloatChromeProvider>
      </div>
    </>
  );
}
