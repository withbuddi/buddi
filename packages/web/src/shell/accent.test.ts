import { afterEach, expect, it } from 'vitest';
import { AGENT_PALETTE, accentAttrs, accentOf, rememberDefaultAgent } from './accent';

afterEach(() => rememberDefaultAgent(null));

it("wears the agent file's own accent before anything else", () => {
  expect(accentOf({ id: 'x', accent: '#E06C3F', roles: ['developer'] })).toEqual({ key: 'own', hex: '#e06c3f' });
  expect(accentAttrs({ key: 'own', hex: '#e06c3f' })).toEqual({ 'data-agent': 'own', style: { '--agent-fill': '#e06c3f' } });
});

it('reads the colour from a role that names one, and skips surface roles', () => {
  expect(accentOf({ id: 'a', roles: ['developer'] })).toEqual({ key: 'coding' });
  expect(accentOf({ id: 'b', roles: ['overview', 'recap', 'credit'] })).toEqual({ key: 'finance' });
  expect(accentOf({ id: 'c', roles: ['front-desk'] })).toEqual({ key: 'buddi' });
});

it('gives the default agent Buddi blue, and everyone else a stable palette entry', () => {
  rememberDefaultAgent('concierge');
  expect(accentOf({ id: 'concierge' })).toEqual({ key: 'buddi' });
  const first = accentOf({ id: 'garage' });
  expect(first).toEqual(accentOf({ id: 'garage' }));
  expect(AGENT_PALETTE).toContain((first as { key: string }).key);
});

/** A granted tool name, built from its family so no plugin tool is spelled out here. */
const grant = (family: string, name = 'run'): string => [family, name].join('.');

it('reads the colour from the granted tool families when no role names one', () => {
  expect(accentOf({ id: 'm', roles: [], tools: [grant('email', 'search'), grant('browser'), grant('memory')] })).toEqual({ key: 'mail' });
  expect(accentOf({ id: 'f', tools: [grant('web'), grant('finance', 'balances')] })).toEqual({ key: 'finance' });
  expect(accentOf({ id: 'd', tools: [grant('developer', 'read'), grant('memory')] })).toEqual({ key: 'coding' });
  expect(accentOf({ id: 'r', tools: [grant('web', 'search'), grant('host')] })).toEqual({ key: 'research' });
  expect(accentOf({ id: 'b', tools: [grant('browser', 'act')] })).toEqual({ key: 'research' });
  expect(accentOf({ id: 'i', tools: [grant('image', 'generate'), grant('memory')] })).toEqual({ key: 'art' });
  expect(accentOf({ id: 'k', tools: [grant('memory', 'remember'), grant('memory', 'recall')] })).toEqual({ key: 'memory' });
});

it('ranks the families most specific first', () => {
  expect(accentOf({ id: 'x', tools: [grant('image'), grant('web'), grant('developer'), grant('finance'), grant('email')] })).toEqual({ key: 'mail' });
  expect(accentOf({ id: 'x', tools: [grant('image'), grant('web'), grant('developer'), grant('finance')] })).toEqual({ key: 'finance' });
  expect(accentOf({ id: 'x', tools: [grant('image'), grant('web'), grant('developer')] })).toEqual({ key: 'coding' });
  expect(accentOf({ id: 'x', tools: [grant('image'), grant('browser')] })).toEqual({ key: 'research' });
});

it('keeps the order: own accent, then role, then tools, then the default agent, then the hash', () => {
  rememberDefaultAgent('front');
  expect(accentOf({ id: 'y', accent: '#112233', roles: ['developer'], tools: [grant('email')] })).toEqual({ key: 'own', hex: '#112233' });
  expect(accentOf({ id: 'y', roles: ['developer'], tools: [grant('email')] })).toEqual({ key: 'coding' });
  expect(accentOf({ id: 'front', tools: [grant('web')] })).toEqual({ key: 'research' });
  expect(accentOf({ id: 'front', tools: [grant('host'), grant('memory'), grant('reminder')] })).toEqual({ key: 'buddi' });
  // Memory alongside anything else names nothing; the hash decides.
  const hashed = accentOf({ id: 'garage', tools: [grant('host'), grant('memory')] });
  expect(hashed).toEqual(accentOf({ id: 'garage' }));
});
