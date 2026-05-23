/**
 * Orphan pointer capture (e.g. chart bracket drag interrupted by market switch)
 * can make the whole page ignore clicks until reload. Track and release on
 * pointerup / cancel / blur / market changes.
 */
let captureEl: Element | null = null;
let capturePointerId: number | null = null;

export function trackPointerCapture(el: Element, pointerId: number): void {
  captureEl = el;
  capturePointerId = pointerId;
}

export function clearTrackedPointerCapture(el: Element, pointerId: number): void {
  try {
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  } catch {
    /* already released */
  }
  if (captureEl === el && capturePointerId === pointerId) {
    captureEl = null;
    capturePointerId = null;
  }
}

export function releaseOrphanPointerCapture(): void {
  if (captureEl != null && capturePointerId != null) {
    try {
      if (captureEl.hasPointerCapture(capturePointerId)) {
        captureEl.releasePointerCapture(capturePointerId);
      }
    } catch {
      /* element may be detached */
    }
  }
  captureEl = null;
  capturePointerId = null;
}

let installed = false;

export function installPointerCaptureSafety(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const release = () => releaseOrphanPointerCapture();
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
}
