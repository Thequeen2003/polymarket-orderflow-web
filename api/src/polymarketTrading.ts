import { type ApiKeyCreds, Chain, ClobClient, SignatureType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

export type TradingConfig = {
  host: string;
  chainId: Chain;
  privateKey: string;
  signerAddress: string;
  signatureType: SignatureType;
  funderAddress: string;
  useServerTime: boolean;
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
  return null;
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
      hint: 'Use POLYMARKET_SIGNATURE_TYPE=0, 1, or 2 (EOA, POLY_PROXY, or POLY_GNOSIS_SAFE).',
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
    },
  };
}

function cacheKeyFor(config: TradingConfig): string {
  return [
    config.host,
    String(config.chainId),
    config.signerAddress.toLowerCase(),
    config.funderAddress.toLowerCase(),
    String(config.signatureType),
    String(config.useServerTime),
  ].join('|');
}

async function buildTradingClient(config: TradingConfig): Promise<{ client: ClobClient; config: TradingConfig }> {
  const signer = new Wallet(config.privateKey);
  const baseArgs = [
    config.host,
    config.chainId,
    signer,
    undefined,
    config.signatureType,
    config.funderAddress,
    undefined,
    config.useServerTime,
    undefined,
    undefined,
    true,
    undefined,
    true,
  ] as const;

  const authClient = new ClobClient(...baseArgs);
  const creds = await resolveApiCreds(authClient);
  const client = new ClobClient(
    config.host,
    config.chainId,
    signer,
    creds,
    config.signatureType,
    config.funderAddress,
    undefined,
    config.useServerTime,
    undefined,
    undefined,
    true,
    undefined,
    true,
  );
  return { client, config };
}

async function resolveApiCreds(client: ClobClient, env: NodeJS.ProcessEnv = process.env): Promise<ApiKeyCreds> {
  const key = String(env.POLYMARKET_API_KEY ?? '').trim();
  const secret = String(env.POLYMARKET_API_SECRET ?? '').trim();
  const passphrase = String(env.POLYMARKET_API_PASSPHRASE ?? '').trim();
  if (key && secret && passphrase) return { key, secret, passphrase };

  try {
    return await client.deriveApiKey();
  } catch {
    return client.createApiKey();
  }
}

export async function getTradingClient(): Promise<TradingClientResult> {
  const configResult = getTradingConfigFromEnv();
  if (!configResult.ok) return configResult;

  const key = cacheKeyFor(configResult.config);
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
