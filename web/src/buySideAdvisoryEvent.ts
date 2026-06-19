import type { BuySideAdvisory } from './shouldBuyWhichSide';

export const BPX_BUY_SIDE_ADVISORY_EVENT = 'bpx-buy-side-advisory';
export const BPX_BUY_SIDE_ASK_REQUEST_EVENT = 'bpx-buy-side-ask-request';

export type BuySideAdvisoryDetail = {
  slug?: string;
  advisory: BuySideAdvisory | null;
  upLabel?: string;
  downLabel?: string;
  autoAsk?: boolean;
};

export type BuySideAskRequestDetail = {
  slug?: string;
};

const lastBySlug = new Map<string, BuySideAdvisoryDetail>();

function slugKey(slug: string | undefined): string {
  return slug?.trim() ?? '';
}

export function buySideAdvisoryDetailEqual(a: BuySideAdvisoryDetail, b: BuySideAdvisoryDetail): boolean {
  if (a.slug !== b.slug || a.upLabel !== b.upLabel || a.downLabel !== b.downLabel || a.autoAsk !== b.autoAsk) {
    return false;
  }
  const aa = a.advisory;
  const bb = b.advisory;
  if (aa === bb) return true;
  if (!aa || !bb) return aa === bb;
  return (
    aa.verdict === bb.verdict &&
    aa.confidence === bb.confidence &&
    aa.recommendation === bb.recommendation &&
    aa.suggestedSize === bb.suggestedSize &&
    aa.edgePerShareUsd === bb.edgePerShareUsd &&
    aa.winProb === bb.winProb &&
    aa.mid === bb.mid &&
    aa.cautionFresh === bb.cautionFresh &&
    aa.scores.up === bb.scores.up &&
    aa.scores.down === bb.scores.down &&
    aa.reasons.join('\0') === bb.reasons.join('\0') &&
    aa.risks.join('\0') === bb.risks.join('\0')
  );
}

export function readBuySideAdvisoryCache(slug: string | undefined): BuySideAdvisoryDetail | null {
  const key = slugKey(slug);
  if (!key) return null;
  const hit = lastBySlug.get(key);
  return hit ? { ...hit } : null;
}

export function dispatchBuySideAdvisory(detail: BuySideAdvisoryDetail): void {
  if (typeof window === 'undefined') return;
  const key = slugKey(detail.slug);
  if (key) lastBySlug.set(key, { ...detail });
  window.dispatchEvent(new CustomEvent(BPX_BUY_SIDE_ADVISORY_EVENT, { detail }));
}

export function dispatchBuySideAskRequest(detail: BuySideAskRequestDetail = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BPX_BUY_SIDE_ASK_REQUEST_EVENT, { detail }));
}
