export type BracketInputMode = 'cents' | 'pct' | 'usd';
export type BracketLegKind = 'sl' | 'tp';
export type BracketRefSource = 'avg_entry' | 'buy_price' | 'mid';

function validRef01(x: number | null | undefined): x is number {
  return x != null && Number.isFinite(x) && x > 0 && x < 1;
}

function validShares(x: number | null | undefined): x is number {
  return x != null && Number.isFinite(x) && x > 0;
}

/** Entry anchor for % and $/share bracket math — filled avg, then buy limit, then mid. */
export function resolveBracketRef(params: {
  avgEntry01?: number | null;
  plannedEntry01?: number | null;
  mid01?: number | null;
}): { ref01: number | null; source: BracketRefSource | null } {
  if (validRef01(params.avgEntry01)) return { ref01: params.avgEntry01, source: 'avg_entry' };
  if (validRef01(params.plannedEntry01)) return { ref01: params.plannedEntry01, source: 'buy_price' };
  if (validRef01(params.mid01)) return { ref01: params.mid01, source: 'mid' };
  return { ref01: null, source: null };
}

export function bracketRef01(
  avgEntry01: number | null,
  mid01: number | null,
  plannedEntry01?: number | null,
): number | null {
  return resolveBracketRef({ avgEntry01, plannedEntry01, mid01 }).ref01;
}

export function clampTarget01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

export function formatTargetCents01(target01: number): string {
  const c = Math.round(clampTarget01(target01) * 1000) / 10;
  return c % 1 === 0 ? String(Math.round(c)) : String(c);
}

function parsePositive(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseCentsStr(raw: string): number | null {
  const n = parsePositive(raw);
  if (n == null || n <= 0 || n >= 100) return null;
  return clampTarget01(n / 100);
}

/** True when the draft looks like total $ P&L (e.g. 100) rather than trigger ¢ (1–99). */
export function isBracketTotalUsdDraft(raw: string): boolean {
  const n = parsePositive(raw);
  return n != null && n > 99;
}

/** Commit values above 99 as total $ loss/gain when shares + ref are known; returns trigger ¢. */
export function bracketTriggerFromTotalUsdDraft(params: {
  raw: string;
  kind: BracketLegKind;
  ref01: number;
  shares: number;
}): { centsStr: string; usdRaw: string } | null {
  const usdRaw = params.raw.trim();
  if (!isBracketTotalUsdDraft(usdRaw)) return null;
  const target01 = target01FromBracketInput({
    mode: 'usd',
    raw: usdRaw,
    kind: params.kind,
    ref01: params.ref01,
    shares: params.shares,
  });
  if (target01 == null) return null;
  return { centsStr: centsStrFromTarget01(target01), usdRaw };
}

export function usdPerShareDelta(target01: number, ref01: number): number {
  return Math.abs(target01 - ref01);
}

export function usdTotalDelta(target01: number, ref01: number, shares: number): number {
  return usdPerShareDelta(target01, ref01) * shares;
}

function formatUsdPerShare(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n < 0.0001) return '0';
  if (n >= 0.1) return n.toFixed(2);
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatUsdTotal(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 1000) return Math.round(n).toLocaleString();
  if (Number.isInteger(n)) return String(n);
  if (n >= 100) return n.toFixed(1).replace(/\.0$/, '');
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** When shares are known, USD mode is total $ P&L; otherwise $/share. */
export function usdModeUsesTotal(shares: number | null | undefined): boolean {
  return validShares(shares);
}

/** SL/TP trigger from ¢, % off ref, or $ (total or per-share) distance from ref. */
export function target01FromBracketInput(params: {
  mode: BracketInputMode;
  raw: string;
  kind: BracketLegKind;
  ref01: number;
  shares?: number | null;
}): number | null {
  const { mode, raw, kind, ref01, shares } = params;
  if (!(ref01 > 0 && ref01 < 1)) return null;
  if (mode === 'cents') return parseCentsStr(raw);
  const mag = parsePositive(raw);
  if (mag == null) return null;
  if (mode === 'pct') {
    const factor = kind === 'sl' ? 1 - mag / 100 : 1 + mag / 100;
    if (!Number.isFinite(factor) || factor <= 0) return null;
    return clampTarget01(ref01 * factor);
  }
  const perShare = usdModeUsesTotal(shares) ? mag / shares! : mag;
  if (!Number.isFinite(perShare) || perShare <= 0) return null;
  const target = kind === 'sl' ? ref01 - perShare : ref01 + perShare;
  if (!Number.isFinite(target)) return null;
  return clampTarget01(target);
}

export function centsStrFromTarget01(target01: number): string {
  return formatTargetCents01(target01);
}

export function bracketAuxFromCents(params: {
  mode: Exclude<BracketInputMode, 'cents'>;
  centsStr: string;
  kind: BracketLegKind;
  ref01: number;
  shares?: number | null;
}): string {
  const target01 = parseCentsStr(params.centsStr);
  if (target01 == null) return '';
  const { ref01, mode, shares } = params;
  if (mode === 'pct') {
    const pct = Math.abs(((target01 - ref01) / ref01) * 100);
    if (!Number.isFinite(pct)) return '';
    const rounded = Math.round(pct * 10) / 10;
    return rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded);
  }
  const perShare = usdPerShareDelta(target01, ref01);
  if (!Number.isFinite(perShare)) return '';
  if (usdModeUsesTotal(shares)) {
    return formatUsdTotal(usdTotalDelta(target01, ref01, shares!));
  }
  return formatUsdPerShare(perShare);
}

export function bracketRefLabel(source: BracketRefSource | null): string {
  if (source === 'avg_entry') return 'avg entry';
  if (source === 'buy_price') return 'buy price';
  if (source === 'mid') return 'mid';
  return '';
}

export type BracketConversionPreview = {
  target01: number | null;
  centsLabel: string;
  pctLabel: string;
  usdLabel: string;
  usdDetail: string | null;
  usdUsesTotal: boolean;
};

/** Live ¢ / % / $ readout while the operator edits any bracket input mode. */
export function bracketConversionFromInput(params: {
  mode: BracketInputMode;
  raw: string;
  kind: BracketLegKind;
  ref01: number | null;
  shares?: number | null;
}): BracketConversionPreview {
  const shares = params.shares;
  const usesTotal = usdModeUsesTotal(shares);
  const dash: BracketConversionPreview = {
    target01: null,
    centsLabel: '—',
    pctLabel: '—',
    usdLabel: '—',
    usdDetail: null,
    usdUsesTotal: usesTotal,
  };
  const trimmed = params.raw.trim();
  if (!trimmed) return dash;

  let target01: number | null = null;
  if (params.mode === 'cents') {
    if (
      isBracketTotalUsdDraft(trimmed) &&
      params.ref01 != null &&
      usdModeUsesTotal(shares)
    ) {
      target01 = target01FromBracketInput({
        mode: 'usd',
        raw: trimmed,
        kind: params.kind,
        ref01: params.ref01,
        shares,
      });
    } else {
      target01 = parseCentsStr(trimmed);
    }
  } else if (params.ref01 != null) {
    target01 = target01FromBracketInput({
      mode: params.mode,
      raw: trimmed,
      kind: params.kind,
      ref01: params.ref01,
      shares,
    });
  }

  if (target01 == null) {
    return { target01: null, centsLabel: '…', pctLabel: '…', usdLabel: '…', usdDetail: null, usdUsesTotal: usesTotal };
  }

  const centsStr = centsStrFromTarget01(target01);
  const centsLabel = `${centsStr}¢`;
  if (params.ref01 == null) {
    return { target01, centsLabel, pctLabel: '—', usdLabel: '—', usdDetail: null, usdUsesTotal: usesTotal };
  }

  const pctMag = bracketAuxFromCents({
    mode: 'pct',
    centsStr,
    kind: params.kind,
    ref01: params.ref01,
    shares,
  });
  const usdMag = bracketAuxFromCents({
    mode: 'usd',
    centsStr,
    kind: params.kind,
    ref01: params.ref01,
    shares,
  });

  const perShare = usdPerShareDelta(target01, params.ref01);
  const usdDetail =
    usesTotal && validShares(shares)
      ? `≈ $${formatUsdPerShare(perShare)}/sh · ${Math.round(shares).toLocaleString()} sh`
      : null;

  return {
    target01,
    centsLabel,
    pctLabel: pctMag ? `${pctMag}%` : '—',
    usdLabel: usdMag ? `$${usdMag}` : '—',
    usdDetail,
    usdUsesTotal: usesTotal,
  };
}
