import { describe, expect, it } from 'vitest';
import { bullpenCancelAlreadyDone, interpretBullpenTradeCli, isBullpenLiquidityKill, parseBullpenTradeStdout } from './bullpenCli.js';

const FOK_STDOUT = `{
  "preview": { "amount_usd": 1.0, "outcome": "Up" },
  "result": {
    "success": false,
    "error": "order couldn't be fully filled. FOK orders are fully filled or killed.",
    "order_id": "0xabc",
    "status": "rejected"
  }
}
{
  "error": "execution failed: order couldn't be fully filled. FOK orders are fully filled or killed."
}`;

describe('bullpenCancelAlreadyDone', () => {
  it('treats matched or missing order as idempotent cancel', () => {
    expect(
      bullpenCancelAlreadyDone(
        'Cancel failed: order not cancelled: Some("order can\'t be found - already canceled or matched")',
      ),
    ).toBe(true);
  });
});

describe('bullpenCli trade parse', () => {
  it('parses first JSON object from multi-line stdout', () => {
    const p = parseBullpenTradeStdout(FOK_STDOUT);
    expect(p).not.toBeNull();
    const r = (p as { result?: { error?: string } }).result;
    expect(r?.error).toContain('FOK');
  });

  it('surfaces FOK rejection instead of generic CLI failure', () => {
    const t = interpretBullpenTradeCli(FOK_STDOUT, '', 4);
    expect(t.ok).toBe(false);
    if (t.ok) return;
    expect(t.message).toContain('FOK');
    expect(t.hint.toLowerCase()).toContain('limit');
  });

  it('isBullpenLiquidityKill covers FOK and no-match paths', () => {
    expect(isBullpenLiquidityKill('order could not be fully filled. FOK orders are fully filled or killed.')).toBe(true);
    expect(isBullpenLiquidityKill('no orders found to match with FAK order')).toBe(true);
    expect(isBullpenLiquidityKill('balance_insufficient')).toBe(false);
  });
});
