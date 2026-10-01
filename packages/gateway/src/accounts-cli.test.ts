import { describe, expect, it } from 'vitest';
import { accountLines, parseAccountsArgs, renderAccount, renderAccountLines, stateText, type ViewAccount } from './accounts-cli.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const SECRET = 'sk-SEEDED-SECRET-1234';

/** The view as the dashboard gets it, with the kind of fields this command must never print. */
const view = {
  accounts: [
    {
      id: '6b2f9c1e-0d4a-4f7e-9a51-3c8e2d7b4a10', label: 'Gemini free', kind: 'openai-compatible', auth: 'api-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.5-flash', enabled: true, configured: true,
      assignedAgents: ['finance-advisor'],
      rateLimit: { scope: 'day', until: '2026-10-01T14:20:00.000Z', limit: 20, unit: 'requests', freeTier: true, provider: 'Gemini', model: 'gemini-2.5-flash' },
      secretRef: 'PROVIDER_ACCOUNT_X', token: SECRET, login: { code: SECRET },
    },
    {
      id: 'claude-1', label: 'Work Claude', kind: 'anthropic', auth: 'anthropic-oauth', baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-5', enabled: true, configured: true, assignedAgents: [], refreshToken: SECRET,
    },
    { id: 'off-1', label: 'Old key', kind: 'openai', auth: 'api-key', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5', enabled: false, configured: true, assignedAgents: [] },
  ] as unknown as ViewAccount[],
  bindings: [{ agentId: 'finance-advisor', accountId: '6b2f9c1e-0d4a-4f7e-9a51-3c8e2d7b4a10', model: 'gemini-2.5-flash' }],
};

describe('buddi accounts', () => {
  const lines = accountLines(view, (id) => (id === 'finance-advisor' ? 'ledger' : null), NOW);

  it('lists id, provider, model, state and agents', () => {
    expect(lines[0]).toMatchObject({ id: '6b2f9c1e-0d4a-4f7e-9a51-3c8e2d7b4a10', provider: 'Gemini', state: 'rate-limited', agents: [{ id: 'finance-advisor', handle: 'ledger', model: 'gemini-2.5-flash' }] });
    expect(lines[1]).toMatchObject({ provider: 'Claude subscription', state: 'ready', rateLimit: null });
    expect(lines[2]?.state).toBe('disabled');
  });

  it('says a rate limit in plain words with its reset', () => {
    expect(stateText(lines[0]!, 'UTC', new Date(NOW))).toBe('rate-limited until 14:20 · free tier, 20 requests a day');
  });

  it('never prints a key, a token or a vault name — as text or as JSON', () => {
    const text = renderAccountLines(lines, { color: false }, 'UTC', new Date(NOW));
    const json = JSON.stringify(lines);
    const shown = renderAccount(lines[0]!, { baseUrl: view.accounts[0]!.baseUrl ?? null, contextWindowTokens: null, test: null }, { color: false }, 'UTC', new Date(NOW));
    for (const out of [text, json, shown]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain('PROVIDER_ACCOUNT_X');
    }
    expect(text).toContain('6b2f9c1e-0d4a-4f7e-9a51-3c8e2d7b4a10');
    expect(text).toContain('@ledger');
    expect(shown).toContain('buddi agents set <handle> --account 6b2f9c1e-0d4a-4f7e-9a51-3c8e2d7b4a10');
  });

  it('parses list, show and --json', () => {
    expect(parseAccountsArgs([])).toEqual({ action: 'list', json: false });
    expect(parseAccountsArgs(['list', '--json'])).toEqual({ action: 'list', json: true });
    expect(parseAccountsArgs(['show', 'abc'])).toEqual({ action: 'show', id: 'abc', json: false });
    expect(() => parseAccountsArgs(['show'])).toThrow(/needs one account/);
    expect(() => parseAccountsArgs(['add'])).toThrow(/not a command/);
  });
});
