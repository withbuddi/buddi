/**
 * The gate, tested without a database and without a model — which is the whole
 * reason it is a pure function (docs/email.md §5).
 */
import { describe, expect, it } from 'vitest';
import {
  applyPolicies,
  isLive,
  matches,
  type PolicyAction,
  type PolicyRecord,
  type PolicyScope,
} from './gate.js';
import { normalizeMatcher, refusalFor } from './store.js';

let seq = 0;

function policy(over: Partial<PolicyRecord> & { scope: PolicyScope; matcher: string }): PolicyRecord {
  seq += 1;
  return {
    id: `p${seq}`,
    accountId: null,
    action: 'ignore' as PolicyAction,
    params: {},
    origin: 'owner',
    proposed: false,
    createdFrom: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

const header = {
  threadKey: '<root@example.test>',
  from: 'news@mail.example.com',
  listId: '<weekly.example.com>',
};

describe('precedence', () => {
  it('prefers the thread over the sender, the sender over the list, the list over the domain', () => {
    const thread = policy({ scope: 'thread', matcher: '<root@example.test>', action: 'wake' });
    const sender = policy({ scope: 'sender', matcher: 'news@mail.example.com', action: 'notify' });
    const list = policy({ scope: 'list-id', matcher: 'weekly.example.com', action: 'draft' });
    const domain = policy({ scope: 'domain', matcher: 'mail.example.com', action: 'ignore' });
    const all = [domain, list, sender, thread];

    expect(applyPolicies(header, all).policy?.id).toBe(thread.id);
    expect(applyPolicies(header, [domain, list, sender]).policy?.id).toBe(sender.id);
    expect(applyPolicies(header, [domain, list]).policy?.id).toBe(list.id);
    expect(applyPolicies(header, [domain]).policy?.id).toBe(domain.id);
  });

  it('takes the newest policy when two share a scope', () => {
    const older = policy({ scope: 'sender', matcher: 'news@mail.example.com', action: 'wake', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = policy({ scope: 'sender', matcher: 'news@mail.example.com', action: 'ignore', createdAt: '2026-06-01T00:00:00.000Z' });
    expect(applyPolicies(header, [older, newer]).action).toBe('ignore');
  });

  it('decides nothing when nothing matches', () => {
    const decision = applyPolicies(header, [policy({ scope: 'sender', matcher: 'someone@else.test' })]);
    expect(decision.action).toBe('none');
    expect(decision.policy).toBeNull();
    expect(decision.detail).toMatch(/No policy matched/);
  });
});

describe('what is live', () => {
  it('skips a revoked policy', () => {
    const p = policy({ scope: 'sender', matcher: 'news@mail.example.com', revokedAt: '2026-09-02T00:00:00.000Z' });
    expect(isLive(p)).toBe(false);
    expect(applyPolicies(header, [p]).action).toBe('none');
  });

  it('skips a proposal — a learned suggestion decides nothing until it is kept', () => {
    const p = policy({ scope: 'sender', matcher: 'news@mail.example.com', origin: 'learned', proposed: true });
    expect(applyPolicies(header, [p]).action).toBe('none');
    expect(applyPolicies(header, [{ ...p, proposed: false }]).action).toBe('ignore');
  });

  it('skips a policy scoped to another account', () => {
    const p = policy({ scope: 'sender', matcher: 'news@mail.example.com', accountId: 'a1' });
    expect(applyPolicies({ ...header, accountId: 'a2' }, [p]).action).toBe('none');
    expect(applyPolicies({ ...header, accountId: 'a1' }, [p]).action).toBe('ignore');
  });
});

describe('matching', () => {
  it('matches a sender by mailbox, so a plus-tag or a capital cannot walk past it', () => {
    const p = policy({ scope: 'sender', matcher: 'jane@gmail.com' });
    expect(matches(p, { threadKey: null, from: 'Jane <JANE+news@gmail.com>' })).toBe(true);
    expect(matches(p, { threadKey: null, from: 'j.a.n.e@googlemail.com' })).toBe(true);
    expect(matches(p, { threadKey: null, from: 'jane@other.test' })).toBe(false);
  });

  it('matches a domain on the sender, with or without the @', () => {
    const p = policy({ scope: 'domain', matcher: 'example.com' });
    expect(matches(p, { threadKey: null, from: 'anyone@example.com' })).toBe(true);
    // A subdomain is a different domain; matching it would silence too much.
    expect(matches(p, { threadKey: null, from: 'anyone@mail.example.com' })).toBe(false);
  });

  it('matches a List-Id by its identifier, not by the phrase in front of it', () => {
    const p = policy({ scope: 'list-id', matcher: 'Weekly News <weekly.example.com>' });
    expect(matches(p, { threadKey: null, from: 'x@y.test', listId: '<weekly.example.com>' })).toBe(true);
    expect(matches(p, { threadKey: null, from: 'x@y.test', listId: null })).toBe(false);
  });

  it('never matches on an empty matcher', () => {
    expect(matches(policy({ scope: 'sender', matcher: '   ' }), header)).toBe(false);
  });
});

describe('every action', () => {
  const cases: Array<[PolicyAction, RegExp]> = [
    ['ignore', /Ignored by policy/],
    ['notify', /line to the owner/],
    ['draft', /draft reply/],
    ['hand-to-agent', /handed the message/],
    ['wake', /usual triage run/],
  ];
  for (const [action, detail] of cases) {
    it(`carries ${action} through with a line saying so`, () => {
      const decision = applyPolicies(header, [
        policy({ scope: 'sender', matcher: 'news@mail.example.com', action, params: { agentId: 'finance' } }),
      ]);
      expect(decision.action).toBe(action);
      expect(decision.refused).toBe(false);
      expect(decision.detail).toMatch(detail);
    });
  }

  for (const action of ['archive', 'label'] as PolicyAction[]) {
    it(`refuses ${action}, because this build only ever reads the mailbox`, () => {
      const decision = applyPolicies(header, [
        policy({ scope: 'sender', matcher: 'news@mail.example.com', action }),
      ]);
      expect(decision.refused).toBe(true);
      expect(decision.detail).toMatch(/cannot do yet/);
    });

    it(`refuses to create a ${action} policy at all, with "not yet"`, () => {
      expect(refusalFor({ scope: 'sender', matcher: 'a@b.test', action })).toMatch(/^not yet/);
    });
  }
});

describe('validation at creation', () => {
  it('normalises what it stores', () => {
    expect(normalizeMatcher('sender', 'Jane Doe <Jane@Example.COM>')).toBe('jane@example.com');
    expect(normalizeMatcher('domain', '@Example.com')).toBe('example.com');
    expect(normalizeMatcher('domain', 'someone@example.com')).toBe('example.com');
    expect(normalizeMatcher('list-id', 'News <weekly.EXAMPLE.com>')).toBe('weekly.example.com');
  });

  it('refuses a sender without an address and a domain without a dot', () => {
    expect(refusalFor({ scope: 'sender', matcher: 'jane', action: 'ignore' })).toMatch(/needs an address/);
    expect(refusalFor({ scope: 'domain', matcher: 'localhost', action: 'ignore' })).toMatch(/needs a domain/);
    expect(refusalFor({ scope: 'sender', matcher: '  ', action: 'ignore' })).toMatch(/not a sender/);
  });

  it('refuses hand-to-agent with nobody named', () => {
    expect(refusalFor({ scope: 'sender', matcher: 'a@b.test', action: 'hand-to-agent' })).toMatch(/needs the id/);
    expect(
      refusalFor({ scope: 'sender', matcher: 'a@b.test', action: 'hand-to-agent', params: { agentId: 'finance' } }),
    ).toBeNull();
  });
});
