import type { ReactElement, ReactNode } from 'react';

/**
 * Wraps the scaled app shell. View zoom scale is exposed as `--app-viewport-scale` on
 * `<html>` for typography hooks; we intentionally do NOT apply CSS `zoom` here because
 * it breaks click targets on long desk pages (signals + market sidebar).
 */
export function ViewportZoomShell(props: { scale: number; children: ReactNode }): ReactElement {
  const { children } = props;

  return (
    <div id="app-viewport-zoom" className="min-h-full">
      {children}
    </div>
  );
}
