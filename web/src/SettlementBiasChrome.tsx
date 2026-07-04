import type { ReactElement, ReactNode } from 'react';

const TRADE_SLIDE_PX = 380;

export function AppSlidePaddingShell(props: {
  tradeSlideReservesSpace: boolean;
  children: ReactNode;
}): ReactElement {
  const padPx = props.tradeSlideReservesSpace ? TRADE_SLIDE_PX : 0;

  return (
    <div
      className="min-h-full bg-zinc-950 bg-[radial-gradient(100%_60%_at_50%_-10%,rgba(99,102,241,0.08),transparent_52%),linear-gradient(180deg,#0b0b0f_0%,#09090b_45%,#060608_100%)] font-sans text-zinc-200 antialiased"
      style={padPx > 0 ? { paddingRight: padPx } : undefined}
    >
      {props.children}
    </div>
  );
}
