/**
 * Causal trade signals — not “what lane” but *why* the lines move and what that implies.
 *
 *   GENERATOR — what is creating pressure (spot slope, sections, walls, tape, thrust)
 *   RISE      — how that pushes spot vs PTB and/or reprices the outcome token
 *   EFFECT    — consequences if it continues (settlement, flip, brackets, fade)
 *   SIGNAL    — trade from the chain (flow-led, not PTB geometry alone)
 */

import type { DualOutcomeWallFlow } from './dualOutcomeWalls';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { SwitchForecast } from './sectionalMomentum';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TradeLevels } from './tradeLevels';
import { fmtUsdPhysics, spotGeometricWinner } from './entryPhysicsBrief';

export type CausalBlockId = 'generator' | 'rise' | 'effect' | 'signal' | 'warn';

export type CausalBlock = {
  id: CausalBlockId;
  text: string;
};

export type TradeCausalInput = {
  spot: number | null;
  ptb: number | null;
  bandUsd: number;
  entryLane: 'up' | 'down' | null;
  upLabel: string;
  downLabel: string;
  lastProbUp: number | null;
  lastProbDown: number | null;
  machine: SpotPtbMachineReadout | null;
  switchForecast: SwitchForecast | null;
  bandGauge: SpotBandGaugeSnapshot | null;
  wallFlow: DualOutcomeWallFlow | null;
  endsInMs?: number | null;
  crossProb?: number | null;
  levels?: TradeLevels | null;
};

const MAX = 200;
const MAX_JOIN = 300;

function clip(s: string, max = MAX): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function laneName(lane: 'up' | 'down', up: string, down: string): string {
  return lane === 'up' ? up : down;
}

type Driver = { lane: 'up' | 'down'; w: number; text: string };

function collectGenerators(input: TradeCausalInput): Driver[] {
  const { machine, switchForecast, bandGauge, wallFlow, upLabel, downLabel } = input;
  const out: Driver[] = [];
  const push = (lane: 'up' | 'down' | null | undefined, w: number, text: string) => {
    if (!lane || w <= 0) return;
    out.push({ lane, w, text });
  };

  const s = machine?.sensors;
  if (s?.microSlope === 'up') push('up', 2.2, `Micro-slope pushing spot up ($/sec tick trend)`);
  if (s?.microSlope === 'down') push('down', 2.2, `Micro-slope pushing spot down`);
  if (s?.sectionalDrift === 'up') push('up', 2.5, `Section windows net higher — drift lane ${upLabel}`);
  if (s?.sectionalDrift === 'down') push('down', 2.5, `Section windows net lower — drift lane ${downLabel}`);
  if (bandGauge?.slopeUsdPerMin != null && Number.isFinite(bandGauge.slopeUsdPerMin)) {
    const sl = bandGauge.slopeUsdPerMin;
    if (sl > 0.05) push('up', 2.8, `Spot line slope +${sl.toFixed(1)} $/min vs PTB band`);
    if (sl < -0.05) push('down', 2.8, `Spot line slope ${sl.toFixed(1)} $/min vs PTB band`);
  }
  if (machine?.acceleration?.state === 'accel-up') {
    push('up', 3, `Thrust ${Math.round(machine.acceleration.thrust)} — late tape accelerating up`);
  }
  if (machine?.acceleration?.state === 'accel-down') {
    push('down', 3, `Thrust ${Math.round(machine.acceleration.thrust)} — late tape accelerating down`);
  }
  if (machine?.acceleration?.state === 'reversing') {
    push(machine.acceleration.direction === 'up' ? 'up' : 'down', 1.5, 'Slope reversing — prior push fading');
  }
  if (wallFlow?.flowLane) {
    const w = wallFlow.pressure >= 0.7 ? 4 : wallFlow.pressure >= 0.4 ? 3 : 2;
    push(
      wallFlow.flowLane,
      w,
      wallFlow.headline?.trim() || `Wall ask on ${laneName(wallFlow.flowLane, upLabel, downLabel)} — book pulling that token`,
    );
  } else if (s?.bookControl) {
    push(s.bookControl, 2, `Book control on ${laneName(s.bookControl, upLabel, downLabel)}`);
  }
  if (s?.tapeReliable && s.tapeDominance === 'buy' && machine?.flowWinningLane) {
    push(machine.flowWinningLane, 2.2, `Desk tape buy pressure on ${laneName(machine.flowWinningLane, upLabel, downLabel)} prints`);
  }
  if (s?.tapeReliable && s.tapeDominance === 'sell' && machine?.flowWinningLane) {
    push(machine.flowWinningLane, 2.2, `Desk tape sell pressure — liquidity leaving ${laneName(machine.flowWinningLane, upLabel, downLabel)}`);
  }
  if (s?.impliedLeader) {
    push(s.impliedLeader, 1.8, `Implied mid leader ${laneName(s.impliedLeader, upLabel, downLabel)} — probability line tilted`);
  }
  if (machine?.mtf?.dominantLane && machine.mtf.alignedCount >= 2) {
    push(
      machine.mtf.dominantLane,
      machine.mtf.fullAgreement ? 2.5 : 1.5,
      `MTF ${machine.mtf.alignedCount}/${machine.mtf.totalActionable} windows ${laneName(machine.mtf.dominantLane, upLabel, downLabel)}`,
    );
  }
  if (switchForecast?.driftLane && switchForecast.status !== 'WAIT') {
    push(
      switchForecast.driftLane,
      1.5,
      `Chart sections drifting ${laneName(switchForecast.driftLane, upLabel, downLabel)} (${switchForecast.status})`,
    );
  }
  if (switchForecast?.status === 'SWITCH_INCOMING' && switchForecast.incomingLane) {
    push(
      switchForecast.incomingLane,
      3.5,
      `Switch incoming → ${laneName(switchForecast.incomingLane, upLabel, downLabel)} taking sponsorship`,
    );
  }

  out.sort((a, b) => b.w - a.w);
  return out;
}

function dominantLane(drivers: Driver[]): 'up' | 'down' | null {
  let u = 0;
  let d = 0;
  for (const x of drivers) {
    if (x.lane === 'up') u += x.w;
    else d += x.w;
  }
  if (u < 1.5 && d < 1.5) return null;
  return u >= d ? 'up' : 'down';
}

function buildRiseLine(input: TradeCausalInput, drivers: Driver[], pushLane: 'up' | 'down' | null): string | null {
  const { spot, ptb, bandUsd, upLabel, downLabel, machine, bandGauge } = input;
  if (!pushLane) return null;
  const name = laneName(pushLane, upLabel, downLabel);
  const parts: string[] = [];

  if (spot != null && ptb != null && Number.isFinite(spot) && Number.isFinite(ptb)) {
    const geo = spotGeometricWinner(spot, ptb, bandUsd);
    const d = spot - ptb;
    if (pushLane === 'up' && geo === 'up') {
      parts.push(
        `Spot line rising above PTB (${fmtUsdPhysics(d)} gap) — yellow PTB line is being left behind → ${upLabel} geometry strengthens`,
      );
    } else if (pushLane === 'down' && geo === 'down') {
      parts.push(
        `Spot line falling below PTB (${fmtUsdPhysics(Math.abs(d))} gap) → ${downLabel} geometry strengthens`,
      );
    } else if (geo === 'at') {
      parts.push(`Spot hugging PTB band — breakout ${name} if generators win the next push`);
    } else {
      parts.push(
        `Generators favor ${name} but spot still ${geo === 'up' ? 'above' : 'below'} PTB — token can reprice before spot catches up`,
      );
    }
  }

  const top = drivers.filter((x) => x.lane === pushLane).slice(0, 2);
  if (top.length) {
    parts.push(`Because: ${top.map((t) => t.text).join('; ')}`);
  }

  if (bandGauge?.proj30s != null && Number.isFinite(bandGauge.proj30s) && spot != null) {
    const proj = bandGauge.proj30s;
    const delta = proj - spot;
    if (Math.abs(delta) >= 0.5) {
      parts.push(
        `30s projection ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} $ on spot → line ${delta >= 0 ? 'continues up' : 'continues down'} if slope holds`,
      );
    }
  }

  const accel = machine?.acceleration;
  if (accel && (accel.state === 'accel-up' || accel.state === 'accel-down')) {
    parts.push(`${name} token line tends to follow — buyers lift ask when spot thrust confirms`);
  }

  return parts.length ? clip(parts.join(' · ')) : null;
}

function buildEffects(input: TradeCausalInput, pushLane: 'up' | 'down' | null): string[] {
  const { entryLane, upLabel, downLabel, crossProb, endsInMs, levels, machine } = input;
  const effects: string[] = [];
  const lane = entryLane ?? pushLane;
  if (!lane) return effects;

  const name = laneName(lane, upLabel, downLabel);
  effects.push(
    `If ${name} keeps sponsorship through the bell → settlement pays $1/share on ${name} when spot finishes ${lane === 'up' ? 'above' : 'below'} PTB`,
  );

  if (crossProb != null && Number.isFinite(crossProb)) {
    const pct = Math.round(crossProb * 100);
    if (pct >= 65) {
      effects.push(`Effect: ~${pct}% PTB cross before bell — geometry can flip; brackets tighten`);
    } else if (pct <= 20) {
      effects.push(`Effect: ~${pct}% PTB cross — current side of PTB likely holds into settlement`);
    }
  }

  if (machine?.overextension?.state === 'overextended' || machine?.overextension?.state === 'stretched') {
    effects.push(
      `Effect: move ×${machine.overextension.ratio.toFixed(1)} stretched — mean-reversion can snap the line back (fade risk)`,
    );
  }

  if (endsInMs != null && endsInMs <= 60_000) {
    effects.push('Effect: <60s to bell — new risk is exit liquidity, not fresh entry edge');
  }

  if (levels && levels.lane === lane) {
    const tp = (levels.takeProfit * 100).toFixed(1);
    const sl = (levels.stopLoss * 100).toFixed(1);
    effects.push(`Effect on book: ${name} bid → TP ${tp}¢ / SL ${sl}¢ on that token (not spot USD)`);
  }

  if (machine?.flowWinningLane && machine.sensors.spotVsPtb && machine.sensors.spotVsPtb !== 'at') {
    if (machine.flowWinningLane !== machine.sensors.spotVsPtb) {
      effects.push(
        `Split effect: flow won ${laneName(machine.flowWinningLane, upLabel, downLabel)} while spot geometry still ${machine.sensors.spotVsPtb} — trade flow, not PTB alone`,
      );
    }
  }

  return effects.slice(0, 4);
}

function buildSignalFromChain(
  input: TradeCausalInput,
  pushLane: 'up' | 'down' | null,
  drivers: Driver[],
): string | null {
  const { entryLane, upLabel, downLabel, machine } = input;
  const lane = entryLane ?? machine?.focusLane ?? pushLane;
  if (!lane) {
    if (drivers.length >= 2) {
      const u = drivers.filter((d) => d.lane === 'up').length;
      const d = drivers.filter((d) => d.lane === 'down').length;
      return clip(`Generators split (${u} up-drivers vs ${d} down-drivers) — wait for one line to take the chart`);
    }
    return null;
  }

  const name = laneName(lane, upLabel, downLabel);
  const flow = machine?.flowWinningLane;
  const geo = input.spot != null && input.ptb != null ? spotGeometricWinner(input.spot, input.ptb, input.bandUsd) : null;

  if (flow && flow !== geo && geo !== 'at' && geo !== null) {
    return clip(
      `Signal: buy ${laneName(flow, upLabel, downLabel)} — book/flow is generating the move; spot line still ${geo === 'up' ? 'above' : 'below'} PTB is lagging`,
    );
  }

  const top = drivers.filter((d) => d.lane === lane).slice(0, 1)[0];
  const because = top ? top.text : 'sensor consensus';
  if (lane === pushLane) {
    return clip(`Signal: ${name} — ${because} → line and settlement align; enter on ${name} token at card levels`);
  }
  return clip(`Signal: card ${name} — lead driver is ${because}; confirm line follows before size`);
}

/** Structured causal blocks for UI. */
export function buildTradeCausalBlocks(input: TradeCausalInput): CausalBlock[] {
  const drivers = collectGenerators(input);
  const pushLane = machineDominantPush(input, drivers);
  const blocks: CausalBlock[] = [];

  const gens = drivers.slice(0, 3);
  for (const g of gens) {
    blocks.push({
      id: 'generator',
      text: clip(`${laneName(g.lane, input.upLabel, input.downLabel)}: ${g.text}`),
    });
  }

  const rise = buildRiseLine(input, drivers, pushLane);
  if (rise) blocks.push({ id: 'rise', text: rise });

  for (const e of buildEffects(input, pushLane)) {
    blocks.push({ id: 'effect', text: clip(e) });
  }

  const sig = buildSignalFromChain(input, pushLane, drivers);
  if (sig) blocks.push({ id: 'signal', text: sig });

  if (input.machine?.probVsSpot === 'conflict') {
    blocks.push({
      id: 'warn',
      text: clip('Conflict: implied line and spot line disagree — wait for one generator to win'),
    });
  }

  return blocks.slice(0, 8);
}

function machineDominantPush(input: TradeCausalInput, drivers: Driver[]): 'up' | 'down' | null {
  const flow = input.machine?.flowWinningLane;
  if (flow) return flow;
  return dominantLane(drivers);
}

/** One paragraph for Do this now / physics strip. */
export function buildTradeCausalBrief(input: TradeCausalInput): string | null {
  const blocks = buildTradeCausalBlocks(input);
  if (!blocks.length) return null;
  const order: CausalBlockId[] = ['generator', 'rise', 'effect', 'signal', 'warn'];
  const texts: string[] = [];
  for (const id of order) {
    for (const b of blocks) {
      if (b.id === id) texts.push(b.text);
    }
  }
  return clip(texts.join(' · ') + '.', MAX_JOIN);
}

/** Short causal headline for sensor strip (generator → effect). */
export function buildTradeCausalHeadline(input: TradeCausalInput): string | null {
  const drivers = collectGenerators(input);
  const push = machineDominantPush(input, drivers);
  const sig = buildSignalFromChain(input, push, drivers);
  if (sig) return sig;
  const rise = buildRiseLine(input, drivers, push);
  if (rise) return rise;
  if (drivers[0]) return clip(`Driver: ${drivers[0].text}`);
  return null;
}
