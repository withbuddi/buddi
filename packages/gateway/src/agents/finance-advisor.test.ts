import { manifest as financeManifest } from '@buddi/tool-finance';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_TOOL,
  buildSystemPromptTemplate,
  createFinanceAdvisor,
  DEFAULT_MODEL,
  FINANCE_TOOLS,
  injectToday,
  LIABILITY_TOOLS,
  providerFromEnv,
  SYSTEM_PROMPT_TEMPLATE,
} from './finance-advisor.js';

describe('providerFromEnv', () => {
  it('chooses the subscription token when one is set', () => {
    const ref = providerFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xyz' });
    expect(ref.kind).toBe('anthropic');
    expect(ref.credential).toEqual({
      kind: 'subscription-token',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
    expect(ref.model).toBe(DEFAULT_MODEL);
  });

  it('falls back to the api key when no subscription token is set', () => {
    const ref = providerFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api03-xyz' });
    expect(ref.credential).toEqual({ kind: 'api-key', env: 'ANTHROPIC_API_KEY' });
  });

  it('treats an empty subscription token as not set', () => {
    const ref = providerFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '   ' });
    expect(ref.credential.kind).toBe('api-key');
  });

  it('names an env var, never the secret itself', () => {
    const ref = providerFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret' });
    expect(JSON.stringify(ref)).not.toContain('secret');
  });

  it('honours BUDDI_MODEL', () => {
    const ref = providerFromEnv({ ANTHROPIC_API_KEY: 'k', BUDDI_MODEL: 'claude-opus-4-1' });
    expect(ref.model).toBe('claude-opus-4-1');
  });
});

describe('system prompt date injection', () => {
  it('replaces every {{today}} placeholder', () => {
    expect(injectToday('a {{today}} b {{today}}', '2026-09-13')).toBe(
      'a 2026-09-13 b 2026-09-13',
    );
  });

  it('leaves a template without the placeholder alone', () => {
    expect(injectToday('no placeholder', '2026-09-13')).toBe('no placeholder');
  });

  it('injects the run clock date into the agent definition', () => {
    const agent = createFinanceAdvisor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      now: new Date('2026-09-13T21:45:00Z'),
    });
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('{{today}}');
    expect(agent.systemPrompt).toContain('Today is 2026-09-13.');
    expect(agent.systemPrompt).not.toContain('{{today}}');
  });
});

describe('agent definition', () => {
  it('is pinned and wired to the finance tools', () => {
    const agent = createFinanceAdvisor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      now: new Date('2026-09-13T00:00:00Z'),
    });
    expect(agent.id).toBe('finance-advisor');
    expect(agent.name).toBe('Finance Advisor');
    expect(agent.maxTurns).toBe(12);
    expect(agent.tools).toEqual(FINANCE_TOOLS);
    expect(agent.tools).toContain('finance.project_cashflow');
    expect(agent.tools.every((t) => t.startsWith('finance.'))).toBe(true);
  });
});

describe('system prompt content', () => {
  it('mirrors the owner language strictly, with no self-directed switching', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain(
      "Reply in the language the owner's latest message is written in. English message → English reply. French → French. Never switch language on your own.",
    );
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('if the owner writes French, reply in French');
  });

  it('requires the minimum balance, its date and the floor in every verdict', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('minBalance, minBalanceDate');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('whether the safety floor is breached');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('no safety floor is set');
  });

  it('describes the Status overview', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('the total cash across accounts');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('next 14 days');
  });

  it('lists every cash account individually in a status', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('every cash account individually');
  });

  it('forbids markdown when the surface hint says plain text', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('Plain text when the surface says so');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('NO markdown of any kind');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('**bold**');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('no # headings');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('no backticks or code fences');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('never a pipe table');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('CAPITALS or a plain word followed by a colon');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('- "');
  });

  it('forbids naming internal tools to the owner', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('Never name your tools');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('The owner never hears an internal tool name');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('want me to set a safety floor?');
    // the old phrasing handed the owner a tool name for the floor
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('offer to set one with finance.set_preferences');
  });

  it('keeps the plain-text and tool-name rules whatever the manifest ships', () => {
    for (const prompt of [
      buildSystemPromptTemplate(['finance.project_cashflow']),
      buildSystemPromptTemplate([...FINANCE_TOOLS, BASELINE_TOOL, ...LIABILITY_TOOLS]),
    ]) {
      expect(prompt).toContain('NO markdown of any kind');
      expect(prompt).toContain('Never name your tools');
    }
  });
});

describe('optional tool families', () => {
  const withAll = buildSystemPromptTemplate([
    ...FINANCE_TOOLS,
    BASELINE_TOOL,
    ...LIABILITY_TOOLS,
  ]);

  it('only mentions the spending baseline when the manifest ships it', () => {
    expect(withAll).toContain(BASELINE_TOOL);
    expect(withAll).toContain('includes typical variable spending');
    expect(withAll).toContain('includeBaseline:false');
    expect(withAll).toContain("includeP2P:'net'");
    expect(buildSystemPromptTemplate(['finance.project_cashflow'])).not.toContain(BASELINE_TOOL);
  });

  it('only mentions liabilities when the manifest ships them', () => {
    for (const name of LIABILITY_TOOLS) expect(withAll).toContain(name);
    expect(withAll).toContain('Never add a liability balance to a cash total');
    expect(withAll).toContain('net worth');
    const bare = buildSystemPromptTemplate(['finance.project_cashflow']);
    for (const name of LIABILITY_TOOLS) expect(bare).not.toContain(name);
    expect(bare).not.toContain('net worth');
  });

  it('requires every liability listed individually in a status', () => {
    expect(withAll).toContain('list EVERY liability individually');
    expect(withAll).toContain(
      'its name, its balance, its APR, its minimum payment and the day of the month it is due',
    );
    expect(withAll).toContain('Never collapse several debts into a single figure');
    expect(withAll).toContain('total debt and the net worth');
  });

  it('keeps the language rule last whatever the manifest ships', () => {
    for (const prompt of [withAll, buildSystemPromptTemplate(['finance.project_cashflow'])]) {
      expect(prompt).toContain('Never switch language on your own.');
      expect(prompt).toContain('{{today}}');
    }
  });

  it('never hardcodes how many finance tools there are', () => {
    const agent = createFinanceAdvisor({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 't' },
      now: new Date('2026-09-13T00:00:00Z'),
    });
    expect(agent.tools).toEqual(FINANCE_TOOLS);
    expect(agent.tools.length).toBe(
      financeManifest.tools.filter((t) => t.name.startsWith('finance.')).length,
    );
  });
});
