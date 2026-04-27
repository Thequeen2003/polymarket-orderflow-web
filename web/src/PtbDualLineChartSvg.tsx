import type { ReactElement, ReactNode } from 'react';
import type { PtbSystemDecision } from './ptbDecisionEngine';
import type { PtbTargetEngineCard } from './ptbTargetEngine';
import { downsampleLinePoints, segmentDualLaneStyle, type PtbLinePoint } from './ptbLineChart';

type GapBlock = {
  a: number;
  b: number;
  strength10: number;
  lo: number;
  hi: number;
  active: boolean;
  exitWall: number | null;
};

export type PtbDualLineChartSvgProps = {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padY: number;
  plotW: number;
  plotH: number;
  topY0: number;
  tMin: number;
  tMax: number;
  scaleMin: number;
  scaleMax: number;
  lineSeriesUp: PtbLinePoint[];
  lineSeriesDown: PtbLinePoint[];
  lastU: number;
  lastD: number;
  /** Engine “trade this leg” — only this line gets target band + vacuum emphasis. */
  activeTargetLane: 'up' | 'down';
  gapActive: GapBlock | null;
  vacActive: number[];
  vacHi: number;
  pathActive: boolean;
  engine: PtbSystemDecision;
  ptbTarget: PtbTargetEngineCard;
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  speedScore01: number;
  tradeTrigger: {
    line: number | null;
    lane: 'up' | 'down';
    fadeWall: number | null;
    fadeLane: 'up' | 'down' | null;
  };
  counterEnter: { line: number; lane: 'up' | 'down' } | null;
  upLabel: string;
  downLabel: string;
  priceToBeatUsd?: number | null;
  fmtPct: (p: number) => string;
  fmtChartWindowMin: (tMin: number, tMax: number) => string;
  /** Book / mid snapshot time — drives “current vs stale” in the footer. */
  lastUpdateMs: number | null;
  dataStale: boolean;
  onTapProb?: (p: number, ctx?: { lane: 'up' | 'down' }) => void;
  emitGap: (side: 'up' | 'down', g: GapBlock | null, entryNow: number) => void;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

const GAP_Q = 0.38;
const BIN_N = 28;

/** Default chart chrome — no heavy outline (reads cleaner than thick “halo” text). */
function Txt(props: {
  x: number;
  y: number;
  anchor?: 'start' | 'middle' | 'end';
  size: number;
  weight?: number;
  fill: string;
  fontFamily?: string;
  children: ReactNode;
}): ReactElement {
  const { x, y, anchor = 'start', size, weight = 500, fill, fontFamily, children } = props;
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fill={fill}
      fontSize={size}
      fontWeight={weight}
      fontFamily={fontFamily}
      className="pointer-events-none select-none"
    >
      {children}
    </text>
  );
}

/** Text drawn over lines / bands — very light outline so it stays legible without looking muddy. */
function OverlayTxt(props: {
  x: number;
  y: number;
  anchor?: 'start' | 'middle' | 'end';
  size: number;
  weight?: number;
  fill: string;
  fontFamily?: string;
  children: ReactNode;
}): ReactElement {
  const { x, y, anchor = 'start', size, weight = 600, fill, fontFamily, children } = props;
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fill={fill}
      fontSize={size}
      fontWeight={weight}
      fontFamily={fontFamily}
      className="pointer-events-none select-none"
      style={{
        paintOrder: 'stroke fill',
        stroke: 'rgba(0,0,0,0.42)',
        strokeWidth: 0.85,
        strokeLinejoin: 'round',
      }}
    >
      {children}
    </text>
  );
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function fmtSignedPpFrom50(prob01: number): string {
  const pp = (prob01 - 0.5) * 100;
  const s = pp >= 0 ? '+' : '';
  return `${s}${pp.toFixed(1)}pp`;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Pick Y-axis tick values so adjacent labels don’t stack (min ~14px apart in viewBox space). */
function filterTicksByPixelGap(ticks: number[], yOf: (p: number) => number, minGapPx: number): number[] {
  const sorted = [...new Set(ticks)].sort((a, b) => yOf(a) - yOf(b));
  const out: number[] = [];
  for (const tp of sorted) {
    const yy = yOf(tp);
    if (out.length === 0 || Math.abs(yy - yOf(out[out.length - 1]!)) >= minGapPx) out.push(tp);
  }
  return out;
}

function prepareLinePoints(series: PtbLinePoint[], fallback: PtbLinePoint, maxN: number): PtbLinePoint[] {
  const source = series.length > 0 ? series : [fallback];
  let pts = downsampleLinePoints(source, maxN);
  if (series.length > 0 && pts.length >= 1) {
    const last = series[series.length - 1]!;
    pts = pts.length === 1 ? [last] : [...pts.slice(0, -1), last];
  }
  return pts;
}

function buildArrows(
  pts: PtbLinePoint[],
  speedLabel: 'SLOW' | 'MED' | 'FAST',
  xT: (t: number) => number,
  y: (v: number) => number,
): { x: number; y: number; deg: number; key: string; fiery: boolean }[] {
  const arrowStride = speedLabel === 'FAST' ? 2 : speedLabel === 'MED' ? 3 : 5;
  const arrowStart = Math.max(1, Math.floor(pts.length * 0.45));
  const arrows: { x: number; y: number; deg: number; key: string; fiery: boolean }[] = [];
  for (let i = arrowStart; i < pts.length - 1; i += arrowStride) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const x1 = xT(a.t);
    const y1 = y(a.v);
    const x2 = xT(b.t);
    const y2 = y(b.v);
    const deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    arrows.push({
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      deg,
      key: `a-${i}-${b.t}`,
      fiery: speedLabel === 'FAST',
    });
  }
  return arrows;
}

export function PtbDualLineChartSvg(p: PtbDualLineChartSvgProps): ReactElement {
  const {
    width,
    height,
    padL,
    padR,
    plotW,
    plotH,
    topY0,
    tMin,
    tMax,
    scaleMin,
    scaleMax,
    lineSeriesUp,
    lineSeriesDown,
    lastU,
    lastD,
    activeTargetLane,
    gapActive,
    vacActive,
    vacHi,
    pathActive,
    engine,
    ptbTarget,
    speedLabel,
    speedScore01,
    tradeTrigger,
    counterEnter,
    upLabel,
    downLabel,
    fmtPct,
    fmtChartWindowMin,
    lastUpdateMs,
    dataStale,
    onTapProb,
    emitGap,
  } = p;

  const tSpan = Math.max(1, tMax - tMin);
  const xT = (t: number) => padL + ((t - tMin) / tSpan) * plotW;

  const yMap = (prob: number, plotMin: number, plotMax: number, yTop: number, h: number) => {
    const span = Math.max(1e-9, plotMax - plotMin);
    return yTop + (1 - (clamp01(prob) - plotMin) / span) * h;
  };

  const yRaw = (prob: number) => yMap(prob, scaleMin, scaleMax, topY0, plotH);
  const y50 = yRaw(0.5);

  const lastUp =
    lineSeriesUp.length > 0 ? lineSeriesUp[lineSeriesUp.length - 1]! : ({ t: tMax, v: lastU } satisfies PtbLinePoint);
  const lastDn =
    lineSeriesDown.length > 0
      ? lineSeriesDown[lineSeriesDown.length - 1]!
      : ({ t: tMax, v: lastD } satisfies PtbLinePoint);

  const ptsU = prepareLinePoints(lineSeriesUp, { t: tMin, v: lastU }, 720);
  const ptsD = prepareLinePoints(lineSeriesDown, { t: tMin, v: lastD }, 720);

  const activePts = activeTargetLane === 'up' ? ptsU : ptsD;
  const arrows = buildArrows(activePts, speedLabel, xT, yRaw);

  const activeRecent = (() => {
    const pts = activePts;
    if (pts.length < 3) return null;
    const a = pts[pts.length - 3]!;
    const b = pts[pts.length - 2]!;
    const c = pts[pts.length - 1]!;
    const dv1 = b.v - a.v;
    const dv2 = c.v - b.v;
    const accel = dv2 - dv1;
    const dtMs = Math.max(1, c.t - b.t);
    const ratePerSec = Math.abs(dv2) / (dtMs / 1000);
    const jumpPp = dv2 * 100; // probability points
    const accelPp = accel * 100;
    // Momentum is “how hard is it moving right now”, not just tape speed.
    const momentum01 = clamp((Math.abs(jumpPp) / 1.6) * 0.6 + speedScore01 * 0.55 + clamp(ratePerSec / 0.004, 0, 1) * 0.35, 0, 1);
    const heading = dv2 >= 0 ? 'TOP' : 'BOTTOM';
    const chasingRisk = speedLabel !== 'SLOW' && Math.abs(jumpPp) >= 1.2 && accelPp > 0.25;
    return { jumpPp, accelPp, momentum01, heading, chasingRisk };
  })();

  const enterLine = tradeTrigger.line;
  const counterLine = counterEnter?.line ?? null;
  const fadeLine = tradeTrigger.fadeWall;

  const yEnter = enterLine != null ? yRaw(enterLine) : null;
  const yCounter = counterLine != null ? yRaw(counterLine) : null;
  const yFade = fadeLine != null ? yRaw(fadeLine) : null;
  const enterAltOverlap = yEnter != null && yCounter != null && Math.abs(yEnter - yCounter) < 20;
  const enterFadeOverlap = yEnter != null && yFade != null && Math.abs(yEnter - yFade) < 18;
  const counterFadeOverlap = yCounter != null && yFade != null && Math.abs(yCounter - yFade) < 18;
  const yEnterLbl =
    enterAltOverlap && yEnter != null && yCounter != null ? (yEnter + yCounter) / 2 - 4 : yEnter != null ? yEnter - 6 : 0;
  const yCounterLbl =
    enterAltOverlap && yEnter != null && yCounter != null ? (yEnter + yCounter) / 2 - 4 : yCounter != null ? yCounter + 12 : 0;

  const activeLast = activeTargetLane === 'up' ? lastUp : lastDn;
  const activeVNow = activeTargetLane === 'up' ? lastU : lastD;

  const projX0 = xT(activeLast.t);
  const projY0 = yRaw(activeLast.v);
  const projX1 = padL + plotW * 0.93;
  const projY1 = yRaw(ptbTarget.next01);
  const projYLo = yRaw(ptbTarget.lo01);
  const projYHi = yRaw(ptbTarget.hi01);

  const targetBandStroke = activeTargetLane === 'up' ? 'rgba(52, 211, 153, 0.45)' : 'rgba(251, 113, 133, 0.45)';

  const feedClock =
    lastUpdateMs != null
      ? new Date(lastUpdateMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : '';
  const feedStatus =
    lastUpdateMs == null ? 'No snapshot time (open Book to stream)' : dataStale ? `Stale · ${feedClock}` : `Current · ${feedClock}`;

  const span01 = Math.max(1e-6, scaleMax - scaleMin);
  const gridStepCents = span01 > 0.26 ? 10 : 5;
  const centTicksGrid: number[] = [];
  const c0 = Math.ceil(scaleMin * 100 - 1e-9);
  const c1 = Math.floor(scaleMax * 100 + 1e-9);
  for (let c = c0; c <= c1; c += gridStepCents) {
    const tp = c / 100;
    if (tp >= scaleMin - 1e-9 && tp <= scaleMax + 1e-9) centTicksGrid.push(tp);
  }
  let centTicksRight = filterTicksByPixelGap(centTicksGrid, yRaw, 15);
  if (0.5 >= scaleMin - 1e-9 && 0.5 <= scaleMax + 1e-9 && !centTicksRight.some((t) => Math.abs(t - 0.5) < 1e-6)) {
    centTicksRight = [...centTicksRight, 0.5].sort((a, b) => yRaw(a) - yRaw(b));
    centTicksRight = filterTicksByPixelGap(centTicksRight, yRaw, 13);
  }

  const ux = xT(lastUp.t);
  const uy = yRaw(lastUp.v);
  const dx = xT(lastDn.t);
  const dy = yRaw(lastDn.v);
  const ySepPts = Math.abs(uy - dy);
  const xSepPts = Math.abs(ux - dx);
  let upLabelX = ux + 12;
  let upLabelY = uy + 3;
  let dnLabelX = dx + 12;
  let dnLabelY = dy + 3;
  let upTa: 'start' | 'end' = 'start';
  let dnTa: 'start' | 'end' = 'start';
  if (ySepPts < 22 && xSepPts < 42) {
    if (uy <= dy) {
      upLabelY = uy - 9;
      dnLabelY = dy + 13;
    } else {
      upLabelY = uy + 13;
      dnLabelY = dy - 9;
    }
  }
  if (xSepPts < 36) {
    upLabelX = ux + 14;
    dnLabelX = dx - 14;
    dnTa = 'end';
  }

  const dotStride = (n: number) => Math.max(1, Math.floor(n / 22));

  const renderPolyline = (lane: 'up' | 'down', pts: PtbLinePoint[], keyP: string) => {
    const isActiveLane = lane === activeTargetLane;
    const glow = pts.slice(1).map((b, i) => {
      const a = pts[i]!;
      const vPrev = i > 0 ? pts[i - 1]!.v : null;
      const st = segmentDualLaneStyle(lane, vPrev, a.v, b.v, a.t, b.t, speedScore01);
      const dv = b.v - a.v;
      const isMomentumSeg = isActiveLane && speedLabel !== 'SLOW' && Math.abs(dv) >= 0.00014;
      const haloOpacity = isMomentumSeg ? 0.22 : 0.12;
      const haloWidth = isMomentumSeg ? st.strokeWidth + 8.5 : st.strokeWidth + 3;
      return (
        <line
          key={`${keyP}-glow-${b.t}-${i}`}
          x1={xT(a.t)}
          y1={yRaw(a.v)}
          x2={xT(b.t)}
          y2={yRaw(b.v)}
          stroke={st.stroke}
          strokeWidth={haloWidth}
          strokeLinecap="round"
          opacity={haloOpacity}
          filter={isMomentumSeg ? 'url(#ptbDualEnterGlow)' : undefined}
        />
      );
    });
    const lines = pts.slice(1).map((b, i) => {
      const a = pts[i]!;
      const vPrev = i > 0 ? pts[i - 1]!.v : null;
      const st = segmentDualLaneStyle(lane, vPrev, a.v, b.v, a.t, b.t, speedScore01);
      return (
        <line
          key={`${keyP}-ln-${b.t}-${i}`}
          x1={xT(a.t)}
          y1={yRaw(a.v)}
          x2={xT(b.t)}
          y2={yRaw(b.v)}
          stroke={st.stroke}
          strokeWidth={st.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    });
    return { glow, lines };
  };

  const upL = renderPolyline('up', ptsU, 'u');
  const dnL = renderPolyline('down', ptsD, 'd');

  const trailDots = (lane: 'up' | 'down', pts: PtbLinePoint[]) => {
    const stride = dotStride(pts.length);
    const out: ReactElement[] = [];
    for (let i = 0; i < pts.length - 1; i += stride) {
      const q = pts[i]!;
      out.push(
        <circle
          key={`${lane}-dot-${q.t}`}
          cx={xT(q.t)}
          cy={yRaw(q.v)}
          r={lane === activeTargetLane ? 2.8 : 2.2}
          fill={lane === 'up' ? 'rgba(52,211,153,0.9)' : 'rgba(251,113,133,0.9)'}
          stroke="rgba(0,0,0,0.45)"
          strokeWidth={0.6}
          className="pointer-events-none"
        />,
      );
    }
    return out;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto min-h-0 w-full max-w-full max-h-[min(420px,52vh)] bg-[#060608] md:max-h-[min(480px,55vh)]"
      style={{ aspectRatio: `${width} / ${height}` }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <filter id="ptbDualLineGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="ptbDualEnterGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="pathUpProbDual" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgb(52 211 153)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="rgb(52 211 153)" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="pathDnProbDual" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      <rect
        x={padL}
        y={topY0}
        width={plotW}
        height={plotH}
        rx={16}
        fill="rgb(9 10 12)"
        stroke="rgba(63,63,70,0.85)"
        strokeWidth={1.25}
      />

      <rect x={padL} y={yRaw(1)} width={plotW} height={Math.max(1, yRaw(0.9) - yRaw(1))} fill="rgba(239,68,68,0.09)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.9)} width={plotW} height={Math.max(1, yRaw(0.8) - yRaw(0.9))} fill="rgba(234,179,8,0.08)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.8)} width={plotW} height={Math.max(1, yRaw(0.6) - yRaw(0.8))} fill="rgba(34,197,94,0.06)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.4)} width={plotW} height={Math.max(1, yRaw(0.2) - yRaw(0.4))} fill="rgba(34,197,94,0.05)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.2)} width={plotW} height={Math.max(1, yRaw(0.1) - yRaw(0.2))} fill="rgba(234,179,8,0.07)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.1)} width={plotW} height={Math.max(1, yRaw(0) - yRaw(0.1))} fill="rgba(239,68,68,0.08)" className="pointer-events-none" />

      {[0, 0.2, 0.4, 0.6, 0.8, 1].map((frac) => (
        <line
          key={`vg-${frac}`}
          x1={padL + frac * plotW}
          x2={padL + frac * plotW}
          y1={topY0}
          y2={topY0 + plotH}
          stroke="rgba(255,255,255,0.035)"
          strokeWidth={1}
          className="pointer-events-none"
        />
      ))}

      {centTicksGrid.map((tp) => (
        <line
          key={`gh-${tp}`}
          x1={padL}
          x2={padL + plotW}
          y1={yRaw(tp)}
          y2={yRaw(tp)}
          stroke={Math.abs(tp - 0.5) < 1e-6 ? 'rgba(250,204,21,0.12)' : 'rgba(161, 161, 170, 0.09)'}
          strokeWidth={1}
          strokeDasharray={Math.abs(tp - 0.5) < 1e-6 ? '0' : '3 6'}
          className="pointer-events-none"
        />
      ))}

      <line x1={padL} x2={padL + plotW} y1={y50} y2={y50} stroke="rgba(250, 204, 21, 0.22)" strokeWidth={10} className="pointer-events-none" />
      <line x1={padL} x2={padL + plotW} y1={y50} y2={y50} stroke="rgb(250 204 21)" strokeWidth={3.2} className="pointer-events-none" />
      <Txt x={padL + 10} y={y50 - 6} anchor="start" size={10} weight={700} fill="rgb(253 224 71)">
        50¢ PTB
      </Txt>

      {vacActive.map((v, i) => {
        if (i % 2 !== 0) return null;
        if (v < GAP_Q * vacHi * 1.08) return null;
        const lo = (i + 0.45) / BIN_N;
        const hi = (i + 0.55) / BIN_N;
        const y1 = yRaw(hi);
        const y2 = yRaw(lo);
        const top = Math.min(y1, y2);
        const h = Math.max(1.5, Math.abs(y2 - y1));
        return (
          <rect
            key={`vu-${i}`}
            x={padL}
            y={top}
            width={plotW}
            height={h}
            fill={`rgba(167, 139, 250, ${0.03 + 0.09 * (v / vacHi)})`}
            className="pointer-events-none"
          />
        );
      })}

      {pathActive ? (
        <rect
          x={padL}
          y={Math.min(y50, yRaw(activeVNow))}
          width={plotW}
          height={Math.max(4, Math.abs(yRaw(activeVNow) - y50))}
          fill={activeTargetLane === 'up' ? 'url(#pathUpProbDual)' : 'url(#pathDnProbDual)'}
          className="pointer-events-none"
        />
      ) : null}

      {gapActive ? (
        <>
          <rect
            x={padL}
            y={yRaw(gapActive.hi)}
            width={plotW}
            height={Math.max(6, Math.abs(yRaw(gapActive.lo) - yRaw(gapActive.hi)))}
            fill={
              gapActive.active
                ? activeTargetLane === 'up'
                  ? 'rgba(34,197,94,0.24)'
                  : 'rgba(244,63,94,0.22)'
                : activeTargetLane === 'up'
                  ? 'rgba(34,197,94,0.14)'
                  : 'rgba(244,63,94,0.12)'
            }
            stroke={activeTargetLane === 'up' ? 'rgba(34,197,94,0.85)' : 'rgba(244,63,94,0.85)'}
            strokeWidth={1.4}
            className={`${gapActive.active ? 'animate-pulse' : ''} cursor-pointer`}
            rx={10}
            onClick={() => {
              emitGap(activeTargetLane, gapActive, activeVNow);
              onTapProb?.(gapActive.hi, { lane: activeTargetLane });
            }}
          />
          <rect
            x={padL + 8}
            y={yRaw((gapActive.lo + gapActive.hi) / 2) - 10}
            width={Math.min(plotW - 20, 280)}
            height={18}
            rx={6}
            fill="rgba(24,24,27,0.88)"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
            className="pointer-events-none"
          />
          <Txt
            x={padL + 16}
            y={yRaw((gapActive.lo + gapActive.hi) / 2) + 4}
            anchor="start"
            size={8}
            weight={600}
            fill={activeTargetLane === 'up' ? 'rgb(209 250 229)' : 'rgb(254 205 211)'}
          >
            Vacuum · {activeTargetLane === 'up' ? upLabel : downLabel} · {gapActive.active ? 'on' : 'watch'}
          </Txt>
        </>
      ) : null}

      {gapActive && engine.highlightGap === activeTargetLane ? (
        <rect
          x={padL}
          y={yRaw(gapActive.hi)}
          width={plotW}
          height={Math.max(6, Math.abs(yRaw(gapActive.lo) - yRaw(gapActive.hi)))}
          fill="none"
          stroke="rgba(34,211,238,0.95)"
          strokeWidth={3}
          rx={10}
          className="animate-pulse pointer-events-none"
        />
      ) : null}

      {gapActive?.exitWall != null ? (
        <>
          {engine.highlightGap === activeTargetLane &&
          engine.highlightWallProb != null &&
          Math.abs(engine.highlightWallProb - gapActive.exitWall) < 1e-9 ? (
            <line
              x1={padL}
              x2={padL + plotW}
              y1={yRaw(gapActive.exitWall)}
              y2={yRaw(gapActive.exitWall)}
              stroke="rgba(250,204,21,0.32)"
              strokeWidth={14}
              className="pointer-events-none"
            />
          ) : null}
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(gapActive.exitWall)}
            y2={yRaw(gapActive.exitWall)}
            stroke="rgba(251,191,36,0.95)"
            strokeWidth={2}
            strokeDasharray="6 5"
            className="cursor-pointer"
            onClick={() => onTapProb?.(gapActive.exitWall!, { lane: activeTargetLane })}
          />
          <Txt x={padL + plotW - 10} y={yRaw(gapActive.exitWall) - 6} anchor="end" size={8} weight={600} fill="rgb(253 224 71)">
            Wall
          </Txt>
        </>
      ) : null}

      <line
        x1={projX0}
        y1={projY0}
        x2={projX1}
        y2={projY1}
        stroke="rgba(148, 163, 184, 0.55)"
        strokeWidth={1.6}
        strokeDasharray="4 7"
        className="pointer-events-none"
      />
      <line
        x1={projX1 - 2}
        y1={projYLo}
        x2={projX1 - 2}
        y2={projYHi}
        stroke={targetBandStroke}
        strokeWidth={10}
        className="pointer-events-none"
      />
      <OverlayTxt
        x={projX1 - 6}
        y={Math.min(projYLo, projYHi) - 6}
        anchor="end"
        size={8}
        weight={600}
        fill="rgb(228 228 231)"
      >
        Target ({activeTargetLane === 'up' ? upLabel : downLabel}) {ptbTarget.targetRangeLabel}
      </OverlayTxt>

      {/* Large projected (next) value pill right of target band */}
      {isFiniteNumber(projYLo) && isFiniteNumber(projYHi) && isFiniteNumber(ptbTarget.next01) ? (
        <>
          <rect
            x={projX1 - 132}
            y={Math.min(projYLo, projYHi) - 2}
            width={124}
            height={18}
            rx={8}
            fill="rgba(24,24,27,0.82)"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={1}
            className="pointer-events-none"
          />
          <Txt
            x={projX1 - 12}
            y={Math.min(projYLo, projYHi) + 11}
            anchor="end"
            size={10}
            weight={900}
            fill={activeTargetLane === 'up' ? 'rgb(187 247 208)' : 'rgb(254 202 202)'}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          >
            proj {fmtPct(ptbTarget.next01)} ({fmtSignedPpFrom50(ptbTarget.next01)})
          </Txt>
        </>
      ) : null}

      <g filter="url(#ptbDualLineGlow)" className="pointer-events-none">
        {dnL.glow}
        {upL.glow}
      </g>
      {dnL.lines}
      {upL.lines}

      {trailDots('down', ptsD)}
      {trailDots('up', ptsU)}

      {arrows.map((a) => (
        <text
          key={a.key}
          x={a.x}
          y={a.y + 4}
          fill={a.fiery ? 'rgb(254 240 138)' : 'rgba(226,232,240,0.88)'}
          fontSize={a.fiery ? 13 : 11}
          fontWeight="900"
          textAnchor="middle"
          transform={`rotate(${a.deg}, ${a.x}, ${a.y})`}
          className="pointer-events-none"
          style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.4)', strokeWidth: 1.2 }}
        >
          {speedLabel === 'FAST' ? '→→' : speedLabel === 'MED' ? '→' : '›'}
        </text>
      ))}

      <Txt x={padL + 8} y={18} anchor="start" size={10} weight={600} fill="rgb(212 212 216)">
        {upLabel} vs {downLabel} · target {activeTargetLane === 'up' ? upLabel : downLabel}
      </Txt>
      <Txt
        x={padL + 8}
        y={32}
        anchor="start"
        size={8}
        weight={500}
        fill={lastUpdateMs == null ? 'rgb(161 161 170)' : dataStale ? 'rgb(251 191 36)' : 'rgb(74 222 128)'}
      >
        {feedStatus}
      </Txt>

      {/* Big, unmissable momentum callout (helps avoid “which side is ripping?” ambiguity). */}
      {activeRecent ? (
        <>
          <rect
            x={padL + plotW - 236}
            y={10}
            width={228}
            height={34}
            rx={12}
            fill={activeTargetLane === 'up' ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)'}
            stroke={activeTargetLane === 'up' ? 'rgba(52,211,153,0.28)' : 'rgba(251,113,133,0.28)'}
            strokeWidth={1.2}
            className="pointer-events-none"
          />
          <OverlayTxt
            x={padL + plotW - 18}
            y={28}
            anchor="end"
            size={10}
            weight={800}
            fill={activeTargetLane === 'up' ? 'rgb(187 247 208)' : 'rgb(254 202 202)'}
          >
            MOMENTUM → {activeRecent.heading}
          </OverlayTxt>
          <Txt
            x={padL + plotW - 18}
            y={40}
            anchor="end"
            size={8}
            weight={650}
            fill="rgba(228,228,231,0.78)"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          >
            jump {activeRecent.jumpPp >= 0 ? '+' : ''}
            {activeRecent.jumpPp.toFixed(1)}pp · tape {speedLabel}
          </Txt>
          {activeRecent.chasingRisk ? (
            <rect
              x={padL + plotW - 124}
              y={48}
              width={116}
              height={18}
              rx={8}
              fill="rgba(250,204,21,0.16)"
              stroke="rgba(250,204,21,0.28)"
              strokeWidth={1}
              className="pointer-events-none"
            />
          ) : null}
          {activeRecent.chasingRisk ? (
            <Txt x={padL + plotW - 18} y={61} anchor="end" size={8} weight={800} fill="rgb(254 240 138)">
              CHASE RISK — wait for hold
            </Txt>
          ) : null}
        </>
      ) : null}

      <circle
        cx={xT(lastDn.t)}
        cy={yRaw(lastDn.v)}
        r={activeTargetLane === 'down' ? 7.5 : 5.5}
        fill="white"
        stroke="rgb(251 113 133)"
        strokeWidth={activeTargetLane === 'down' ? 2.8 : 2}
        className={`cursor-pointer ${activeTargetLane === 'down' ? 'animate-pulse' : ''}`}
        onClick={() => onTapProb?.(lastD, { lane: 'down' })}
      />
      <OverlayTxt x={dnLabelX} y={dnLabelY} anchor={dnTa} size={9} weight={600} fill="rgb(254 202 202)">
        {downLabel} {fmtPct(lastD)}
      </OverlayTxt>

      {/* Large current value pill (DOWN lane) */}
      {isFiniteNumber(yRaw(lastDn.v)) ? (
        <>
          <rect
            x={padL + 10}
            y={yRaw(lastDn.v) - 10}
            width={152}
            height={20}
            rx={10}
            fill={activeTargetLane === 'down' ? 'rgba(244,63,94,0.18)' : 'rgba(24,24,27,0.75)'}
            stroke={activeTargetLane === 'down' ? 'rgba(251,113,133,0.32)' : 'rgba(255,255,255,0.07)'}
            strokeWidth={1.1}
            className="pointer-events-none"
          />
          <Txt
            x={padL + 22}
            y={yRaw(lastDn.v) + 4.5}
            anchor="start"
            size={11}
            weight={950}
            fill="rgb(254 202 202)"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          >
            {downLabel} now {fmtPct(lastD)} ({fmtSignedPpFrom50(lastD)})
          </Txt>
        </>
      ) : null}

      <circle
        cx={xT(lastUp.t)}
        cy={yRaw(lastUp.v)}
        r={activeTargetLane === 'up' ? 7.5 : 5.5}
        fill="white"
        stroke="rgb(52 211 153)"
        strokeWidth={activeTargetLane === 'up' ? 2.8 : 2}
        className={`cursor-pointer ${activeTargetLane === 'up' ? 'animate-pulse' : ''}`}
        onClick={() => onTapProb?.(lastU, { lane: 'up' })}
      />
      <OverlayTxt x={upLabelX} y={upLabelY} anchor={upTa} size={9} weight={600} fill="rgb(187 247 208)">
        {upLabel} {fmtPct(lastU)}
      </OverlayTxt>

      {/* Large current value pill (UP lane) */}
      {isFiniteNumber(yRaw(lastUp.v)) ? (
        <>
          <rect
            x={padL + 10}
            y={yRaw(lastUp.v) - 34}
            width={152}
            height={20}
            rx={10}
            fill={activeTargetLane === 'up' ? 'rgba(16,185,129,0.18)' : 'rgba(24,24,27,0.75)'}
            stroke={activeTargetLane === 'up' ? 'rgba(52,211,153,0.32)' : 'rgba(255,255,255,0.07)'}
            strokeWidth={1.1}
            className="pointer-events-none"
          />
          <Txt
            x={padL + 22}
            y={yRaw(lastUp.v) - 19.5}
            anchor="start"
            size={11}
            weight={950}
            fill="rgb(187 247 208)"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          >
            {upLabel} now {fmtPct(lastU)} ({fmtSignedPpFrom50(lastU)})
          </Txt>
        </>
      ) : null}

      {centTicksRight.map((tp) => (
        <Txt
          key={`rt-${tp}`}
          x={width - padR + 4}
          y={yRaw(tp) + 3.5}
          anchor="end"
          size={9}
          weight={Math.abs(tp - 0.5) < 1e-6 ? 800 : 600}
          fill={Math.abs(tp - 0.5) < 1e-6 ? 'rgb(250 204 21)' : 'rgb(161 161 170)'}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
        >
          {fmtPct(tp)}
        </Txt>
      ))}

      <Txt x={padL + plotW / 2} y={height - 7} anchor="middle" size={8} weight={500} fill="rgb(113 113 122)">
        {fmtChartWindowMin(tMin, tMax)} · {speedLabel}
      </Txt>

      {enterLine != null && tradeTrigger.line != null ? (
        <g>
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(enterLine)}
            y2={yRaw(enterLine)}
            stroke="rgba(250, 204, 21, 0.42)"
            strokeWidth={10}
            filter="url(#ptbDualEnterGlow)"
            className="pointer-events-none"
          />
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(enterLine)}
            y2={yRaw(enterLine)}
            stroke="rgba(253, 224, 71, 0.98)"
            strokeWidth={2.6}
            className="cursor-pointer"
            onClick={() => onTapProb?.(tradeTrigger.line!, { lane: tradeTrigger.lane })}
          />
          <OverlayTxt x={padL + 10} y={yEnterLbl} anchor="start" size={8} weight={600} fill="rgb(254 240 138)">
            Enter {tradeTrigger.lane === 'up' ? upLabel : downLabel} {fmtPct(tradeTrigger.line)}
          </OverlayTxt>
        </g>
      ) : null}

      {counterLine != null && counterEnter != null ? (
        <g>
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(counterLine)}
            y2={yRaw(counterLine)}
            stroke="rgba(148, 163, 184, 0.35)"
            strokeWidth={8}
            className="pointer-events-none"
          />
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(counterLine)}
            y2={yRaw(counterLine)}
            stroke="rgba(186, 230, 253, 0.75)"
            strokeWidth={1.8}
            strokeDasharray="6 5"
            className="cursor-pointer"
            onClick={() => onTapProb?.(counterEnter.line, { lane: counterEnter.lane })}
          />
          <OverlayTxt
            x={enterAltOverlap ? padL + plotW - 10 : padL + 12}
            y={yCounterLbl}
            anchor={enterAltOverlap ? 'end' : 'start'}
            size={8}
            weight={600}
            fill="rgb(186 230 253)"
          >
            Alt {counterEnter.lane === 'up' ? upLabel : downLabel} {fmtPct(counterEnter.line)}
          </OverlayTxt>
        </g>
      ) : null}

      {fadeLine != null && tradeTrigger.fadeLane != null ? (
        <g>
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(fadeLine)}
            y2={yRaw(fadeLine)}
            stroke="rgba(244, 63, 94, 0.55)"
            strokeWidth={2}
            strokeDasharray="7 6"
            className="pointer-events-none"
          />
          <OverlayTxt
            x={padL + plotW - 10}
            y={yRaw(fadeLine) + (enterFadeOverlap || counterFadeOverlap ? 22 : 14)}
            anchor="end"
            size={8}
            weight={600}
            fill="rgb(254 202 202)"
          >
            Fade {tradeTrigger.fadeLane === 'up' ? upLabel : downLabel} {fmtPct(fadeLine)}
          </OverlayTxt>
        </g>
      ) : null}
    </svg>
  );
}
