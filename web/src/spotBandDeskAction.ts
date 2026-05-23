/**
 * Spot vs PTB band playbook — chart timing guide (Confirm / Entry / Exit).
 * The Signals “Do this now” strip uses the **operator verdict + trade card** as the
 * single action line; band copy is context only (does not override ENTER / STAND_DOWN).
 */

export type DeskSingleActionTone = 'green' | 'red' | 'blue' | 'amber' | 'gray' | 'rose' | 'emerald';

export type DeskSingleAction = {
  primary: string;
  detail: string | null;
  tone: DeskSingleActionTone;
  /** Amber wall-bid caution — thick support on an outcome book (not a go signal). */
  wallBidWarning: string | null;
  /** Plain spot vs PTB + book physics (under the primary line). */
  physicsLine: string | null;
};
import type { OperatorVerdict } from './operatorVerdict';
import type { PositionExitReadout } from './positionDeskAlerts';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import { formatWallBidWarnings, type WallBidWarning } from './dualOutcomeWalls';
import { formatDeskEntryDetail, formatDeskEntryPrimary, formatEnterAtTpSl } from './tradeEntryBrief';

type DeskSingleActionIn = Omit<DeskSingleAction, 'physicsLine'> & { physicsLine?: string | null };

function finalizeDesk(
  base: DeskSingleActionIn,
  bidWarnings: WallBidWarning[] | undefined,
  entryLane: 'up' | 'down' | null | undefined,
): DeskSingleAction {
  const wallBidWarning = formatWallBidWarnings(bidWarnings ?? [], entryLane);
  let tone = base.tone;
  if (wallBidWarning && (tone === 'green' || tone === 'emerald')) tone = 'amber';
  return { ...base, wallBidWarning, tone, physicsLine: base.physicsLine ?? null };
}

export type PriceVsPtbGeo = 'IN_BAND' | 'ABOVE' | 'BELOW';

export type SeparationTier = 'WEAK' | 'CLEAR' | 'STRONG';

/** Playbook phase — matches chart Confirm / Entry / Exit cards (guide only). */
export type BandPlayStep = 'confirm' | 'entry' | 'exit' | 'stand_aside' | 'weak_sep';

export type SpotBandGaugeSnapshot = {
  mode: 'up' | 'down';
  viewLabel: string;
  oppositeLabel: string;
  geo: PriceVsPtbGeo;
  glanceVerb: string;
  separation: SeparationTier;
  edgeOk: boolean;
  inBand: boolean;
  favorableNow: boolean;
  activeStep: BandPlayStep;
  spot: number;
  ptb: number;
  bandLo: number;
  bandHi: number;
  entryLine: number;
  distUsd: number;
  slopeUsdPerMin: number | null;
  proj30s: number | null;
  confirmBody: string;
  entryHint: string;
  exitHint: string;
};

const MAX = 168;

function clip(s: string): string {
  const t = s.trim();
  if (t.length <= MAX) return t;
  return `${t.slice(0, MAX - 1)}…`;
}

export function fmtUsdDesk(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function geoShort(g: SpotBandGaugeSnapshot): string {
  if (g.geo === 'IN_BAND') return 'in band';
  if (g.geo === 'ABOVE') return 'above PTB';
  return 'below PTB';
}

function separationFromConviction(conviction: string): SeparationTier {
  if (conviction === 'STRONG SEPARATION') return 'STRONG';
  if (conviction === 'CLEAR SEPARATION') return 'CLEAR';
  return 'WEAK';
}

/** Same inputs as the chart “Where price is” gauge block. */
export function computeSpotBandGaugeSnapshot(args: {
  mode: 'up' | 'down';
  spot: number;
  ptb: number;
  band: number;
  conviction: string;
  slopeUsdPerMin?: number | null;
  distUsd?: number | null;
  proj30s?: number | null;
  upLabel?: string;
  downLabel?: string;
}): SpotBandGaugeSnapshot | null {
  const { mode, spot, ptb, band, conviction } = args;
  if (!Number.isFinite(spot) || !Number.isFinite(ptb) || !Number.isFinite(band) || band <= 0) return null;

  const upLabel = args.upLabel ?? 'UP';
  const downLabel = args.downLabel ?? 'DOWN';
  const viewLabel = mode === 'up' ? upLabel : downLabel;
  const oppositeLabel = mode === 'up' ? downLabel : upLabel;

  const lo = ptb - band;
  const hi = ptb + band;
  const d = spot - ptb;
  const inBand = Math.abs(d) <= band;
  const geo: PriceVsPtbGeo = inBand ? 'IN_BAND' : d > 0 ? 'ABOVE' : 'BELOW';
  const separation = separationFromConviction(conviction);
  const favorableNow = mode === 'up' ? spot > hi : spot < lo;
  const edgeOk = separation !== 'WEAK' && favorableNow;
  const entryLine = mode === 'up' ? hi : lo;
  const entryFmt = fmtUsdDesk(entryLine);
  const stopBand = `${fmtUsdDesk(lo)}–${fmtUsdDesk(hi)}`;

  const glanceVerb = inBand
    ? 'confirm break'
    : edgeOk
      ? 'edge live'
      : 'wrong view';

  const confirmBody = inBand
    ? `Break & hold ${mode === 'up' ? `above ${fmtUsdDesk(hi)}` : `below ${fmtUsdDesk(lo)}`}.`
    : edgeOk
      ? `Hold ${entryFmt} on pullbacks — stay outside band.`
      : `Switch to ${oppositeLabel} view or wait.`;

  const entryHint = edgeOk && !inBand ? `Pullback holds ${entryFmt}.` : inBand ? 'In band — confirm first.' : 'No entry this view.';

  const exitHint = `Exit if back in ${stopBand}`;

  let activeStep: BandPlayStep = 'stand_aside';
  if (inBand) activeStep = 'confirm';
  else if (separation === 'WEAK') activeStep = 'weak_sep';
  else if (edgeOk) activeStep = 'entry';
  else activeStep = 'stand_aside';

  return {
    mode,
    viewLabel,
    oppositeLabel,
    geo,
    glanceVerb,
    separation,
    edgeOk,
    inBand,
    favorableNow,
    activeStep,
    spot,
    ptb,
    bandLo: lo,
    bandHi: hi,
    entryLine,
    distUsd: args.distUsd ?? d,
    slopeUsdPerMin: args.slopeUsdPerMin ?? null,
    proj30s: args.proj30s ?? null,
    confirmBody,
    entryHint,
    exitHint,
  };
}

function playbookWaitPrimary(g: SpotBandGaugeSnapshot): string {
  if (g.activeStep === 'weak_sep') {
    return clip(`WAIT — weak sep · ${geoShort(g)} · no ${g.viewLabel} press`);
  }
  const breakAt = g.mode === 'up' ? fmtUsdDesk(g.bandHi) : fmtUsdDesk(g.bandLo);
  return clip(`WAIT — ${geoShort(g)} · confirm break ${g.mode === 'up' ? 'above' : 'below'} ${breakAt}`);
}

function playbookSetupPrimary(
  g: SpotBandGaugeSnapshot,
  levels: TradeLevels | null | undefined,
  directive: TradeDirective | null | undefined,
): string {
  const enterLine = formatEnterAtTpSl({
    lane: g.mode,
    levels: levels?.lane === g.mode ? levels : null,
    mid01: directive?.lane === g.mode ? directive.laneMid : null,
  });
  if (enterLine) return clip(enterLine);
  const hold = fmtUsdDesk(g.entryLine);
  return clip(`WAIT — ${g.viewLabel} · hold ${hold}`);
}

function playbookDetail(g: SpotBandGaugeSnapshot): string | null {
  const parts = [g.entryHint, g.exitHint].filter(Boolean);
  if (g.slopeUsdPerMin != null && Number.isFinite(g.slopeUsdPerMin)) {
    parts.push(`slope ${g.slopeUsdPerMin >= 0 ? '+' : ''}${g.slopeUsdPerMin.toFixed(1)}/m`);
  }
  return parts.length ? clip(parts.join(' · ')) : null;
}

/** Band timing as secondary context — never replaces the verdict primary line. */
function bandGuideDetail(g: SpotBandGaugeSnapshot | null | undefined): string | null {
  if (!g) return null;
  const phase =
    g.activeStep === 'confirm'
      ? 'Confirm (guide)'
      : g.activeStep === 'entry'
        ? 'Entry (guide)'
        : g.activeStep === 'weak_sep'
          ? 'Weak sep (guide)'
          : 'Stand aside (guide)';
  return clip(`${phase} · ${geoShort(g)} · ${g.confirmBody}`);
}

function flowLeadDetail(
  flowWinningLane: 'up' | 'down' | null | undefined,
  bookControl: 'up' | 'down' | null | undefined,
  upLabel: string,
  downLabel: string,
  wallHeadline?: string | null,
): string | null {
  const parts: string[] = [];
  if (wallHeadline?.trim()) parts.push(wallHeadline.trim());
  if (flowWinningLane) {
    const label = flowWinningLane === 'up' ? upLabel : downLabel;
    const book =
      bookControl === 'up' ? upLabel : bookControl === 'down' ? downLabel : null;
    parts.push(`Flow ${label}`);
    if (book) parts.push(`control ${book}`);
  }
  if (!parts.length) return null;
  return clip(parts.join(' · '));
}

/** PTB band geometry alone must not drive ENTER when order flow names the other side. */
function ptbBandConflictsFlow(
  g: SpotBandGaugeSnapshot,
  flowWinningLane: 'up' | 'down' | null | undefined,
): boolean {
  return flowWinningLane != null && flowWinningLane !== g.mode;
}

function appendDetail(...parts: Array<string | null | undefined>): string | null {
  const t = parts.filter((p) => p != null && String(p).trim() !== '').join(' · ');
  return t ? clip(t) : null;
}

function verdictTone(verdict: OperatorVerdict): DeskSingleActionTone {
  if (verdict.isStandDown) return 'gray';
  if (verdict.color === 'green') return 'green';
  if (verdict.color === 'red') return 'red';
  if (verdict.color === 'blue') return 'blue';
  if (verdict.color === 'amber') return 'amber';
  return 'gray';
}

function verdictDeskLine(
  verdict: OperatorVerdict,
  directive: TradeDirective | null | undefined,
  levels: TradeLevels | null | undefined,
  upLabel: string,
  downLabel: string,
  bandGuide: string | null,
): DeskSingleAction {
  return {
    primary: clip(formatDeskEntryPrimary(verdict, directive, levels, upLabel, downLabel)),
    detail: appendDetail(formatDeskEntryDetail(verdict, directive, levels, upLabel, downLabel), bandGuide),
    tone: verdictTone(verdict),
    wallBidWarning: null,
    physicsLine: null,
  };
}

function isGoVerdict(verdict: OperatorVerdict): boolean {
  return !verdict.isStandDown && (verdict.state === 'GO_LONG' || verdict.state === 'GO_SHORT');
}

/**
 * One steady desk strip: operator verdict + trade card (ENTER/EXIT/HOLD/STAND_DOWN).
 * Band playbook only appears in the detail line as timing context.
 */
export function resolveDeskPlaybookAction(args: {
  bandGauge?: SpotBandGaugeSnapshot | null | undefined;
  manualLane: 'up' | 'down' | null;
  exitReadout: PositionExitReadout | null;
  verdict: OperatorVerdict | null;
  hasDirective: boolean;
  directive?: TradeDirective | null;
  levels?: TradeLevels | null;
  upLabel?: string;
  downLabel?: string;
  /** Book + tape winning side — overrides PTB-band ENTER when it disagrees. */
  flowWinningLane?: 'up' | 'down' | null;
  bookControl?: 'up' | 'down' | null;
  wallHeadline?: string | null;
  wallBidWarnings?: WallBidWarning[];
}): DeskSingleAction {
  const {
    bandGauge: g,
    manualLane,
    exitReadout,
    verdict,
    hasDirective,
    directive,
    levels = null,
    upLabel = 'UP',
    downLabel = 'DOWN',
    flowWinningLane = null,
    bookControl = null,
    wallHeadline = null,
    wallBidWarnings = [],
  } = args;

  const entryLane = directive?.lane ?? manualLane;
  const fin = (base: DeskSingleActionIn) => finalizeDesk(base, wallBidWarnings, entryLane);

  const flowGuide = flowLeadDetail(flowWinningLane, bookControl, upLabel, downLabel, wallHeadline);
  const bandGuide = appendDetail(bandGuideDetail(g), flowGuide);

  if (!hasDirective && manualLane == null) {
    return fin({ primary: 'WAIT — syncing…', detail: bandGuide, tone: 'gray', wallBidWarning: null });
  }

  if (manualLane != null && exitReadout) {
    const d = directive ?? null;
    const exitDetail = () => {
      const parts = [exitReadout.headline, exitReadout.detail].filter(Boolean);
      return parts.length ? parts.join(' — ') : null;
    };

    if (exitReadout.band === 'exit_now' || exitReadout.band === 'trim') {
      return fin({
        primary: clip(exitReadout.headline),
        detail: appendDetail(exitReadout.detail, bandGuide),
        tone: exitReadout.band === 'exit_now' ? 'rose' : 'amber',
        wallBidWarning: null,
      });
    }

    if (verdict && d && isGoVerdict(verdict) && d.lane && d.lane !== manualLane) {
      return fin({
        ...verdictDeskLine(verdict, d, levels, upLabel, downLabel, bandGuide),
        detail: appendDetail(exitDetail(), bandGuide),
      });
    }

    if (
      verdict &&
      d?.lane === manualLane &&
      (((d.action === 'INITIATE' || d.action === 'ADD') && isGoVerdict(verdict)) ||
        (d.action === 'HOLD' && verdict.state === 'HOLD'))
    ) {
      return fin({
        ...verdictDeskLine(verdict, d, levels, upLabel, downLabel, bandGuide),
        detail: appendDetail(exitDetail(), bandGuide),
      });
    }

    const tone: DeskSingleActionTone =
      exitReadout.band === 'watch' ? 'amber' : 'emerald';
    return fin({
      primary: clip(exitReadout.headline),
      detail: appendDetail(exitReadout.detail, bandGuide),
      tone,
      wallBidWarning: null,
    });
  }

  if (!verdict) {
    if (g && flowWinningLane && ptbBandConflictsFlow(g, flowWinningLane)) {
      const flowLabel = flowWinningLane === 'up' ? upLabel : downLabel;
      return fin({
        primary: clip(
          `WAIT — ${geoShort(g)} but book/tape favor ${flowLabel} — follow flow, not PTB band alone`,
        ),
        detail: bandGuide,
        tone: 'amber',
        wallBidWarning: null,
      });
    }
    if (g && (g.activeStep === 'confirm' || g.activeStep === 'weak_sep')) {
      return fin({
        primary: playbookWaitPrimary(g),
        detail: clip(g.confirmBody),
        tone: 'amber',
        wallBidWarning: null,
      });
    }
    if (g?.activeStep === 'stand_aside') {
      return fin({
        primary: clip(`STAND ASIDE — ${geoShort(g)} · use ${g.oppositeLabel} view`),
        detail: clip(g.confirmBody),
        tone: 'gray',
        wallBidWarning: null,
      });
    }
    return fin({ primary: 'WAIT — trade line loading.', detail: bandGuide, tone: 'gray', wallBidWarning: null });
  }

  if (verdict.state === 'EXIT_NOW' || verdict.state === 'HOLD' || verdict.isStandDown || isGoVerdict(verdict)) {
    return fin(verdictDeskLine(verdict, directive, levels, upLabel, downLabel, bandGuide));
  }

  if (g?.activeStep === 'entry' && g.edgeOk) {
    if (flowWinningLane && ptbBandConflictsFlow(g, flowWinningLane)) {
      const flowLabel = flowWinningLane === 'up' ? upLabel : downLabel;
      return fin({
        primary: clip(
          `WAIT — PTB edge for ${g.viewLabel} but order flow favors ${flowLabel} — use trade card / book`,
        ),
        detail: bandGuide,
        tone: 'amber',
        wallBidWarning: null,
      });
    }
    if (
      verdict &&
      directive?.lane &&
      directive.lane === g.mode &&
      isGoVerdict(verdict) &&
      (flowWinningLane == null || flowWinningLane === directive.lane)
    ) {
      return fin(verdictDeskLine(verdict, directive, levels, upLabel, downLabel, bandGuide));
    }
    if (flowWinningLane === g.mode || (flowWinningLane == null && bookControl === g.mode)) {
      return fin({
        primary: playbookSetupPrimary(g, levels, directive),
        detail: appendDetail(playbookDetail(g), bandGuide),
        tone: 'green',
        wallBidWarning: null,
      });
    }
    return fin({
      primary: playbookWaitPrimary(g),
      detail: bandGuide,
      tone: 'amber',
      wallBidWarning: null,
    });
  }

  return fin(verdictDeskLine(verdict, directive, levels, upLabel, downLabel, bandGuide));
}

/** @deprecated Use resolveDeskPlaybookAction — kept for tests. */
export function computeSpotBandDeskAction(g: SpotBandGaugeSnapshot | null | undefined): DeskSingleAction | null {
  if (!g) return null;
  return resolveDeskPlaybookAction({
    bandGauge: g,
    manualLane: null,
    exitReadout: null,
    verdict: null,
    hasDirective: false,
  });
}
