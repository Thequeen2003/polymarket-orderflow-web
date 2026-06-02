const LS_PREFIX = 'pm-desk-panel:v1:';

export function loadDeskPanelOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}${id}`);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch {
    /* ignore */
  }
  return defaultOpen;
}

export function saveDeskPanelOpen(id: string, open: boolean): void {
  try {
    localStorage.setItem(`${LS_PREFIX}${id}`, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}
