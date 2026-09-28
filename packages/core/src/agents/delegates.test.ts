import { describe, expect, it } from 'vitest';
import { delegateScope, DELEGATE_EVERYONE, openDelegationRole, resolveDelegates } from './delegates.js';

const everyone = ['concierge', 'ledger', 'garage', 'scout'];
const desk = { id: 'concierge', roles: ['front-desk'] };
const maker = { id: 'father', roles: ['maker'] };
const ledger = { id: 'ledger', roles: ['overview'] };

describe('delegate allowlist resolution', () => {
  it('opens the front desk and the maker to everyone when they have no list', () => {
    expect(openDelegationRole(desk.roles)).toBe('front-desk');
    expect(openDelegationRole(maker.roles)).toBe('maker');
    expect(delegateScope(desk, undefined)).toEqual({ kind: 'everyone', because: 'front-desk' });
    expect(resolveDelegates(desk, undefined, everyone)).toEqual(['ledger', 'garage', 'scout']);
    expect(resolveDelegates(maker, undefined, everyone)).toEqual(everyone);
  });

  it('lets an explicit list narrow the front desk, an empty one included', () => {
    expect(delegateScope(desk, ['ledger'])).toEqual({ kind: 'list', ids: ['ledger'] });
    expect(resolveDelegates(desk, ['ledger', 'ledger'], everyone)).toEqual(['ledger']);
    expect(resolveDelegates(desk, [], everyone)).toEqual([]);
  });

  it('keeps every other agent on its explicit list, and nobody without one', () => {
    expect(openDelegationRole(ledger.roles)).toBeUndefined();
    expect(resolveDelegates(ledger, undefined, everyone)).toEqual([]);
    expect(resolveDelegates(ledger, ['garage'], everyone)).toEqual(['garage']);
  });

  it('reads "*" as everyone for any agent, and never includes the agent itself', () => {
    expect(delegateScope(ledger, [DELEGATE_EVERYONE])).toEqual({ kind: 'everyone', because: 'list' });
    expect(resolveDelegates(ledger, [DELEGATE_EVERYONE], everyone)).toEqual(['concierge', 'garage', 'scout']);
    expect(delegateScope(desk, [DELEGATE_EVERYONE])).toEqual({ kind: 'everyone', because: 'front-desk' });
  });
});
