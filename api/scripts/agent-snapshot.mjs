#!/usr/bin/env node
/**
 * Fetch a complete raw desk snapshot for an AI agent (default: BTC 5m current window).
 *
 *   npm run agent:snapshot
 *   npm run agent:snapshot -- --asset eth --interval 15m
 *   npm run agent:snapshot -- --out btc-5m.json
 *
 * Requires API on http://127.0.0.1:8787 (npm run dev).
 */

const args = process.argv.slice(2);
let asset = 'btc';
let interval = '5m';
let outPath = null;
let apiBase = (process.env.API_BASE || process.env.VITE_API_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--asset' && args[i + 1]) asset = args[++i];
  else if (a === '--interval' && args[i + 1]) interval = args[++i];
  else if ((a === '--out' || a === '-o') && args[i + 1]) outPath = args[++i];
  else if (a === '--api' && args[i + 1]) apiBase = args[++i].replace(/\/+$/, '');
  else if (a === '--help' || a === '-h') {
    console.log(`Usage: agent-snapshot.mjs [--asset btc|eth|sol|hype] [--interval 5m|15m|1h|4h|1d] [--out file.json] [--api http://127.0.0.1:8787]`);
    process.exit(0);
  }
}

const url = `${apiBase}/api/agent/snapshot?asset=${encodeURIComponent(asset)}&interval=${encodeURIComponent(interval)}`;

const r = await fetch(url, { headers: { accept: 'application/json' } });
const text = await r.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  console.error('Non-JSON response from API:', text.slice(0, 400));
  process.exit(1);
}

if (!r.ok || !body.ok) {
  console.error('Snapshot failed:', JSON.stringify(body, null, 2));
  process.exit(1);
}

const json = JSON.stringify(body.data, null, 2);
if (outPath) {
  const fs = await import('node:fs/promises');
  await fs.writeFile(outPath, json, 'utf8');
  console.error(`Wrote ${outPath} (${json.length} bytes)`);
} else {
  process.stdout.write(json);
  process.stdout.write('\n');
}
