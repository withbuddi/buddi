/**
 * The gate, tested without a database and without a model — which is the whole
 * reason it is a pure function (docs/specs/email.md §5).
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

const THREAD_ID = '11111111-2222-3333-4444-555555555555';

const header = {
  threadId: THREAD_ID,
  from: 'news@mail.example.com',
  listId: '<weekly.example.com>',
};

describe('precedence', () => {
  it('prefers the thread over the sender, the sender over the list, the list over the domain', () => {
    const thread = policy({ scope: 'thread', matcher: THREAD_ID, action: 'wake' });
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
  it('matches a sender by the exact address — a capital or a display name, nothing more', () => {
    const p = policy({ scope: 'sender', matcher: 'jane@gmail.com' });
    expect(matches(p, { threadId: null, from: 'Jane <JANE@gmail.com>' })).toBe(true);
    expect(matches(p, { threadId: null, from: 'jane@other.test' })).toBe(false);
  });

  it('does not treat a plus-tag or a Gmail dot as the same sender', () => {
    // `mailboxKey` collapses both, for every domain, and exists to answer "is
    // this the owner?". Plenty of providers route `sales+legal@` to a
    // different person than `sales@`, and a rule about one must not silence
    // the other. Two separately stored policies matching one message would
    // also let the newest-wins tie-break pick a rule nobody meant.
    const p = policy({ scope: 'sender', matcher: 'jane@gmail.com' });
    expect(matches(p, { threadId: null, from: 'jane+news@gmail.com' })).toBe(false);
    expect(matches(p, { threadId: null, from: 'j.a.n.e@googlemail.com' })).toBe(false);
  });

  it('matches a domain on the sender, with or without the @', () => {
    const p = policy({ scope: 'domain', matcher: 'example.com' });
    expect(matches(p, { threadId: null, from: 'anyone@example.com' })).toBe(true);
    // A subdomain is a different domain; matching it would silence too much.
    expect(matches(p, { threadId: null, from: 'anyone@mail.example.com' })).toBe(false);
  });

  it('matches a List-Id by its identifier, not by the phrase in front of it', () => {
    const p = policy({ scope: 'list-id', matcher: 'Weekly News <weekly.example.com>' });
    expect(matches(p, { threadId: null, from: 'x@y.test', listId: '<weekly.example.com>' })).toBe(true);
    expect(matches(p, { threadId: null, from: 'x@y.test', listId: null })).toBe(false);
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

/*
 * The rule that keeps a sender-written header from producing silence.
 * `gate.ts` states it in full; these are the four cases it has.
 */
describe('a thread or a list may not silence a message on its own', () => {
  const muted = { threadId: THREAD_ID, from: 'stranger@elsewhere.test', listId: '<weekly.example.com>' };

  it('ignores nothing when a thread a stranger wrote into is all there is', () => {
    const thread = policy({ scope: 'thread', matcher: THREAD_ID, action: 'ignore' });
    const decision = applyPolicies(muted, [thread]);
    expect(decision.action).toBe('none');
    expect(decision.policy).toBeNull();
  });

  it('ignores nothing when a public List-Id is all there is', () => {
    const list = policy({ scope: 'list-id', matcher: 'weekly.example.com', action: 'ignore' });
    expect(applyPolicies(muted, [list]).action).toBe('none');
  });

  it('applies when the policy recorded the sender and this is that sender', () => {
    const thread = policy({
      scope: 'thread',
      matcher: THREAD_ID,
      action: 'ignore',
      params: { sender: 'Them <THEM@example.test>' },
    });
    expect(applyPolicies({ ...muted, from: 'them@example.test' }, [thread]).action).toBe('ignore');
    // And for anybody else quoting the same thread, it is not there at all.
    expect(applyPolicies(muted, [thread]).action).toBe('none');
  });

  it('applies when the sender independently matches a live sender or domain ignore', () => {
    const list = policy({ scope: 'list-id', matcher: 'weekly.example.com', action: 'ignore' });
    const domain = policy({ scope: 'domain', matcher: 'elsewhere.test', action: 'ignore' });
    const decision = applyPolicies(muted, [list, domain]);
    expect(decision.action).toBe('ignore');
    expect(decision.policy?.id).toBe(list.id);
  });

  it('does not corroborate from a wake or notify sender/domain rule — that rule wins instead', () => {
    const list = policy({ scope: 'list-id', matcher: 'weekly.example.com', action: 'ignore' });
    const wakeDomain = policy({ scope: 'domain', matcher: 'elsewhere.test', action: 'wake' });
    const decision = applyPolicies(muted, [list, wakeDomain]);
    expect(decision.action).toBe('wake');
    expect(decision.policy?.id).toBe(wakeDomain.id);
  });

  it('leaves every other action alone — only silence is bound to the sender', () => {
    for (const action of ['notify', 'draft', 'wake'] as PolicyAction[]) {
      const thread = policy({ scope: 'thread', matcher: THREAD_ID, action });
      expect(applyPolicies(muted, [thread]).action).toBe(action);
    }
  });

  it('falls through to the next scope rather than swallowing the message', () => {
    const thread = policy({ scope: 'thread', matcher: THREAD_ID, action: 'ignore' });
    const domainWake = policy({ scope: 'domain', matcher: 'elsewhere.test', action: 'wake' });
    // A `wake` domain rule does not corroborate the thread ignore, so the
    // ignore falls through and the domain rule's own action decides instead.
    const alone = applyPolicies({ ...muted, listId: null }, [thread]);
    expect(alone.action).toBe('none');
    expect(applyPolicies({ ...muted, listId: null }, [thread, domainWake]).action).toBe('wake');
  });
});
