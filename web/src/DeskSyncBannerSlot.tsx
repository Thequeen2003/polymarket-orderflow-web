import type { ReactElement, ReactNode } from 'react';

/** Fixed-height slot so trade-panel / lane sync banners do not shift the chart column. */
export function DeskSyncBannerSlot(props: { children: ReactNode }): ReactElement {
  const active = props.children != null;
  return (
    <div
      className="mb-3 min-h-[3.25rem] overflow-hidden"
      aria-live="polite"
    >
      <div className={active ? '' : 'pointer-events-none invisible'} aria-hidden={!active}>
        {props.children}
      </div>
    </div>
  );
}
