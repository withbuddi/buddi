import { DEFAULT_MODEL } from '@buddi/core';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import { createReminderManifest, createScheduleManifest } from '../missions/reminders.js';
import { describe, expect, it } from 'vitest';
import {
  createFinanceAdvisor,
  FINANCE_TOOLS,
  injectToday,
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

  it('lets an agent file pin a model over BUDDI_MODEL', () => {
    const ref = providerFromEnv({ BUDDI_MODEL: 'claude-opus-4-1' }, 'claude-haiku-4-5');
    expect(ref.model).toBe('claude-haiku-4-5');
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
    expect(agent.tools).toContain('memory.note');
    expect(agent.tools).toContain('agent.delegate');
    expect(
      agent.tools.every(
        (t) =>
          t.startsWith('finance.') ||
          t.startsWith('memory.') ||
          t.startsWith('artifacts.') ||
          t.startsWith('reminder.') ||
          t.startsWith('schedule.') ||
          t === 'agent.delegate',
      ),
    ).toBe(true);
  });

  it('never hardcodes how many tools there are', () => {
    expect(FINANCE_TOOLS.length).toBe(
      financeManifest.tools.length +
        memoryManifest.tools.length +
        artifactsManifest.tools.length +
        createReminderManifest().tools.length +
        createScheduleManifest().tools.length +
        1, // + agent.delegate
    );
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
  });

  it('forbids naming internal tools to the owner', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('Never name your tools');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('The owner never hears an internal tool name');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('want me to set a safety floor?');
    expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('offer to set one with finance.set_preferences');
  });

  it('keeps the spending-baseline guidance the manifest ships', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('finance.spending_baseline');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('includes typical variable spending');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('includeBaseline:false');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain("includeP2P:'net'");
  });

  it('keeps the liability rules, including the itemised status', () => {
    for (const name of [
      'finance.set_liability',
      'finance.list_liabilities',
      'finance.remove_liability',
      'finance.payoff_estimate',
    ]) {
      expect(SYSTEM_PROMPT_TEMPLATE).toContain(name);
      expect(FINANCE_TOOLS).toContain(name);
    }
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('Never add a liability balance to a cash total');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('list EVERY liability individually');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain(
      'its name, its balance, its APR, its minimum payment and the day of the month it is due',
    );
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('Never collapse several debts into a single figure');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('total debt and the net worth');
  });

  it('ends with the generated wiring section listing the resolved tools', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('## Your wiring (generated, authoritative)');
    expect(SYSTEM_PROMPT_TEMPLATE).toContain(
      `Tools available to you in this installation: ${FINANCE_TOOLS.join(', ')}.`,
    );
  });
});
