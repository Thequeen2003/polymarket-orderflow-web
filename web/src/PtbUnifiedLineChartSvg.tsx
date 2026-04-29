import type { ReactElement } from 'react';
import type { PtbSystemDecision } from './ptbDecisionEngine';
import type { PtbTargetEngineCard } from './ptbTargetEngine';
import { downsampleLinePoints, segmentMomentumStyle, type PtbLinePoint } from './ptbLineChart';

type GapBlock = {
  a: number;
  b: number;
  strength10: number;
  lo: number;
  hi: number;
  active: boolean;
  exitWall: number | null;
};

export type PtbUnifiedLineChartSvgProps = {
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
  /** Which outcome the chart is anchored on (leading leg). */
  chartLane: 'up' | 'down';
  winningLabel: string;
  otherLabel: string;
  scaleMin: number;
  scaleMax: number;
  lineSeries: PtbLinePoint[];
  lastV: number;
  gap: GapBlock | null;
  vac: number[];
  vacHi: number;
  pathActive: boolean;
  engine: PtbSystemDecision;
  ptbTarget: PtbTargetEngineCard;
  /** Show target projection + target band (enable only on active lane). */
  showTarget?: boolean;
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
  onTapProb?: (p: number, ctx?: { lane: 'up' | 'down' }) => void;
  emitGap: (side: 'up' | 'down', g: GapBlock | null, entryNow: number) => void;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Map a probability expressed on `lane` into the chart’s anchored lane. */
function probOnChart(lane: 'up' | 'down', p: number, chartLane: 'up' | 'down'): number {
  return lane === chartLane ? clamp01(p) : clamp01(1 - p);
}

const GAP_Q = 0.38;
const BIN_N = 28;

export function PtbUnifiedLineChartSvg(p: PtbUnifiedLineChartSvgProps): ReactElement {
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
    chartLane,
    winningLabel,
    otherLabel,
    lineSeries,
    lastV,
    gap,
    vac,
    vacHi,
    pathActive,
    engine,
    ptbTarget,
    showTarget = true,
    speedLabel,
    speedScore01,
    tradeTrigger,
    counterEnter,
    upLabel,
    downLabel,
    priceToBeatUsd,
    fmtPct,
    fmtChartWindowMin,
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
  /** True probability → y (no vertical stretch): line matches PTB ticks. */
  const yLine = yRaw;

  const lastSample =
    lineSeries.length > 0 ? lineSeries[lineSeries.length - 1]! : ({ t: tMax, v: lastV } satisfies PtbLinePoint);

  const source: PtbLinePoint[] =
    lineSeries.length > 0 ? lineSeries : [
      { t: tMin, v: lastV },
      { t: tMax, v: lastV },
    ];
  /** Raw downsample only (no smoothing): stays reactive to each leg of the move. */
  let pts = downsampleLinePoints(source, 720);
  if (lineSeries.length > 0 && pts.length >= 1) {
    pts = pts.length === 1 ? [lastSample] : [...pts.slice(0, -1), lastSample];
  }

  const arrowStride = speedLabel === 'FAST' ? 1 : speedLabel === 'MED' ? 2 : 4;
  const arrowStart = Math.max(1, Math.floor(pts.length * 0.45));
  const arrows: { x: number; y: number; deg: number; key: string; fiery: boolean }[] = [];
  for (let i = arrowStart; i < pts.length - 1; i += arrowStride) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const x1 = xT(a.t);
    const y1 = yLine(a.v);
    const x2 = xT(b.t);
    const y2 = yLine(b.v);
    const deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const xm = (x1 + x2) / 2;
    const ym = (y1 + y2) / 2;
    arrows.push({
      x: xm,
      y: ym,
      deg,
      key: `a-${i}-${b.t}`,
      fiery: speedLabel === 'FAST',
    });
  }

  const enterLine =
    tradeTrigger.line != null ? probOnChart(tradeTrigger.lane, tradeTrigger.line, chartLane) : null;
  const counterLine =
    counterEnter != null ? probOnChart(counterEnter.lane, counterEnter.line, chartLane) : null;
  const fadeLine =
    tradeTrigger.fadeWall != null && tradeTrigger.fadeLane != null
      ? probOnChart(tradeTrigger.fadeLane, tradeTrigger.fadeWall, chartLane)
      : null;

  const projX0 = xT(lastSample.t);
  const projY0 = yLine(lastSample.v);
  const projX1 = padL + plotW * 0.93;
  const projY1 = yLine(probOnChart(ptbTarget.engineLane, ptbTarget.next01, chartLane));
  const projYLo = yLine(probOnChart(ptbTarget.engineLane, ptbTarget.lo01, chartLane));
  const projYHi = yLine(probOnChart(ptbTarget.engineLane, ptbTarget.hi01, chartLane));
  const primaryLanePanel = tradeTrigger.lane === chartLane;
  const laneRoleLabel = primaryLanePanel ? 'PRIMARY PANEL' : 'ALT PANEL';
  const laneRoleTone = primaryLanePanel
    ? chartLane === 'up'
      ? 'rgba(16,185,129,0.95)'
      : 'rgba(251,113,133,0.95)'
    : 'rgba(161,161,170,0.9)';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block h-auto min-h-0 w-full max-w-full max-h-[min(420px,52vh)] rounded-lg bg-[#070709] md:max-h-[min(480px,55vh)]"
      style={{ aspectRatio: `${width} / ${height}` }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <filter id="ptbLineGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="ptbEnterLineGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="pathUpProb" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgb(52 211 153)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(52 211 153)" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="pathDnProb" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      <rect
        x={padL}
        y={topY0}
        width={plotW}
        height={plotH}
        rx={16}
        fill={chartLane === 'up' ? 'rgb(8 12 11)' : 'rgb(12 8 10)'}
        stroke="rgba(63,63,70,0.8)"
        strokeWidth={1.25}
      />

      {/* Money zones (true probability scale) */}
      <rect x={padL} y={yRaw(1)} width={plotW} height={Math.max(1, yRaw(0.9) - yRaw(1))} fill="rgba(239,68,68,0.11)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.9)} width={plotW} height={Math.max(1, yRaw(0.8) - yRaw(0.9))} fill="rgba(234,179,8,0.1)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.8)} width={plotW} height={Math.max(1, yRaw(0.6) - yRaw(0.8))} fill="rgba(34,197,94,0.08)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.4)} width={plotW} height={Math.max(1, yRaw(0.2) - yRaw(0.4))} fill="rgba(34,197,94,0.06)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.2)} width={plotW} height={Math.max(1, yRaw(0.1) - yRaw(0.2))} fill="rgba(234,179,8,0.09)" className="pointer-events-none" />
      <rect x={padL} y={yRaw(0.1)} width={plotW} height={Math.max(1, yRaw(0) - yRaw(0.1))} fill="rgba(239,68,68,0.1)" className="pointer-events-none" />

      <text x={padL + plotW - 8} y={topY0 + 14} textAnchor="end" fill="rgba(248,113,113,0.85)" fontSize="9" fontWeight="800" className="pointer-events-none">
        90–100¢ late
      </text>
      <text x={padL + plotW - 8} y={topY0 + 28} textAnchor="end" fill="rgba(250,204,21,0.8)" fontSize="9" fontWeight="700" className="pointer-events-none">
        80–90¢ careful
      </text>
      <text x={padL + plotW - 8} y={yRaw(0.7) + 4} textAnchor="end" fill="rgba(52,211,153,0.75)" fontSize="9" fontWeight="700" className="pointer-events-none">
        60–80¢ green zone
      </text>

      {[0, 0.2, 0.4, 0.6, 0.8, 1].map((frac) => (
        <line
          key={`vg-${frac}`}
          x1={padL + frac * plotW}
          x2={padL + frac * plotW}
          y1={topY0}
          y2={topY0 + plotH}
          stroke="rgba(255,255,255,0.04)"
          strokeWidth={1}
          className="pointer-events-none"
        />
      ))}

      {[0.2, 0.4, 0.6, 0.8].map((tp) => (
        <line
          key={`gh-${tp}`}
          x1={padL}
          x2={padL + plotW}
          y1={yRaw(tp)}
          y2={yRaw(tp)}
          stroke="rgba(161, 161, 170, 0.1)"
          strokeWidth={1}
          strokeDasharray="3 6"
          className="pointer-events-none"
        />
      ))}

      <line
        x1={padL}
        x2={padL + plotW}
        y1={y50}
        y2={y50}
        stroke="rgba(250, 204, 21, 0.35)"
        strokeWidth={14}
        className="pointer-events-none"
      />
      <line
        x1={padL}
        x2={padL + plotW}
        y1={y50}
        y2={y50}
        stroke="rgb(250 204 21)"
        strokeWidth={3.2}
        className="pointer-events-none"
      />
      <text x={padL + 10} y={y50 - 8} fill="rgb(250 204 21)" fontSize="11" fontWeight="900" className="pointer-events-none">
        50¢ PTB ANCHOR
      </text>
      <text x={padL + 10} y={y50 + 16} fill="rgb(161 161 170)" fontSize="9" fontFamily="ui-monospace, monospace" className="pointer-events-none">
        Anchor: {winningLabel} · {otherLabel} ≈ complement · SSR PTB{' '}
        {priceToBeatUsd != null ? `$${priceToBeatUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
      </text>
      <text
        x={padL + 10}
        y={y50 + 30}
        fill={laneRoleTone}
        fontSize="9"
        fontWeight="800"
        fontFamily="ui-monospace, monospace"
        className="pointer-events-none"
      >
        {laneRoleLabel} · {tradeTrigger.lane === 'up' ? upLabel : downLabel} · {engine.verdict}
      </text>

      {vac.map((v, i) => {
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
          y={Math.min(y50, yRaw(lastV))}
          width={plotW}
          height={Math.max(4, Math.abs(yRaw(lastV) - y50))}
          fill={chartLane === 'up' ? 'url(#pathUpProb)' : 'url(#pathDnProb)'}
          className="pointer-events-none"
        />
      ) : null}

      {gap ? (
        <rect
          x={padL}
          y={yRaw(gap.hi)}
          width={plotW}
          height={Math.max(6, Math.abs(yRaw(gap.lo) - yRaw(gap.hi)))}
          fill={
            gap.active
              ? chartLane === 'up'
                ? 'rgba(34,197,94,0.26)'
                : 'rgba(244,63,94,0.24)'
              : chartLane === 'up'
                ? 'rgba(34,197,94,0.16)'
                : 'rgba(244,63,94,0.14)'
          }
          stroke={chartLane === 'up' ? 'rgba(34,197,94,0.85)' : 'rgba(244,63,94,0.85)'}
          strokeWidth={1.4}
          className={`${gap.active ? 'animate-pulse' : ''} cursor-pointer`}
          rx={10}
          onClick={() => {
            emitGap(chartLane, gap, lastV);
            onTapProb?.(gap.hi, { lane: chartLane });
          }}
        />
      ) : null}
      {gap ? (
        <text
          x={padL + 14}
          y={yRaw((gap.lo + gap.hi) / 2)}
          fill={chartLane === 'up' ? 'rgba(16,185,129,0.95)' : 'rgba(251,113,133,0.95)'}
          fontSize="11"
          fontWeight="900"
          className="pointer-events-none"
        >
          VACUUM · {winningLabel} · {gap.active ? 'ACTIVE' : 'INACTIVE'}
        </text>
      ) : null}

      {gap && engine.highlightGap === chartLane ? (
        <rect
          x={padL}
          y={yRaw(gap.hi)}
          width={plotW}
          height={Math.max(6, Math.abs(yRaw(gap.lo) - yRaw(gap.hi)))}
          fill="none"
          stroke="rgba(34,211,238,0.95)"
          strokeWidth={3}
          rx={10}
          className="animate-pulse pointer-events-none"
        />
      ) : null}

      {gap?.exitWall != null ? (
        <>
          {engine.highlightWallProb != null && Math.abs(engine.highlightWallProb - gap.exitWall) < 1e-9 ? (
            <line
              x1={padL}
              x2={padL + plotW}
              y1={yRaw(gap.exitWall)}
              y2={yRaw(gap.exitWall)}
              stroke="rgba(250,204,21,0.35)"
              strokeWidth={14}
              className="pointer-events-none"
            />
          ) : null}
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(gap.exitWall)}
            y2={yRaw(gap.exitWall)}
            stroke="rgba(251,191,36,0.95)"
            strokeWidth={2}
            strokeDasharray="6 5"
            className="cursor-pointer"
            onClick={() => onTapProb?.(gap.exitWall!, { lane: chartLane })}
          />
          <text
            x={padL + plotW - 10}
            y={yRaw(gap.exitWall) - 6}
            fill="rgba(251,191,36,0.95)"
            fontSize="10"
            fontWeight="800"
            textAnchor="end"
            className="pointer-events-none"
          >
            WALL / EXIT
          </text>
        </>
      ) : null}

      {/* Projection to PTB target (mapped onto anchored leg) */}
      {showTarget ? (
        <>
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
            stroke="rgba(52, 211, 153, 0.35)"
            strokeWidth={10}
            className="pointer-events-none"
          />
          <text
            x={projX1 - 6}
            y={Math.min(projYLo, projYHi) - 6}
            textAnchor="end"
            fill="rgba(226,232,240,0.85)"
            fontSize="9"
            fontWeight="800"
            className="pointer-events-none"
          >
            TARGET {ptbTarget.targetRangeLabel}
          </text>
        </>
      ) : null}

      {/* Glow under PTB line */}
      <g filter="url(#ptbLineGlow)" className="pointer-events-none">
        {pts.slice(1).map((b, i) => {
          const a = pts[i]!;
          const vPrev = i > 0 ? pts[i - 1]!.v : null;
          const st = segmentMomentumStyle(vPrev, a.v, b.v, a.t, b.t, speedScore01);
          return (
            <line
              key={`glow-${b.t}-${i}`}
              x1={xT(a.t)}
              y1={yLine(a.v)}
              x2={xT(b.t)}
              y2={yLine(b.v)}
              stroke={st.stroke}
              strokeWidth={st.strokeWidth + 5}
              strokeLinecap="round"
              opacity={0.22}
            />
          );
        })}
      </g>

      {pts.slice(1).map((b, i) => {
        const a = pts[i]!;
        const vPrev = i > 0 ? pts[i - 1]!.v : null;
        const st = segmentMomentumStyle(vPrev, a.v, b.v, a.t, b.t, speedScore01);
        return (
          <line
            key={`ln-${b.t}-${i}`}
            x1={xT(a.t)}
            y1={yLine(a.v)}
            x2={xT(b.t)}
            y2={yLine(b.v)}
            stroke={st.stroke}
            strokeWidth={st.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}

      {arrows.map((a) => (
        <text
          key={a.key}
          x={a.x}
          y={a.y + 4}
          fill={a.fiery ? 'rgb(254 240 138)' : 'rgba(226,232,240,0.92)'}
          fontSize={a.fiery ? 13 : 11}
          fontWeight="900"
          textAnchor="middle"
          transform={`rotate(${a.deg}, ${a.x}, ${a.y})`}
          className="pointer-events-none"
          style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.65)', strokeWidth: 2 }}
        >
          {speedLabel === 'FAST' ? '→→' : speedLabel === 'MED' ? '→' : '›'}
        </text>
      ))}

      <text x={padL + 10} y={topY0 + 16} fill="rgb(226 232 240)" fontSize="12" fontWeight="800">
        PTB LINE (live) · {winningLabel}
      </text>
      <text x={padL + 10} y={topY0 + 32} fill="rgb(161 161 170)" fontSize="9" fontWeight="600">
        Chart anchored on {winningLabel} · {otherLabel} is the other side · line tracks live PTB (no smoothing)
      </text>

      <circle
        cx={xT(lastSample.t)}
        cy={yLine(lastSample.v)}
        r={8}
        fill="white"
        stroke={chartLane === 'up' ? 'rgb(52 211 153)' : 'rgb(56 189 248)'}
        strokeWidth={2.8}
        className="cursor-pointer animate-pulse"
        onClick={() => onTapProb?.(lastV, { lane: chartLane })}
      />

      {/* Right rail: fixed cents when in range (10/20/30/40/50/70/80/90). */}
      {[0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.8, 0.9]
        .filter((tp) => tp >= scaleMin - 1e-9 && tp <= scaleMax + 1e-9)
        .map((tp) => (
          <text
            key={`rt-${tp}`}
            x={width - padR + 4}
            y={yRaw(tp) + 4}
            fill={Math.abs(tp - 0.5) < 1e-9 ? 'rgb(250 204 21)' : 'rgb(113 113 122)'}
            fontSize="9"
            fontWeight={Math.abs(tp - 0.5) < 1e-9 ? 800 : 600}
            fontFamily="ui-monospace, monospace"
            className="pointer-events-none"
          >
            {fmtPct(tp)}
          </text>
        ))}

      <text x={padL + plotW / 2} y={height - 6} textAnchor="middle" fill="rgb(113 113 122)" fontSize="9" fontFamily="ui-monospace, monospace">
        {fmtChartWindowMin(tMin, tMax)} · line = {winningLabel} · green / yellow / red = segment momentum · {speedLabel} tape
      </text>

      {enterLine != null && tradeTrigger.line != null ? (
        <g>
          <line
            x1={padL}
            x2={padL + plotW}
            y1={yRaw(enterLine)}
            y2={yRaw(enterLine)}
            stroke="rgba(250, 204, 21, 0.42)"
            strokeWidth={10}
            filter="url(#ptbEnterLineGlow)"
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
          <text
            x={padL + 12}
            y={yRaw(enterLine) - 6}
            fill="rgb(254 240 138)"
            fontSize="11"
            fontWeight="900"
            textAnchor="start"
            className="pointer-events-none"
            style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 3 }}
          >
            ENTER LINE · {tradeTrigger.lane === 'up' ? upLabel : downLabel}
          </text>
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
          <text
            x={padL + 12}
            y={yRaw(counterLine) + 14}
            fill="rgb(186 230 253)"
            fontSize="9"
            fontWeight="800"
            textAnchor="start"
            className="pointer-events-none"
            style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 2.5 }}
          >
            ALT · {counterEnter.lane === 'up' ? upLabel : downLabel}
          </text>
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
          <text
            x={padL + plotW - 10}
            y={yRaw(fadeLine) + 14}
            fill="rgba(251, 113, 133, 0.95)"
            fontSize="9"
            fontWeight="800"
            textAnchor="end"
            className="pointer-events-none"
          >
            WALL · FADE
          </text>
        </g>
      ) : null}
    </svg>
  );
}
