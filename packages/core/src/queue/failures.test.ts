import { describe, expect, it } from 'vitest';
import { failureCause, failureShape, groupFailures, type FailedJob } from './failures.js';
import type { Job } from './types.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const DAY = 86_400_000;

function job(id: string, lastError: string, agentId: string | null, agoMs = DAY * 1.2): FailedJob {
  const updatedAt = new Date(NOW.getTime() - agoMs);
  return {
    job: {
      id, kind: 'agent-run', payload: {}, state: 'failed', priority: 0, runAfter: updatedAt, attempts: 3, maxAttempts: 8,
      leaseOwner: null, leaseUntil: null, lastError, result: null, conversationId: null, dedupKey: null, suspendedReason: null,
      acknowledgedAt: null, acknowledgedBy: null, createdAt: updatedAt, updatedAt,
    } satisfies Job,
    agentId,
    missionId: null,
    missionName: null,
  };
}

const QUOTA = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\nQuota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20';
const SIG = 'Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.';

describe('failure causes', () => {
  it('reads the families the owner actually hit, with a plain reason', () => {
    const quota = failureCause({ lastError: QUOTA, diedAt: new Date(NOW.getTime() - 2 * DAY), now: NOW });
    expect(quota).toMatchObject({ key: 'gemini-quota', label: 'Gemini quota (429)', likelyFixed: true });
    expect(quota.reason).not.toMatch(/googleapis|metric/);

    const sig = failureCause({ lastError: SIG, diedAt: NOW, now: NOW });
    expect(sig).toMatchObject({ key: 'gemini-thought-signature', label: 'Gemini thought_signature (400)', likelyFixed: true });
  });

  it('says a fresh quota or a refused key is not fixed yet', () => {
    expect(failureCause({ lastError: QUOTA, diedAt: new Date(NOW.getTime() - 60_000), now: NOW }).likelyFixed).toBe(false);
    const key = failureCause({ lastError: 'Incorrect API key provided: sk-…', failureReason: 'the provider answered 401 and will again', diedAt: NOW, now: NOW });
    expect(key).toMatchObject({ key: 'provider-credential', label: 'Provider refused the key (401)', likelyFixed: false });
    expect(key.reason).toMatch(/Settings → Model accounts/);
  });

  it('groups anything else by status and shape, so varying ids are one group', () => {
    const a = failureCause({ lastError: 'Invalid message id "msg_8f2a91" at index 3', failureReason: 'the provider answered 400 and will again', diedAt: NOW, now: NOW });
    const b = failureCause({ lastError: 'Invalid message id "msg_00ab12" at index 7', failureReason: 'the provider answered 400 and will again', diedAt: NOW, now: NOW });
    const c = failureCause({ lastError: 'Schema mismatch on field "amount"', failureReason: 'the provider answered 400 and will again', diedAt: NOW, now: NOW });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.label).toMatch(/\(400\)$/);
    // The plain sentence a chat turn would read, never the raw error.
    expect(a.reason).toMatch(/trying again would fail in exactly the same way/);
    expect(failureShape('Timeout after 30000 ms for 3f2b1c9d-1111-2222-3333-444455556666')).toBe('Timeout after # ms for <id>');
  });

  it('never throws on an empty error', () => {
    expect(failureCause({ lastError: null, diedAt: NOW, now: NOW }).label).toBe('Failed without an error');
  });
});

describe('groupFailures', () => {
  it('groups by cause, counts, names the agents most-hit first, and orders the newest group first', () => {
    const groups = groupFailures([
      job('1', QUOTA, 'postie', DAY * 2),
      job('2', SIG, 'ledger', DAY * 1.1),
      job('3', SIG, 'postie', DAY * 1.3),
      job('4', SIG, 'postie', DAY * 1.5),
      job('5', QUOTA, 'postie', DAY * 1.9),
    ], NOW);
    expect(groups.map((g) => [g.label, g.count])).toEqual([['Gemini thought_signature (400)', 3], ['Gemini quota (429)', 2]]);
    expect(groups[0]!.agentIds).toEqual(['postie', 'ledger']);
    expect(groups[0]!.jobs.map((j) => j.job.id)).toEqual(['2', '3', '4']);
    expect(groups[0]!.lastAt.getTime()).toBe(NOW.getTime() - DAY * 1.1);
  });

  it('is worth retrying only if every job in it says so', () => {
    const [g] = groupFailures([job('1', QUOTA, null, DAY * 3), job('2', QUOTA, null, 60_000)], NOW);
    expect(g!.likelyFixed).toBe(false);
  });
});
