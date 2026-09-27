import { describe, expect, it } from 'vitest';
import { addUsage, usageView } from './usage-view.js';

describe('usageView', () => {
  it('carries the cache counts only when non-zero', () => {
    expect(usageView({ input: 3, output: 1 })).toEqual({ input: 3, output: 1 });
    expect(usageView({ input: '3', output: 1, cacheRead: '900', cacheWrite: 0 })).toEqual({ input: 3, output: 1, cacheRead: 900 });
    expect(usageView(undefined)).toEqual({ input: 0, output: 0 });
  });

  it('adds runs together', () => {
    expect(addUsage({ input: 1, output: 1, cacheRead: 5 }, { input: 2, output: 2, cacheWrite: 7 }))
      .toEqual({ input: 3, output: 3, cacheRead: 5, cacheWrite: 7 });
  });
});
