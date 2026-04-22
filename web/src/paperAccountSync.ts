/** Fired after paper account mutations outside `SignalsTradePanel` (e.g. global exits). */
export const PAPER_ACCOUNT_SYNC_EVENT = 'pmof:paper-sync';

export function notifyPaperAccountUpdated(): void {
  window.dispatchEvent(new Event(PAPER_ACCOUNT_SYNC_EVENT));
}
