import { describe, expect, it } from 'vitest';
import { SignatureTypeV2 as SignatureType } from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';
import { getTradingConfigFromEnv } from './polymarketTrading.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945382dbd8f8f86d6b2f4e9a6f01cc041b8510';
const TEST_SIGNER = new Wallet(TEST_KEY).address;
const TEST_FUNDER = '0x1111111111111111111111111111111111111111';

describe('getTradingConfigFromEnv', () => {
  it('infers an EOA funder from the private key', () => {
    const res = getTradingConfigFromEnv({ POLYMARKET_PRIVATE_KEY: TEST_KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.signerAddress).toBe(TEST_SIGNER);
    expect(res.config.funderAddress).toBe(TEST_SIGNER);
    expect(res.config.signatureType).toBe(SignatureType.EOA);
  });

  it('infers a safe wallet when a different funder is configured', () => {
    const res = getTradingConfigFromEnv({
      POLYMARKET_PRIVATE_KEY: TEST_KEY,
      POLYMARKET_FUNDER: TEST_FUNDER,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.signatureType).toBe(SignatureType.POLY_GNOSIS_SAFE);
    expect(res.config.funderAddress).toBe(TEST_FUNDER);
  });

  it('rejects an invalid signature type', () => {
    const res = getTradingConfigFromEnv({
      POLYMARKET_PRIVATE_KEY: TEST_KEY,
      POLYMARKET_SIGNATURE_TYPE: 'banana',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('bad_signature_type');
  });
});
