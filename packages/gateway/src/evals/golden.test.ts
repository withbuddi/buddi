import { describe, expect, it } from 'vitest';
import {
  agentFor,
  casesFor,
  GOLDEN_CASES,
  minutesOf,
  oneCalendarManifest,
  OPENAI_AGENT,
  parseEvalArgs,
  PROFILE_CASE_NAME,
  stubbed,
} from './golden.js';

describe('parseEvalArgs', () => {
  it('defaults to the anthropic set', () => {
    expect(parseEvalArgs([])).toEqual({ provider: 'anthropic', only: new Set() });
  });

  it('takes --provider in both spellings, and bare case ids', () => {
    expect(parseEvalArgs(['--provider', 'openai']).provider).toBe('openai');
    expect(parseEvalArgs(['--provider=openai']).provider).toBe('openai');
    expect([...parseEvalArgs(['--', 'no-tool-names-leak']).only]).toEqual([
      'no-tool-names-leak',
    ]);
  });

  it('refuses a provider this build has no adapter for', () => {
    expect(() => parseEvalArgs(['--provider', 'gemini'])).toThrow(/anthropic, openai/);
    expect(() => parseEvalArgs(['--wat'])).toThrow(/unknown option/);
  });
});

describe('selecting cases per provider', () => {
  it('runs the whole finance set on anthropic', () => {
    const { run, skipped } = casesFor('anthropic');
    expect(run.length).toBeGreaterThan(5);
    expect(run.every((c) => (c.providers ?? ['anthropic']).includes('anthropic'))).toBe(true);
    // The scout-only case is skipped here, and said so rather than counted.
    expect(skipped.map((s) => s.id)).toContain('scout-names-its-provider-and-its-limits');
  });

  it('skips every finance case on openai and says why', () => {
    const { run, skipped } = casesFor('openai');
    expect(run.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);
    for (const entry of skipped) {
      expect(entry.why).toMatch(/finance tools/);
      expect(entry.why).toContain(OPENAI_AGENT);
    }
    // Nothing is both run and skipped, and nothing is dropped on the floor.
    expect(run.length + skipped.length).toBe(GOLDEN_CASES.length);
  });

  it('routes the cases that do run to the agent pinned to that provider', () => {
    const financeCase = GOLDEN_CASES.find((c) => c.id === 'no-tool-names-leak');
    expect(financeCase).toBeDefined();
    expect(agentFor(financeCase!, 'anthropic')).toBe('finance-advisor');
    expect(agentFor(financeCase!, 'openai')).toBe(OPENAI_AGENT);
  });

  it('gives every case a unique id', () => {
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(GOLDEN_CASES.length);
  });
});

describe('the browser cases', () => {
  it('pin the paired and unpaired browser, and answer stubbed tools without running them', async () => {
    const paired = GOLDEN_CASES.find((c) => c.id === 'website-question-tries-the-browser');
    const unpaired = GOLDEN_CASES.find((c) => c.id === 'website-question-without-a-browser-offers-pairing');
    expect(paired?.stubs?.['browser.status']).toMatchObject({ mode: 'extension', enabled: true });
    expect(unpaired?.stubs?.['browser.status']).toMatchObject({ enabled: false });
    expect(paired?.tools?.(['finance.list_accounts', 'agent.delegate'])).toEqual(['agent.delegate', 'browser.status', 'browser.act']);
    const real = { invoke: async (name: string) => `ran ${name}`, list: () => ['x'] };
    const wrapped = stubbed(real, { 'browser.status': { enabled: true } });
    await expect(wrapped.invoke('browser.status')).resolves.toEqual({ enabled: true });
    await expect(wrapped.invoke('memory.recall')).resolves.toBe('ran memory.recall');
    expect(wrapped.list()).toEqual(['x']);
  });

  it('fail "no access" and pass a browser look or a delegation', () => {
    const paired = GOLDEN_CASES.find((c) => c.id === 'website-question-tries-the-browser')!;
    const turn = (text: string, calls: Array<{ name: string; input: unknown }>) => [{ question: 'q', text, calls, inputTokens: 0, outputTokens: 0 }];
    expect(paired.check(turn('I have no access to your Amazon account. Open the Amazon app yourself.', [{ name: 'email.search', input: {} }]))).toHaveLength(3);
    expect(paired.check(turn('Approve the browser card and I will look.', [{ name: 'browser.act', input: {} }]))).toEqual([]);
    expect(paired.check(turn('@ledger says…', [{ name: 'agent.delegate', input: {} }]))).toEqual([]);
  });
});

describe('the one-writable-calendar case', () => {
  const theCase = GOLDEN_CASES.find((c) => c.id === 'one-writable-calendar-is-taken')!;
  const turn = (text: string, calls: Array<{ name: string; input: unknown }>) => [{ question: 'q', text, calls, inputTokens: 0, outputTokens: 0 }];

  it('passes the approval card on Home with 2 hours stated, and fails asking which calendar', () => {
    const create = { name: 'calendar.create_event', input: { calendar: 'Home', title: 'Dinner with Marion', start: '2026-09-13T19:30', duration: 120, location: 'Chez Léon' } };
    expect(theCase.check(turn('Dinner with Marion at Chez Léon, 19:30 for 2 hours, on your Home calendar — approve the card to add it.', [create]))).toEqual([]);
    expect(theCase.check(turn('Which calendar should I use: Home or Holidays?', []))).toHaveLength(3);
    const hour = { ...create, input: { ...create.input, duration: 60 } };
    expect(theCase.check(turn('Added for an hour on Home.', [hour]))).toHaveLength(2);
  });

  it('reads a duration from either form, and its stand-in refuses a calendar that is not Home', async () => {
    expect(minutesOf({ start: '2026-09-13T19:30', end: '2026-09-13T21:30' })).toBe(120);
    expect(minutesOf({ duration: 90 })).toBe(90);
    expect(minutesOf(undefined)).toBeNull();
    const create = oneCalendarManifest().tools.find((t) => t.name === 'calendar.create_event')!;
    await expect(create.execute({ calendar: 'Holidays' } as never, {} as never)).resolves.toMatchObject({ refused: expect.stringContaining('Agents may change: Home') });
    await expect(create.execute({ calendar: 'home' } as never, {} as never)).resolves.toMatchObject({ pending: true });
  });
});

describe('the one-writable-field case', () => {
  const theCase = GOLDEN_CASES.find((c) => c.id === 'one-writable-field-asked-once')!;
  const turn = (text: string, calls: Array<{ name: string; input: unknown }> = []) => ({ question: 'q', text, calls, inputTokens: 0, outputTokens: 0 });
  const set = { name: 'owner.set_profile', input: { fullName: PROFILE_CASE_NAME } };

  it('runs on the front desk with an owner who has a name but no full name', () => {
    expect(theCase.agent).toBe('concierge');
    expect(theCase.seed?.join(' ')).toContain('full_name = null');
    expect(theCase.turns).toHaveLength(3);
  });

  it('passes one question, the answer recorded, and no second ask', () => {
    expect(theCase.check([
      turn('Happy to. What full name should I sign it with?'),
      turn(`Dear landlord, ... Best regards, ${PROFILE_CASE_NAME}`, [set]),
      turn(`Dear bank, ... ${PROFILE_CASE_NAME}`),
    ])).toEqual([]);
  });

  it('fails a list of questions, an invented name, and asking again', () => {
    const fails = theCase.check([
      turn("What is your full name? And your address? And the landlord's name?", [{ name: 'owner.set_profile', input: { fullName: 'Sam' } }]),
      turn('Here it is, signed Sam.'),
      turn('What full name should I use?'),
    ]);
    expect(fails).toEqual(expect.arrayContaining([
      'asked more than one question at once',
      'recorded a full name the owner had not said',
      'never recorded the full name once the owner said it',
      'asked for the full name a second time',
    ]));
  });
});
