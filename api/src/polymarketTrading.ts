import { type ApiKeyCreds, Chain, ClobClient, SignatureTypeV2 as SignatureType } from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';

export type TradingConfig = {
  host: string;
  chainId: Chain;
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

type TradingClientResult =
  | { ok: true; client: ClobClient; config: TradingConfig }
  | { ok: false; error: string; hint: string; details?: string };

const DEFAULT_HOST = 'https://clob.polymarket.com';

let clientCache: { key: string; promise: Promise<{ client: ClobClient; config: TradingConfig }> } | null = null;

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
  if (['3', '1271', 'poly_1271', 'smart', 'contract'].includes(value)) return SignatureType.POLY_1271;
  return null;
}

function parseBuilderCode(raw: string | undefined): string | undefined {
  const v = String(raw ?? '').trim();
  if (!v) return undefined;
  return /^0x[0-9a-fA-F]{64}$/.test(v) ? v : undefined;
}

export function getTradingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TradingConfigResult {
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
    env.POLYMARKET_FUNDER ??
      env.POLYMARKET_FUNDER_ADDRESS ??
      env.FUNDER_ADDRESS ??
      '',
  ).trim();

  const inferredSignatureType =
    explicitSignatureType ??
    (configuredFunder && configuredFunder.toLowerCase() !== signer.address.toLowerCase()
      ? SignatureType.POLY_GNOSIS_SAFE
      : SignatureType.EOA);

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
  // Include API creds in the cache key so rotating keys takes effect immediately.
  // (We keep this server-side only; still never log these values.)
  const key = String(env.POLYMARKET_API_KEY ?? '').trim();
  const secret = String(env.POLYMARKET_API_SECRET ?? '').trim();
  const passphrase = String(env.POLYMARKET_API_PASSPHRASE ?? '').trim();
  return [key, secret, passphrase].join('|');
}

function cacheKeyFor(config: TradingConfig, env: NodeJS.ProcessEnv = process.env): string {
  return [
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

async function buildTradingClient(config: TradingConfig): Promise<{ client: ClobClient; config: TradingConfig }> {
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

  const authClient = new ClobClient(baseOpts);
  // For trading, prefer deriving/creating creds from the signer to avoid stale/invalid env key bundles
  // breaking live execution.
  const creds = await resolveApiCreds(authClient, { preferEnv: false });
  const client = new ClobClient({
    ...baseOpts,
    creds,
  });
  return { client, config };
}

async function resolveApiCreds(
  client: ClobClient,
  opts?: { preferEnv?: boolean; env?: NodeJS.ProcessEnv },
): Promise<ApiKeyCreds> {
  const preferEnv = opts?.preferEnv ?? true;
  const env = opts?.env ?? process.env;
  const key = String(env.POLYMARKET_API_KEY ?? '').trim();
  const secret = String(env.POLYMARKET_API_SECRET ?? '').trim();
  const passphrase = String(env.POLYMARKET_API_PASSPHRASE ?? '').trim();
  if (preferEnv && key && secret && passphrase) return { key, secret, passphrase };

  try {
    return await client.createOrDeriveApiKey();
  } catch {
    try {
      return await client.createApiKey();
    } catch {
      if (key && secret && passphrase) return { key, secret, passphrase };
      throw new Error('api_creds_unavailable');
    }
  }
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
    return { ok: true, ...(await clientCache.promise) };
  } catch (error) {
    clientCache = null;
    return {
      ok: false,
      error: 'trading_auth_failed',
      hint:
        'Failed to authenticate with the Polymarket CLOB API. Verify your private key, signature type, and funder address.',
      details: error instanceof Error ? error.message : String(error),
    };
  }
}
