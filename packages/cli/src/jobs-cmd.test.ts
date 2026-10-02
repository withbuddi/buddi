import type { Job } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { formatJobLine, jobJson } from './jobs-cmd.js';

const at = new Date('2026-09-30T14:02:00');
const failed: Job = {
  id: '3f2b1c9d-1111-2222-3333-444455556666', kind: 'agent-run', payload: {}, state: 'failed', priority: 0, runAfter: at,
  attempts: 8, maxAttempts: 8, leaseOwner: null, leaseUntil: null, lastError: 'You exceeded your current quota\nmore', result: null,
  conversationId: null, dedupKey: null, suspendedReason: null, acknowledgedAt: null, acknowledgedBy: null, createdAt: at, updatedAt: at,
};

describe('buddi jobs listing', () => {
  it('says when a failed job was dismissed, and by age', () => {
    expect(formatJobLine(failed, at)).not.toMatch(/dismissed/);
    expect(formatJobLine({ ...failed, acknowledgedAt: new Date('2026-10-01T09:30:00'), acknowledgedBy: 'owner' }, at))
      .toMatch(/\[dismissed 2026-10-01 09:30\]  — You exceeded your current quota$/);
    expect(formatJobLine({ ...failed, acknowledgedAt: at, acknowledgedBy: 'auto' }, at)).toMatch(/\[dismissed: over 14 days old\]/);
  });

  it('carries the dismissal in --json', () => {
    expect(jobJson({ ...failed, acknowledgedAt: at, acknowledgedBy: 'owner' })).toMatchObject({ acknowledgedAt: at.toISOString(), acknowledgedBy: 'owner' });
    expect(jobJson(failed)).toMatchObject({ acknowledgedAt: null, acknowledgedBy: null });
  });
});
