/**
 * The thread's order, its resume rule, and what "change" keeps.
 *
 * Every one of these is a property of the screen a person sees, decided here
 * where it can be read: four questions and a handover, a reload landing on the
 * first unanswered one, and a change that reopens one question without
 * throwing away the answers that followed it.
 */
import { describe, expect, it } from 'vitest';
import type { OnboardingView, OwnerView, ProviderAccountsView } from '../../api';
import {
  QUESTIONS,
  answered,
  answersFrom,
  firstOpen,
  idFor,
  keyKind,
  reopen,
  suggestedName,
  thread,
} from './machine';
import { SUGGESTED_NAMES } from './script';

const onboarding = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  state: 'pending',
  stepsDone: [],
  needs: { owner: true, model: true, agent: true },
  ...over,
});

const owner = (over: Partial<OwnerView> = {}): OwnerView => ({
  preferredName: null,
  timezone: null,
  language: null,
  about: null,
  displayName: null,
  detectedTimezone: 'UTC',
  zones: ['UTC', 'America/New_York'],
  ...over,
});

const accounts = (list: Array<Partial<ProviderAccountsView['accounts'][number]>>): ProviderAccountsView => ({
  vault: { kind: 'file', locked: false, advice: '' },
  bindings: [],
  accounts: list.map((account, at) => ({
    id: `a${at}`,
    label: 'Anthropic',
    kind: 'anthropic',
    auth: 'api-key',
    baseUrl: '',
    defaultModel: 'claude-sonnet-5',
    enabled: true,
    revision: 1,
    configured: true,
    refreshable: false,
    tokenExpiresAt: null,
    subscriptionRenewsAt: null,
    assignedAgents: [],
    test: null,
    ...account,
  })) as ProviderAccountsView['accounts'],
});

describe('the questions', () => {
  it('asks four things and then hands over, in that order', () => {
    expect([...QUESTIONS]).toEqual(['name', 'clock', 'brain', 'assistant', 'handover']);
  });

  it('draws every answered question above the open one, and nothing below it', () => {
    const answers = { name: 'Amen', clock: 'America/New_York' };
    expect(thread(answers, 'brain')).toEqual(['name', 'clock', 'brain']);
    expect(thread({}, 'name')).toEqual(['name']);
  });
});

describe('resume', () => {
  it('replays the profile, the account and the agent the server already has', () => {
    const answers = answersFrom({
      onboarding: onboarding({ needs: { owner: false, model: false, agent: false } }),
      owner: owner({ preferredName: 'Amen', timezone: 'America/New_York' }),
      accounts: accounts([{ id: 'one', label: 'Ollama', defaultModel: 'qwen3:4b' }]),
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    });
    expect(answers.name).toBe('Amen');
    expect(answers.clock).toBe('America/New_York');
    expect(answers.brain).toEqual({ accountId: 'one', label: 'Ollama', model: 'qwen3:4b' });
    expect(answers.assistant).toEqual({ id: 'ada', name: 'Ada', avatar: '📚' });
    expect(firstOpen(answers)).toBe('handover');
  });

  it('asks the first question nobody has answered', () => {
    expect(firstOpen(answersFrom({}))).toBe('name');
    expect(firstOpen(answersFrom({ owner: owner({ preferredName: 'Amen' }) }))).toBe('clock');
    expect(
      firstOpen(answersFrom({ owner: owner({ preferredName: 'Amen', timezone: 'UTC' }) })),
    ).toBe('brain');
  });

  it('counts no account the installation could not run on', () => {
    for (const broken of [{ enabled: false }, { configured: false }, { removalPending: true }]) {
      const answers = answersFrom({ owner: owner({ preferredName: 'A', timezone: 'UTC' }), accounts: accounts([broken]) });
      expect(answered(answers, 'brain')).toBe(false);
      expect(firstOpen(answers)).toBe('brain');
    }
  });

  it('does not count an assistant the record says is still missing', () => {
    const answers = answersFrom({
      onboarding: onboarding({ needs: { owner: false, model: false, agent: true } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts([{}]),
      // A shipped example is in the roster; it is not the owner's own.
      assistant: { id: 'concierge', name: 'Concierge', avatar: '' },
    });
    expect(firstOpen(answers)).toBe('assistant');
  });
});

describe('change', () => {
  it('reopens one question and keeps the answers that followed it', () => {
    const answers = {
      name: 'Amen',
      clock: 'UTC',
      brain: { accountId: 'one', label: 'Claude', model: 'claude-sonnet-5' },
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    };
    const changed = reopen(answers, 'brain');
    expect(changed.brain).toBeUndefined();
    expect(changed.assistant).toEqual(answers.assistant);
    expect(changed.name).toBe('Amen');
    // And the open question is the one being changed, not the next gap.
    expect(firstOpen(changed)).toBe('brain');
  });

  it('re-greets when the name changes, and keeps everything else', () => {
    const changed = reopen({ name: 'Amen', clock: 'UTC' }, 'name');
    expect(changed.name).toBeUndefined();
    expect(changed.clock).toBe('UTC');
  });
});

describe('a pasted key', () => {
  it('belongs to Anthropic when it starts sk-ant-, and to OpenAI otherwise', () => {
    expect(keyKind('sk-ant-api03-abc')).toBe('anthropic');
    expect(keyKind('  sk-ant-oat01-abc  ')).toBe('anthropic');
    expect(keyKind('sk-proj-abc')).toBe('openai');
    expect(keyKind('sk-abc')).toBe('openai');
    expect(keyKind('something-else')).toBe('openai');
  });
});

describe('the assistant buddi offers', () => {
  it('rotates through the names rather than repeating one', () => {
    expect(suggestedName(SUGGESTED_NAMES, 0)).toBe('Ada');
    expect(suggestedName(SUGGESTED_NAMES, 1)).toBe('Sam');
    expect(suggestedName(SUGGESTED_NAMES, SUGGESTED_NAMES.length)).toBe('Ada');
  });

  it('files a name the server will accept', () => {
    expect(idFor('Ada')).toBe('ada');
    expect(idFor('Night Desk')).toBe('night-desk');
    expect(idFor('Rémy')).toBe('remy');
    expect(idFor('42')).toBe('assistant');
  });
});
