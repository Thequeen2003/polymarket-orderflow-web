import type { BuilderConfig } from '@polymarket/builder-signing-sdk';
import {
  type ApiKeyCreds as LegacyApiKeyCreds,
  Chain as LegacyChain,
  ClobClient as LegacyClobClient,
  SignatureType as LegacySignatureType,
} from '@polymarket/clob-client';
import {
  type ApiKeyCreds as V2ApiKeyCreds,
  Chain,
  ClobClient as V2ClobClient,
  SignatureTypeV2 as SignatureType,
} from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';

export type TradingSdkFlavor = 'v2' | 'legacy';

export type PolymarketClobClient = V2ClobClient | LegacyClobClient;

export type TradingConfig = {
  host: string;
  chainId: Chain;
  sdk: TradingSdkFlavor;
  privateKey: string;
  signerAddress: string;
  signatureType: SignatureType;
  funderAddress: string;
  useServerTime: boolean;
  builderCode?: string;
};

type TradingConfigResult =
  | { ok: true; config: TradingConfig }
  | { ok: false; error: string; hint: string };

export type TradingClientResult =
  | { ok: true; client: PolymarketClobClient; config: TradingConfig; sdk: TradingSdkFlavor }
  | { ok: false; error: string; hint: string; details?: string };

const DEFAULT_HOST = 'https://clob.polymarket.com';

let clientCache: { key: string; promise: Promise<{ client: PolymarketClobClient; config: TradingConfig }> } | null =
  null;

function parseSdkFlavor(env: NodeJS.ProcessEnv): TradingSdkFlavor {
  const v = String(env.POLYMARKET_CLOB_SDK ?? '').trim().toLowerCase();
  if (v === 'legacy' || v === 'v1' || v === 'clob-client') return 'legacy';
  return 'v2';
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function parseChain(raw: string | undefined): Chain | null {
  if (!raw || !raw.trim()) return Chain.POLYGON;
  const value = Number(raw);
  if (value === Chain.POLYGON) return Chain.POLYGON;
  if (value === Chain.AMOY) return Chain.AMOY;
  return null;
}

function parseSignatureType(raw: string | undefined): SignatureType | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (['0', 'eoa'].includes(value)) return SignatureType.EOA;
  if (['1', 'proxy', 'poly_proxy', 'magic'].includes(value)) return SignatureType.POLY_PROXY;
  if (['2', 'safe', 'gnosis', 'gnosis_safe', 'poly_gnosis_safe'].includes(value)) {
    return SignatureType.POLY_GNOSIS_SAFE;
  }
  if (['3', '1271', 'poly_1271', 'smart', 'contract'].includes(value)) {
    return SignatureType.POLY_1271;
  }
  return null;
}

function parseBuilderCode(raw: string | undefined): string | undefined {
  const v = String(raw ?? '').trim();
  if (!v) return undefined;
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? v : undefined;
}

function toLegacySignature(sig: SignatureType): LegacySignatureType {
  if (sig === SignatureType.EOA) return LegacySignatureType.EOA;
  if (sig === SignatureType.POLY_PROXY) return LegacySignatureType.POLY_PROXY;
  if (sig === SignatureType.POLY_GNOSIS_SAFE) return LegacySignatureType.POLY_GNOSIS_SAFE;
  return LegacySignatureType.EOA;
}

export function getTradingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TradingConfigResult {
  const sdk = parseSdkFlavor(env);
  const privateKey = String(env.POLYMARKET_PRIVATE_KEY ?? env.PRIVATE_KEY ?? '').trim();
  if (!privateKey) {
    return {
      ok: false,
      error: 'missing_private_key',
      hint:
        'Set POLYMARKET_PRIVATE_KEY in api/.env (or repo .env). Keep it server-side only and never commit it.',
    };
  }

  let signer: Wallet;
  try {
    signer = new Wallet(privateKey);
  } catch {
    return {
      ok: false,
      error: 'bad_private_key',
      hint: 'POLYMARKET_PRIVATE_KEY must be a valid 0x-prefixed hex private key.',
    };
  }

  const signatureTypeRaw = String(env.POLYMARKET_SIGNATURE_TYPE ?? env.SIGNATURE_TYPE ?? '').trim();
  const explicitSignatureType = parseSignatureType(signatureTypeRaw);
  if (signatureTypeRaw && explicitSignatureType == null) {
    return {
      ok: false,
      error: 'bad_signature_type',
      hint: 'Use POLYMARKET_SIGNATURE_TYPE=0, 1, 2, or 3 (EOA, POLY_PROXY, POLY_GNOSIS_SAFE, POLY_1271).',
    };
  }

  const configuredFunder = String(
    env.POLYMARKET_FUNDER ?? env.POLYMARKET_FUNDER_ADDRESS ?? env.FUNDER_ADDRESS ?? '',
  ).trim();

  const inferredSignatureType =
    explicitSignatureType ??
    (configuredFunder && configuredFunder.toLowerCase() !== signer.address.toLowerCase()
      ? SignatureType.POLY_GNOSIS_SAFE
      : SignatureType.EOA);

  if (sdk === 'legacy' && inferredSignatureType === SignatureType.POLY_1271) {
    return {
      ok: false,
      error: 'legacy_sdk_signature_unsupported',
      hint:
        'POLYMARKET_CLOB_SDK=legacy (@polymarket/clob-client) supports signature types 0–2 only. Use POLYMARKET_CLOB_SDK=v2 for POLY_1271, or switch signing mode.',
    };
  }

  const funderAddress = configuredFunder || (inferredSignatureType === SignatureType.EOA ? signer.address : '');
  if (!funderAddress) {
    return {
      ok: false,
      error: 'missing_funder_address',
      hint:
        'Set POLYMARKET_FUNDER to your Polymarket funder/profile address. This is required for proxy or safe wallets.',
    };
  }

  const chainId = parseChain(env.POLYMARKET_CHAIN_ID);
  if (chainId == null) {
    return {
      ok: false,
      error: 'bad_chain_id',
      hint: 'Use POLYMARKET_CHAIN_ID=137 for Polygon mainnet or 80002 for Amoy.',
    };
  }

  const host = String(env.POLYMARKET_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const builderCode = parseBuilderCode(env.POLYMARKET_BUILDER_CODE);
  return {
    ok: true,
    config: {
      host,
      chainId,
      sdk,
      privateKey,
      signerAddress: signer.address,
      signatureType: inferredSignatureType,
      funderAddress,
      useServerTime: parseBoolean(env.POLYMARKET_USE_SERVER_TIME, true),
      ...(builderCode ? { builderCode } : {}),
    },
  };
}

function apiCredsCacheKey(env: NodeJS.ProcessEnv = process.env): string {
  void env;
  return 'signer_derived_only';
}

function cacheKeyFor(config: TradingConfig, env: NodeJS.ProcessEnv = process.env): string {
  return [
    config.sdk,
    config.host,
    String(config.chainId),
    config.signerAddress.toLowerCase(),
    config.funderAddress.toLowerCase(),
    String(config.signatureType),
    String(config.useServerTime),
    String(config.builderCode ?? ''),
    apiCredsCacheKey(env),
  ].join('|');
}

async function resolveApiCredsV2(client: V2ClobClient): Promise<V2ApiKeyCreds> {
  try {
    return await client.createOrDeriveApiKey();
  } catch {
    return await client.createApiKey();
  }
}

async function resolveApiCredsLegacy(client: LegacyClobClient): Promise<LegacyApiKeyCreds> {
  try {
    return await client.createOrDeriveApiKey();
  } catch {
    return await client.createApiKey();
  }
}

async function buildTradingClientV2(config: TradingConfig): Promise<{ client: V2ClobClient; config: TradingConfig }> {
  const signer = new Wallet(config.privateKey);
  const baseOpts = {
    host: config.host,
    chain: config.chainId,
    signer,
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    useServerTime: config.useServerTime,
    ...(config.builderCode ? { builderConfig: { builderCode: config.builderCode } } : {}),
    retryOnError: true,
    throwOnError: true,
  } as const;

  const authClient = new V2ClobClient(baseOpts);
  const creds = await resolveApiCredsV2(authClient);
  const client = new V2ClobClient({
    ...baseOpts,
    creds,
  });
  return { client, config };
}

async function buildTradingClientLegacy(
  config: TradingConfig,
): Promise<{ client: LegacyClobClient; config: TradingConfig }> {
  const signer = new Wallet(config.privateKey);
  const legacySig = toLegacySignature(config.signatureType);
  const builderConfig = (
    config.builderCode ? { builderCode: config.builderCode } : undefined
  ) as BuilderConfig | undefined;

  const authClient = new LegacyClobClient(
    config.host,
    config.chainId as unknown as LegacyChain,
    signer,
    undefined,
    legacySig,
    config.funderAddress,
    undefined,
    config.useServerTime,
    builderConfig,
    undefined,
    true,
    undefined,
    true,
  );
  const creds = await resolveApiCredsLegacy(authClient);
  const client = new LegacyClobClient(
    config.host,
    config.chainId as unknown as LegacyChain,
    signer,
    creds,
    legacySig,
    config.funderAddress,
    undefined,
    config.useServerTime,
    builderConfig,
    undefined,
    true,
    undefined,
    true,
  );
  return { client, config };
}

async function buildTradingClient(config: TradingConfig): Promise<{ client: PolymarketClobClient; config: TradingConfig }> {
  if (config.sdk === 'legacy') {
    return buildTradingClientLegacy(config);
  }
  return buildTradingClientV2(config);
}

export async function getTradingClient(): Promise<TradingClientResult> {
  const configResult = getTradingConfigFromEnv();
  if (!configResult.ok) return configResult;

  const key = cacheKeyFor(configResult.config, process.env);
  if (!clientCache || clientCache.key !== key) {
    clientCache = {
      key,
      promise: buildTradingClient(configResult.config),
    };
  }

  try {
    const { client, config } = await clientCache.promise;
    return { ok: true, client, config, sdk: config.sdk };
  } catch (error) {
    clientCache = null;
    const raw = error instanceof Error ? error.message : String(error);
    const looksCloudflareBlock =
      /cloudflare|Attention Required|you have been blocked|cf-ray/i.test(raw) || raw.trim().startsWith('<!DOCTYPE');
    if (looksCloudflareBlock) {
      return {
        ok: false,
        error: 'trading_auth_failed',
        hint:
          'Polymarket’s CLOB edge returned a Cloudflare block page from this network (common for VPNs, cloud VMs, and some datacenters). Keys can still be valid — try a residential connection or another network. If you use POLYMARKET_HOST, confirm it matches Polymarket’s CLOB base URL.',
        details: 'clob_http_cloudflare_block',
      };
    }
    return {
      ok: false,
      error: 'trading_auth_failed',
      hint:
        'Failed to authenticate with the Polymarket CLOB API. Verify your private key, signature type, and funder address. Try POLYMARKET_CLOB_SDK=legacy if V2 key derivation fails.',
      details: raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw,
    };
  }
}
