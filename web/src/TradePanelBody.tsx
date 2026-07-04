import type { ReactElement, ReactNode } from 'react';
import { SignalsTradePanel, type SignalsTradePanelProps } from './SignalsTradePanel';

type Props = {
  title?: string;
  subtitle?: string;
  enabled: boolean;
  ready: boolean;
  panelProps: Omit<SignalsTradePanelProps, 'visualStyle'>;
  /** `default` | `sidebar` = docked panel; `slide` = slide-in panel. */
  visualStyle?: 'default' | 'sidebar' | 'slide';
  className?: string;
};

function TradeUnavailable(props: { ready: boolean }): ReactElement {
  const { ready } = props;
  if (!ready) {
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-[13px] leading-relaxed text-zinc-400">
        <p className="font-medium text-zinc-300">Almost there</p>
        <ol className="mt-2 list-decimal space-y-1 pl-4 text-zinc-500">
          <li>Open a market from the shortcuts or search.</li>
          <li>Wait for the order book to load.</li>
          <li>Trade controls unlock automatically.</li>
        </ol>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-amber-900/25 bg-amber-950/10 p-4 text-[13px] leading-relaxed text-amber-100/85">
      <p className="font-medium text-amber-100">Tokens not ready</p>
      <p className="mt-2 text-amber-100/75">
        Need both outcome tokens (Yes/No or Up/Down). Try another slug or wait for books.
      </p>
    </div>
  );
}

/** Shared trade body — docked sidebar (default) or floating slide shell. */
export function TradePanelBody(props: Props): ReactElement {
  const {
    title = 'Trade',
    subtitle,
    enabled,
    ready,
    panelProps,
    visualStyle = 'default',
    className = '',
  } = props;

  return (
    <div className={className}>
      {subtitle || visualStyle === 'default' ? (
        <div className="mb-3">
          <div className="text-[15px] font-semibold text-zinc-100">{title}</div>
          {subtitle ? <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{subtitle}</p> : null}
          {visualStyle === 'default' ? (
            <p className="mt-1 text-[10px] text-zinc-600">Docked panel — use Trade for the slide-in panel.</p>
          ) : null}
        </div>
      ) : null}
      {ready ? (
        <>
          {!enabled ? (
            <div className="mb-3">
              <TradeUnavailable ready />
            </div>
          ) : null}
          <SignalsTradePanel {...panelProps} visualStyle={visualStyle} />
        </>
      ) : (
        <TradeUnavailable ready={false} />
      )}
    </div>
  );
}

export function TradePanelShell(props: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div
      className={`rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.02] backdrop-blur-sm sm:p-5 ${props.className ?? ''}`}
    >
      {props.children}
    </div>
  );
}
