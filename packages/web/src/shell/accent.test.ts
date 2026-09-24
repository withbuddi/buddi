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
