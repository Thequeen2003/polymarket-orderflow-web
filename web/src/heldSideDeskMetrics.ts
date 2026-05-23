import type { TradeDirective } from './tradeDirective';
import type { TapeVelocity } from './tapeVelocity';

export type HeldSideDeskMetrics = {
  /** Outcome label + pinned touch mid when you tapped **I hold** (e.g. `BTC Up @ 95.0¢`). */
  holdBanner: string;
  /** Same mid as in the banner, for a dedicated tile (`—` if not pinned). */
  holdAnchorMid: string;
  /** Live touch mid vs pinned tag (e.g. `+1.2¢ vs tag`). */
  vsHoldTag: string;
  /** Touch mid for the outcome you marked (0–1 → ¢). */
  impliedMid: string;
  /** Time since you tapped the hold ack. */
  inTrade: string;
  /** Round / market clock m:ss. */
  bell: string;
  /** PTB cross model (0–1 → %). */
  cross: string;
  /** Fused sensor agreement % (machine focus lane — can differ from your fill). */
  agreement: string;
  /** One-line desk tape readout. */
  tape: string;
  /** Trade card action · lane (human labels). */
  card: string;
};

function fmtMid01(mid: number | null | undefined): string {
  if (mid == null || !Number.isFinite(mid) || mid <= 0 || mid >= 1) return '—';
  return `${(mid * 100).toFixed(1)}¢`;
}

function fmtBell(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function fmtInTrade(takenAtMs: number | null | undefined, nowMs: number): string {
  if (takenAtMs == null || !Number.isFinite(takenAtMs)) return '—';
  const sec = Math.max(0, Math.floor((nowMs - takenAtMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

function fmtPct01(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
}

function tapeLine(t: TapeVelocity): string {
  if (!t.reliable) return 'Warming up';
  const dom = t.dominance;
  const burst = t.burst === 'aggressive' || t.burst === 'extreme' ? ` · ${t.burst}` : '';
  const np = Math.round(t.netPressure);
  const nps = np >= 0 ? `+${np}` : `${np}`;
  return `${dom}${burst} · ${nps}`;
}

function cardLine(d: TradeDirective | null, upLabel: string, downLabel: string): string {
  if (!d) return 'Loading…';
  const laneLab = d.lane === 'up' ? upLabel : d.lane === 'down' ? downLabel : '—';
  return `${d.action} · ${laneLab}`;
}

function fmtVsHoldTag(heldAtMid01: number | null | undefined, liveMid01: number | null | undefined): string {
  if (heldAtMid01 == null || !Number.isFinite(heldAtMid01) || heldAtMid01 <= 0 || heldAtMid01 >= 1) return '—';
  if (liveMid01 == null || !Number.isFinite(liveMid01) || liveMid01 <= 0 || liveMid01 >= 1) return 'Live mid —';
  const dc = (liveMid01 - heldAtMid01) * 100;
  if (Math.abs(dc) < 0.06) return 'Flat vs tag';
  const sign = dc > 0 ? '+' : '';
  return `${sign}${dc.toFixed(1)}¢ vs tag`;
}

/**
 * Live numbers for the Signals desk after **I hold · Up/Down** — fast glance vs narrative playbook.
 */
export function buildHeldSideDeskMetrics(input: {
  myLane: 'up' | 'down';
  /** Touch mid (0–1) captured when you tapped **I hold**; persisted per market. */
  heldAtMid01: number | null;
  impliedMidUp01: number | null;
  impliedMidDown01: number | null;
  crossProb: number | null;
  agreementScore: number | null;
  endsInMs: number | null;
  takenAtMs: number | null;
  nowMs: number;
  tape: TapeVelocity;
  directive: TradeDirective | null;
  upLabel: string;
  downLabel: string;
}): HeldSideDeskMetrics {
  const {
    myLane,
    heldAtMid01,
    impliedMidUp01,
    impliedMidDown01,
    crossProb,
    agreementScore,
    endsInMs,
    takenAtMs,
    nowMs,
    tape,
    directive,
    upLabel,
    downLabel,
  } = input;
  const laneLabel = myLane === 'up' ? upLabel : downLabel;
  const anchorOk =
    heldAtMid01 != null && Number.isFinite(heldAtMid01) && heldAtMid01 > 0 && heldAtMid01 < 1;
  const holdBanner = anchorOk ? `${laneLabel} @ ${fmtMid01(heldAtMid01)}` : laneLabel;
  const holdAnchorMid = anchorOk ? fmtMid01(heldAtMid01) : '—';
  const mid = myLane === 'up' ? impliedMidUp01 : impliedMidDown01;
  return {
    holdBanner,
    holdAnchorMid,
    vsHoldTag: fmtVsHoldTag(heldAtMid01, mid),
    impliedMid: fmtMid01(mid),
    inTrade: fmtInTrade(takenAtMs, nowMs),
    bell: fmtBell(endsInMs),
    cross: fmtPct01(crossProb),
    agreement: agreementScore != null && Number.isFinite(agreementScore) ? `${Math.round(agreementScore)}%` : '—',
    tape: tapeLine(tape),
    card: cardLine(directive, upLabel, downLabel),
  };
}
