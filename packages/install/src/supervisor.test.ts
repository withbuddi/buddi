import { describe, expect, test } from 'vitest';
import { controlToken, restartDelay } from './supervisor.js';

describe('the supervisor', () => {
  test('supervisor uses a distinct credential domain', () => {
    expect(controlToken('dashboard-token')).not.toBe('dashboard-token');
    expect(controlToken('dashboard-token')).not.toBe(controlToken('another-install'));
    expect(controlToken('dashboard-token')).toBe(controlToken('dashboard-token'));
  });

  test('gateway restart backoff is exponential and bounded', () => {
    expect([0, 1, 2, 3, 4, 1000].map(restartDelay)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
