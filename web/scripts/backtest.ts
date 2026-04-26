import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBacktestPaperBothLanes } from '../src/backtest/backtestRunner';
import type { BacktestDatasetV1 } from '../src/backtest/types';
import type { StrategyParams } from '../src/backtest/strategy';

function parseJsonFile(path: string): unknown {
  const abs = resolve(process.cwd(), path);
  const text = readFileSync(abs, 'utf8');
  return JSON.parse(text) as unknown;
}

function asDatasetV1(x: unknown): BacktestDatasetV1 {
  if (!x || typeof x !== 'object') throw new Error('dataset: not an object');
  const o = x as Record<string, unknown>;
  if (o.v !== 1) throw new Error('dataset: expected v=1');
  if (typeof o.slug !== 'string' || !o.slug.trim()) throw new Error('dataset: missing slug');
  if (typeof o.upTokenId !== 'string' || !o.upTokenId.trim()) throw new Error('dataset: missing upTokenId');
  if (typeof o.downTokenId !== 'string' || !o.downTokenId.trim()) throw new Error('dataset: missing downTokenId');
  if (!Array.isArray(o.points)) throw new Error('dataset: missing points[]');
  return o as BacktestDatasetV1;
}

function getArg(flag: string): string | null {
  const i = process.argv.findIndex((a) => a === flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function num(flag: string, fallback: number): number {
  const v = getArg(flag);
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

const file = getArg('--file') ?? getArg('-f');
if (!file) {
  console.error('Usage: npm run backtest -- --file path/to/dataset.json [--minDistUsd 8] [--minSlopeUsdPerMin 4] [--tp01 0.03] [--sl01 0.02] [--clip 40]');
  process.exit(2);
}

const data = asDatasetV1(parseJsonFile(file));

const params: StrategyParams = {
  minDistUsd: num('--minDistUsd', 8),
  minSlopeUsdPerMin: num('--minSlopeUsdPerMin', 6),
  takeProfit01: num('--tp01', 0.03),
  stopLoss01: num('--sl01', 0.02),
  clipShares: num('--clip', 40),
  cooldownMs: num('--cooldownMs', 2_000),
};

const res = runBacktestPaperBothLanes({ data, params });
for (const l of res.summaryLines) console.log(l);
if (getArg('--trades')) {
  console.log('\ntrades:');
  for (const t of res.trades.slice(0, 200)) {
    console.log(`${new Date(t.t).toISOString()}  ${t.side.toUpperCase()} ${t.tokenId.slice(0, 10)}… @ ${(t.price01 * 100).toFixed(1)}¢  ${t.shares.toFixed(4)}sh  ${t.note ?? ''}`);
  }
}

