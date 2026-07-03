import { describe, expect, it } from 'vitest';
import { buildUpdownWindowPickerItems, updownWindowPickerCounts } from './updownWindowPicker';

describe('updownWindowPicker', () => {
  it('includes future and past windows around the current bucket', () => {
    const ts = 1_770_000_000;
    const items = buildUpdownWindowPickerItems({
      asset: 'btc',
      interval: '5m',
      bucketStartSec: ts,
      stepSec: 300,
      currentSlug: `btc-updown-5m-${ts}`,
      titled: false,
    });
    const future = items.filter((i) => i.isFuture);
    const current = items.find((i) => i.isCurrent);
    const past = items.filter((i) => i.offset > 0);
    expect(future.length).toBe(updownWindowPickerCounts('5m').future);
    expect(past.length).toBe(updownWindowPickerCounts('5m').past);
    expect(current?.ts).toBe(ts);
    const nearestFuture = future.find((i) => i.offset === -1);
    expect(nearestFuture?.ts).toBe(ts + 300);
    expect(nearestFuture?.label.startsWith('↑')).toBe(true);
  });
});
