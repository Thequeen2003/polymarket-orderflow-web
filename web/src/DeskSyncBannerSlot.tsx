import type { ReactElement, ReactNode } from 'react';

/** Fixed-height slot so trade-panel / lane sync banners do not shift the chart column. */
export function DeskSyncBannerSlot(props: { children: ReactNode }): ReactElement {
  const active = props.children != null;
  return (
    <div
      className={`mb-3 overflow-hidden transition-[min-height] duration-150 ${
        active ? 'min-h-[3.25rem]' : 'min-h-0'
      }`}
      aria-live="polite"
    >
      {props.children}
    </div>
  );
}
