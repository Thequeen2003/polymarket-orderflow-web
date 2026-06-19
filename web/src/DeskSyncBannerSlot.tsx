import type { ReactElement, ReactNode } from 'react';

/** Fixed-height slot so trade-panel / lane sync banners do not shift the chart column. */
export function DeskSyncBannerSlot(props: { children: ReactNode }): ReactElement {
  return (
    <div className="mb-3 min-h-[3.25rem] overflow-hidden" aria-live="polite">
      {props.children}
    </div>
  );
}
