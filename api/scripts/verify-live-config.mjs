/**
 * Verifies Bullpen + live-trading configuration for the API process.
 * Run from repo: `npm run verify:live -w api` (loads `api/.env` when present).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '..');
const repoRoot = join(apiRoot, '..');

function loadDotEnvFile(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const fileEnv = { ...loadDotEnvFile(join(repoRoot, '.env')), ...loadDotEnvFile(join(apiRoot, '.env')) };
const env = { ...fileEnv, ...process.env };

function envFlagTrue(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envFlagFalse(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function isEnableLiveTrading() {
  return envFlagTrue(env.ENABLE_LIVE_TRADING);
}

function isLiveTradingConfirmed() {
  const raw = String(env.POLYMARKET_LIVE_CONFIRM ?? '').trim();
  if (!raw) return false;
  if (envFlagTrue(raw)) return true;
  return raw.toLowerCase() === 'i understand the risks of live trading.';
}

function hasClobKeys() {
  return Boolean(String(env.POLYMARKET_PRIVATE_KEY ?? '').trim()) && Boolean(
    String(env.POLYMARKET_FUNDER ?? env.POLYMARKET_FUNDER_ADDRESS ?? env.FUNDER_ADDRESS ?? '').trim(),
  );
}

function liveOrdersViaBullpen() {
  const via = String(env.POLYMARKET_LIVE_ORDERS_VIA ?? '').trim().toLowerCase();
  if (via === 'clob') return false;
  if (via === 'bullpen') return true;
  if (via !== '') return true;
  if (envFlagFalse(env.POLYMARKET_USE_BULLPEN)) return false;
  if (isEnableLiveTrading() && isLiveTradingConfirmed() && hasClobKeys()) return false;
  return true;
}

function polymarketUseBullpen() {
  const v = String(env.POLYMARKET_USE_BULLPEN ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  return liveOrdersViaBullpen();
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 4_000_000, ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, status: r.status, out };
}

const bullpenBin = String(env.BULLPEN_BIN || 'bullpen').trim() || 'bullpen';
const bullpenEnv = String(env.BULLPEN_ENV || 'production').trim() || 'production';
const port = Number(env.PORT || 8787);
const hasPk = Boolean(String(env.POLYMARKET_PRIVATE_KEY || '').trim());
const funderRaw =
  String(env.POLYMARKET_FUNDER ?? env.POLYMARKET_FUNDER_ADDRESS ?? env.FUNDER_ADDRESS ?? '').trim();
const hasFunder = Boolean(funderRaw);

let exit = 0;

console.log('=== Live / Bullpen configuration (api) ===\n');
console.log(
  `env files: repo/.env ${existsSync(join(repoRoot, '.env')) ? 'yes' : 'no'} · api/.env ${existsSync(join(apiRoot, '.env')) ? 'yes' : 'no'}\n`,
);

console.log('Environment (effective for API):');
console.log(`  ENABLE_LIVE_TRADING:        ${env.ENABLE_LIVE_TRADING || '(unset)'}`);
console.log(`  POLYMARKET_LIVE_CONFIRM:    ${env.POLYMARKET_LIVE_CONFIRM ? 'set' : '(unset)'}`);
console.log(`  POLYMARKET_LIVE_ORDERS_VIA: ${env.POLYMARKET_LIVE_ORDERS_VIA || '(unset)'}`);
console.log(`  POLYMARKET_USE_BULLPEN:     ${env.POLYMARKET_USE_BULLPEN || '(unset)'}`);
console.log(`  POLYMARKET_CLOB_SDK:        ${env.POLYMARKET_CLOB_SDK || '(unset)'}`);
console.log(`  BULLPEN_BIN:                ${bullpenBin}`);
console.log(`  BULLPEN_ENV:                ${bullpenEnv}`);
console.log(`  PORT:                       ${port}`);
console.log(`  POLYMARKET_PRIVATE_KEY:     ${hasPk ? 'set' : 'missing'}`);
console.log(
  `  POLYMARKET_FUNDER:          ${hasFunder ? `set (${funderRaw.slice(0, 6)}…)` : 'missing (also checks POLYMARKET_FUNDER_ADDRESS, FUNDER_ADDRESS)'}`,
);
console.log('');
console.log('Derived (matches server liveTradingPolicy):');
console.log(`  enable_live_trading:        ${isEnableLiveTrading()}`);
console.log(`  live_trading_confirmed:    ${isLiveTradingConfirmed()}`);
console.log(`  live_orders_via:           ${liveOrdersViaBullpen() ? 'bullpen' : 'clob'}`);
console.log(`  polymarket_use_bullpen:    ${polymarketUseBullpen()}`);
console.log('');

if (!liveOrdersViaBullpen()) {
  console.log('Note: Live market/limit orders will use in-process CLOB from api/.env keys.\n');
} else if (isEnableLiveTrading() && hasClobKeys()) {
  console.log(
    'Note: ENABLE_LIVE_TRADING + CLOB keys are set but execution still uses Bullpen — set POLYMARKET_LIVE_ORDERS_VIA=clob or fix POLYMARKET_LIVE_CONFIRM.\n',
  );
}

if (!hasPk || !hasFunder) {
  console.warn(
    'Warning: POLYMARKET_PRIVATE_KEY / POLYMARKET_FUNDER missing — open orders, cancel, and CLOB balance/avg-entry reads will fail (Bullpen fills can still work if CLI is logged in).\n',
  );
}

const ver = run(bullpenBin, ['--version']);
if (!ver.ok) {
  console.error(`FAIL: "${bullpenBin}" not runnable (--version exit ${ver.status})\n${ver.out.slice(0, 400)}`);
  exit = 1;
} else {
  console.log(`Bullpen CLI: ${ver.out.split('\n')[0] ?? ver.out}`);
}

const st = run(bullpenBin, ['status'], { timeout: 20_000 });
/** Avoid matching "logged in" inside "Not logged in". */
const bpLoggedOut = /Status:\s+Not logged in/i.test(st.out);
const bpLoggedIn = /Status:\s+Logged in\b/i.test(st.out);
if (!st.ok) {
  console.error(`FAIL: bullpen status (exit ${st.status})\n${st.out.slice(0, 800)}`);
  exit = 1;
} else if (bpLoggedOut || !bpLoggedIn) {
  console.error(
    'FAIL: Bullpen is not logged in — run `bullpen login` on the machine that runs the API (same user/session).\n',
  );
  exit = 1;
} else {
  console.log('Bullpen auth: OK (status shows Logged in)');
}

const pos = run(
  bullpenBin,
  ['polymarket', 'positions', '--env', bullpenEnv, '--output', 'json'],
  { timeout: 30_000 },
);
if (!pos.ok) {
  console.error(`FAIL: bullpen polymarket positions (exit ${pos.status})\n${pos.out.slice(0, 800)}`);
  exit = 1;
} else {
  try {
    const raw = pos.out.trim();
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      const i = raw.indexOf('{');
      const jEnd = raw.lastIndexOf('}');
      if (i < 0 || jEnd <= i) throw new Error('no_json_object');
      j = JSON.parse(raw.slice(i, jEnd + 1));
    }
    if (j && typeof j === 'object' && Array.isArray(j.positions)) console.log('Bullpen Polymarket API: OK (positions JSON)');
    else console.warn('WARN: positions JSON missing `positions` array');
  } catch {
    console.warn('WARN: could not parse positions JSON');
  }
}

try {
  const url = `http://127.0.0.1:${port}/api/health`;
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  const text = await r.text();
  if (!r.ok) {
    console.warn(`WARN: ${url} returned HTTP ${r.status}`);
  } else {
    const data = JSON.parse(text);
    const d = data?.data;
    if (d?.trading_live_orders_via) {
      console.log(`API health (${url}): trading_live_orders_via = "${d.trading_live_orders_via}"`);
      const want = liveOrdersViaBullpen() ? 'bullpen' : 'clob';
      if (d.trading_live_orders_via !== want) {
        console.error(
          `FAIL: API reports "${d.trading_live_orders_via}" but api/.env expects "${want}" — restart the API (npm run dev -w api).`,
        );
        exit = 1;
      }
    } else {
      console.warn('WARN: health JSON missing data.trading_live_orders_via');
    }
  }
} catch {
  console.log(`API health: skipped (no server on 127.0.0.1:${port} within 3s — start with npm run dev -w api)`);
}

const viaLabel = liveOrdersViaBullpen() ? 'Bullpen' : 'CLOB (api/.env keys)';
console.log(exit === 0 ? `\nOK: configuration looks good for ${viaLabel} live orders.` : '\nDone with errors — fix items above.');
process.exit(exit);
