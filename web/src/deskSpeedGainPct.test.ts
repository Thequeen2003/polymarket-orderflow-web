import { describe, expect, it } from 'vitest';
import { computeDeskSpeedSnapshot } from './deskSpeedLayers';
import {
  computeContractEntryJump,
  entryJumpProjLineForTiming,
  probSpeedDetailWithGain,
  resolvePressureEntryJumpDisplay,
  spotSpeedDetailWithGain,
} from './deskSpeedGainPct';

describe('deskSpeedGainPct', () => {
  it('spot gain is % of current price', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_150 },
      ],
      nowSpot: 70_150,
      ptb: 70_100,
      probUpPts: [{ t: tEnd, v: 0.5 }],
      pMktUp: 0.5,
    });
    const spot = snap!.spot!;
    const g = spotSpeedDetailWithGain(spot, 70_150, 30);
    expect(g.gainPct).toMatch(/\+0\.21% \/ 30s/);
    expect(g.gainPct).toMatch(/%\/min/);
  });

  it('prob gain includes pp window and % vs mid', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [
        { t: tEnd - 30_000, v: 70_000 },
        { t: tEnd, v: 70_000 },
      ],
      nowSpot: 70_000,
      ptb: 70_000,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.4 },
        { t: tEnd, v: 0.52 },
      ],
      pMktUp: 0.52,
    });
    const prob = snap!.lanes.up.prob!;
    const g = probSpeedDetailWithGain(prob, 0.52, 30);
    expect(g.gainPct).toContain('pp / 30s');
    expect(g.gainPct).toContain('vs mid');
  });

  it('entry jump from window-open mid to now (e.g. 46¢ → 52¢)', () => {
    const tEnd = 100_000;
    const snap = computeDeskSpeedSnapshot({
      spotPts: [{ t: tEnd - 30_000, v: 70_000 }, { t: tEnd, v: 70_000 }],
      nowSpot: 70_000,
      ptb: 70_000,
      probUpPts: [
        { t: tEnd - 30_000, v: 0.46 },
        { t: tEnd, v: 0.52 },
      ],
      pMktUp: 0.52,
    });
    const jump = computeContractEntryJump({
      prob: snap!.lanes.up.prob,
      now01: 0.52,
      horizonSec: 30,
      outcomeLabel: 'Up',
    });
    expect(jump).not.toBeNull();
    expect(jump!.entry01).toBeCloseTo(0.46, 2);
    expect(jump!.now01).toBeCloseTo(0.52, 2);
    expect(jump!.gainCents).toBeCloseTo(6, 1);
    expect(jump!.headline).toMatch(/46.*→.*52.*now/);
    expect(jump!.headline).toContain('over 30s');
    expect(jump!.projLine).toMatch(/Now 52/);
  });

  it('suppresses bullish 1m projection when confirm timing is late', () => {
    const jump = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.05, velocityPerSec: 0.05 / 30, velocityPerMin: 0.1 },
      now01: 0.725,
      horizonSec: 30,
      outcomeLabel: 'Up',
    });
    expect(jump).not.toBeNull();
    const late = entryJumpProjLineForTiming(jump!, 'CHASING');
    expect(late).toMatch(/Too late/i);
    expect(late).not.toMatch(/more in 1m/i);
  });

  it('hides chop-level 30s confirm jumps (e.g. +1¢)', () => {
    const confirm = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.01, velocityPerSec: 0.01 / 30, velocityPerMin: 0.02 },
      now01: 0.485,
      horizonSec: 30,
      outcomeLabel: 'Down',
    });
    const lead = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.005, velocityPerSec: 0.005 / 10, velocityPerMin: 0.03 },
      now01: 0.485,
      horizonSec: 10,
      outcomeLabel: 'Down',
    });
    expect(confirm!.gainCents).toBeCloseTo(1, 1);
    const hidden = resolvePressureEntryJumpDisplay({
      timing: 'EARLY',
      timingNote: 'Building',
      entryJump: confirm,
      earlyEntryJump: lead,
      earlyHorizonSec: 10,
      confirmHorizonSec: 30,
    });
    expect(hidden).toBeNull();
  });

  it('shows late confirm jump and 10s lead hint when chasing', () => {
    const confirm = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.05, velocityPerSec: 0.05 / 30, velocityPerMin: 0.1 },
      now01: 0.725,
      horizonSec: 30,
      outcomeLabel: 'Up',
    });
    const lead = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.03, velocityPerSec: 0.03 / 10, velocityPerMin: 0.18 },
      now01: 0.725,
      horizonSec: 10,
      outcomeLabel: 'Up',
    });
    const shown = resolvePressureEntryJumpDisplay({
      timing: 'CHASING',
      timingNote: 'Move already in — do not chase.',
      entryJump: confirm,
      earlyEntryJump: lead,
      earlyHorizonSec: 10,
      confirmHorizonSec: 30,
    });
    expect(shown).not.toBeNull();
    expect(shown!.title).toMatch(/Too late/i);
    expect(shown!.jump.horizonSec).toBe(30);
  });

  it('prefers 10s lead over 30s confirm when move is meaningful', () => {
    const confirm = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.02, velocityPerSec: 0.02 / 30, velocityPerMin: 0.04 },
      now01: 0.48,
      horizonSec: 30,
      outcomeLabel: 'Down',
    });
    const lead = computeContractEntryJump({
      prob: { direction: 'UP', delta30: 0.03, velocityPerSec: 0.03 / 10, velocityPerMin: 0.18 },
      now01: 0.48,
      horizonSec: 10,
      outcomeLabel: 'Down',
    });
    const shown = resolvePressureEntryJumpDisplay({
      timing: 'EARLY',
      timingNote: 'Fresh',
      entryJump: confirm,
      earlyEntryJump: lead,
      earlyHorizonSec: 10,
      confirmHorizonSec: 30,
    });
    expect(shown).not.toBeNull();
    expect(shown!.title).toMatch(/10s lead/i);
    expect(shown!.jump.horizonSec).toBe(10);
  });
});
