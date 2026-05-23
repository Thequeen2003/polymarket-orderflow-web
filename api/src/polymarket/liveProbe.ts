import { polymarketApiBasesForHealth } from '../polymarketApiUrls.js';
import { clobOkJsonProbe } from './clobPublic.js';
import { polymarketGetJson, PolymarketHttpError } from './http.js';

export type PolymarketServiceProbe = {
  name: 'gamma' | 'clob' | 'data';
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  note: string | null;
};

export type PolymarketLiveStatus = {
  checkedAt: string;
  bases: ReturnType<typeof polymarketApiBasesForHealth>;
  services: PolymarketServiceProbe[];
  allPublicOk: boolean;
};

async function probeGet(label: PolymarketServiceProbe['name'], url: string): Promise<PolymarketServiceProbe> {
  const t0 = Date.now();
  try {
    await polymarketGetJson(url, { timeoutMs: 8_000 });
    return {
      name: label,
      url,
      ok: true,
      status: 200,
      latencyMs: Date.now() - t0,
      note: null,
    };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    if (e instanceof PolymarketHttpError) {
      return { name: label, url, ok: false, status: e.status, latencyMs, note: e.message };
    }
    return {
      name: label,
      url,
      ok: false,
      status: null,
      latencyMs,
      note: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Reachability check for Gamma + CLOB + Data (public reads). */
export async function probePolymarketLive(): Promise<PolymarketLiveStatus> {
  const bases = polymarketApiBasesForHealth();
  const gammaUrl = `${bases.gamma}/markets?limit=1&active=true`;
  const dataUrl = `${bases.data}/trades?limit=1`;

  const [gamma, data] = await Promise.all([
    probeGet('gamma', gammaUrl),
    probeGet('data', dataUrl),
  ]);

  const clobT0 = Date.now();
  const clobProbe = await clobOkJsonProbe(bases.clob);
  const clob: PolymarketServiceProbe = {
    name: 'clob',
    url: `${bases.clob.replace(/\/+$/, '')}/ok`,
    ok: clobProbe.ok,
    status: clobProbe.status,
    latencyMs: Date.now() - clobT0,
    note: clobProbe.note,
  };

  const services = [gamma, clob, data];
  return {
    checkedAt: new Date().toISOString(),
    bases,
    services,
    allPublicOk: services.every((s) => s.ok),
  };
}
