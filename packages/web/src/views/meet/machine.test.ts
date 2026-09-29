/**
 * The chapters' order, the resume rule, and what "change" keeps.
 *
 * Every one of these is a property of the screen a person sees, decided here
 * where it can be read: five chapters and a handover, a reload landing on the
 * first unanswered one, and a change that reopens one chapter without
 * throwing away the answers that followed it.
 */
import { describe, expect, it } from 'vitest';
import type { OnboardingView, OwnerView, ProviderAccountsView } from '../../api';
import {
  CHAPTERS,
  RESTORE_FAILURES,
  RESTORE_PHASES,
  afterRestore,
  answered,
  answersFrom,
  firstOpen,
  mapState,
  previous,
  idFor,
  keyKind,
  rememberRestore,
  rememberedRestore,
  reopen,
} from './machine';
import { DEFAULT_ASSISTANT_NAME, SCRIPT } from './script';

const onboarding = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  state: 'pending',
  stepsDone: [],
  details: {},
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

const accounts = (
  list: Array<Partial<ProviderAccountsView['accounts'][number]>>,
  bindings: ProviderAccountsView['bindings'] = [],
): ProviderAccountsView => ({
  vault: { kind: 'file', locked: false, advice: '' },
  bindings,
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

describe('the chapters', () => {
  it('asks five things and then hands over, in that order', () => {
    expect([...CHAPTERS]).toEqual(['hello', 'brain', 'takeOn', 'reach', 'assistant', 'handover']);
    expect(SCRIPT.chapters).toEqual(['Hello', 'A brain', 'What I take on', 'Reach me', 'Your assistant']);
  });

  it('lights the open chapter, ticks the answered ones and numbers the rest', () => {
    const answers = { name: 'Amen', clock: 'America/New_York', brain: { accountId: 'a', label: 'Claude', model: 'm' } };
    expect(CHAPTERS.slice(0, 5).map((id) => mapState(answers, 'takeOn', id))).toEqual(['done', 'done', 'now', 'todo', 'todo']);
    // A chapter reopened with "change" is lit, not ticked, while it is open.
    expect(mapState(answers, 'hello', 'hello')).toBe('now');
  });

  it('goes back one chapter at a time, and not before the first', () => {
    expect(previous('reach')).toBe('takeOn');
    expect(previous('brain')).toBe('hello');
    expect(previous('hello')).toBeNull();
  });
});

describe('resume', () => {
  it('replays the profile, the account and the agent the server already has', () => {
    const answers = answersFrom({
      onboarding: onboarding({ needs: { owner: false, model: false, agent: false } }),
      owner: owner({ preferredName: 'Amen', timezone: 'America/New_York' }),
      accounts: accounts([{ id: 'one', label: 'Ollama', defaultModel: 'qwen3:4b' }], [{ agentId: 'ada', accountId: 'one', model: 'qwen3:4b' }]),
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    });
    expect(answers.name).toBe('Amen');
    expect(answers.clock).toBe('America/New_York');
    expect(answers.brain).toEqual({ accountId: 'one', label: 'Ollama', model: 'qwen3:4b' });
    expect(answers.assistant).toEqual({ id: 'ada', name: 'Ada', avatar: '📚' });
    expect(firstOpen(answers)).toBe('handover');
  });

  it('opens the first chapter nobody has answered', () => {
    expect(firstOpen(answersFrom({}))).toBe('hello');
    // A name without a clock is half of chapter 1.
    expect(firstOpen(answersFrom({ owner: owner({ preferredName: 'Amen' }) }))).toBe('hello');
    expect(
      firstOpen(answersFrom({ owner: owner({ preferredName: 'Amen', timezone: 'UTC' }) })),
    ).toBe('brain');
  });

  it('replays chapters 3 and 4 from the record, "just an assistant" included', () => {
    const facts = {
      onboarding: onboarding({ needs: { owner: false, model: false, agent: true }, details: { accountId: 'a0' } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts([{}]),
    };
    expect(firstOpen(answersFrom(facts))).toBe('takeOn');
    const took = answersFrom({ ...facts, onboarding: onboarding({ ...facts.onboarding, details: { accountId: 'a0', takeOn: [] } }) });
    expect(took.takeOn).toEqual([]);
    expect(firstOpen(took)).toBe('reach');
    const reached = answersFrom({
      ...facts,
      onboarding: onboarding({ ...facts.onboarding, stepsDone: ['reach'], details: { accountId: 'a0', takeOn: ['days'], reach: { phone: true } } }),
    });
    expect(reached.reach).toEqual({ phone: true });
    expect(firstOpen(reached)).toBe('assistant');
  });

  it('counts no account the installation could not run on', () => {
    for (const broken of [{ enabled: false }, { configured: false }, { removalPending: true }]) {
      const answers = answersFrom({
        onboarding: onboarding({ details: { accountId: 'a0' } }),
        owner: owner({ preferredName: 'A', timezone: 'UTC' }),
        accounts: accounts([broken]),
      });
      expect(answered(answers, 'brain')).toBe(false);
      expect(firstOpen(answers)).toBe('brain');
    }
  });

  /*
   * An installation may hold several accounts — a developer checkout usually
   * does — and only one of them is this assistant's brain. Guessing would put
   * a model in buddi's confirmation that the assistant does not think with.
   */
  it('takes the brain from what the assistant is bound to, never from the first account', () => {
    const answers = answersFrom({
      onboarding: onboarding({ needs: { owner: false, model: false, agent: false }, details: { accountId: 'first' } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts(
        [{ id: 'first', label: 'Anthropic' }, { id: 'second', label: 'Ollama', defaultModel: 'qwen3:4b' }],
        [{ agentId: 'ada', accountId: 'second', model: 'qwen3:8b' }],
      ),
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    });
    expect(answers.brain).toEqual({ accountId: 'second', label: 'Ollama', model: 'qwen3:8b' });
  });

  it('takes it from the account this first run recorded when there is no assistant yet', () => {
    const facts = {
      onboarding: onboarding({ details: { accountId: 'second' } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts([{ id: 'first', label: 'Anthropic' }, { id: 'second', label: 'Ollama', defaultModel: 'qwen3:4b' }]),
    };
    expect(answersFrom(facts).brain).toEqual({ accountId: 'second', label: 'Ollama', model: 'qwen3:4b' });
    // And nothing recorded means the question is still open, however many
    // accounts this installation happens to hold.
    expect(answersFrom({ ...facts, onboarding: onboarding() }).brain).toBeUndefined();
  });

  it('keeps the browser in chapter 4, never as a gate, and replays what is there now', () => {
    const facts = {
      onboarding: onboarding({ needs: { owner: false, model: false, agent: true }, details: { accountId: 'a0', takeOn: [] } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts([{}]),
    };
    expect(firstOpen(answersFrom(facts))).toBe('reach');
    const recorded = answersFrom({ ...facts, onboarding: onboarding({ ...facts.onboarding, stepsDone: ['browser', 'reach'] }), browser: 'none' });
    expect(recorded.browser).toBe('none');
    expect(firstOpen(recorded)).toBe('assistant');
  });

  it('counts chapters 3 and 4 as behind an assistant that already exists', () => {
    const answers = answersFrom({
      onboarding: onboarding({ needs: { owner: false, model: false, agent: false }, details: { accountId: 'a0' } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts([{}]),
      assistant: { id: 'ada', name: 'Ada', avatar: '' },
    });
    expect(answers.takeOn).toEqual([]);
    expect(answers.reach).toEqual({});
    expect(firstOpen(answers)).toBe('handover');
  });

  it('does not count an assistant the record says is still missing', () => {
    const answers = answersFrom({
      onboarding: onboarding({ needs: { owner: false, model: false, agent: true }, stepsDone: ['browser', 'reach'], details: { accountId: 'a0', takeOn: [] } }),
      owner: owner({ preferredName: 'A', timezone: 'UTC' }),
      accounts: accounts([{}]),
      // A shipped example is in the roster; it is not the owner's own.
      assistant: { id: 'concierge', name: 'Concierge', avatar: '' },
    });
    expect(firstOpen(answers)).toBe('assistant');
  });
});

/*
 * The restore branch. A backup carries the owner, the assistant and everything
 * they said to each other; it deliberately carries no key. So the record that
 * comes back says first run is done — which is the one state that would
 * otherwise send the owner off this screen — and the brain is still open.
 */
describe('a buddi restored from a backup', () => {
  it('keeps the thread here and asks for the brain again', () => {
    const resume = afterRestore({
      onboarding: onboarding({ state: 'done', needs: { owner: false, model: true, agent: false } }),
      owner: owner({ preferredName: 'Amen', timezone: 'America/New_York' }),
      // The account came back; the key that made it work did not.
      accounts: accounts([{ id: 'one', label: 'Anthropic', configured: false }]),
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    });
    expect(resume.stay).toBe(true);
    expect(resume.open).toBe('brain');
    expect(resume.answers.name).toBe('Amen');
    expect(resume.answers.clock).toBe('America/New_York');
    expect(resume.answers.assistant).toEqual({ id: 'ada', name: 'Ada', avatar: '📚' });
    expect(resume.answers.brain).toBeUndefined();
  });

  it('hands the owner over to the dashboard when nothing is left to ask', () => {
    const resume = afterRestore({
      onboarding: onboarding({ state: 'done', needs: { owner: false, model: false, agent: false } }),
      owner: owner({ preferredName: 'Amen', timezone: 'UTC' }),
      accounts: accounts([{ id: 'one', label: 'Ollama', defaultModel: 'qwen3:4b' }], [{ agentId: 'ada', accountId: 'one', model: 'qwen3:4b' }]),
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    });
    expect(resume.open).toBe('handover');
    expect(resume.stay).toBe(false);
  });

  it('remembers the job across a reload, and forgets it when asked', () => {
    rememberRestore('job-1');
    expect(rememberedRestore()).toBe('job-1');
    rememberRestore(null);
    expect(rememberedRestore()).toBeNull();
  });

  it('survives a browser that refuses storage', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage is off');
      },
    });
    try {
      expect(() => rememberRestore('job-2')).not.toThrow();
      expect(rememberedRestore()).toBeNull();
    } finally {
      if (real) Object.defineProperty(window, 'sessionStorage', real);
      else delete (window as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});

describe('change', () => {
  it('reopens one chapter with its answer filled in, and keeps the answers that followed it', () => {
    const answers = {
      name: 'Amen',
      clock: 'UTC',
      brain: { accountId: 'one', label: 'Claude', model: 'claude-sonnet-5' },
      takeOn: ['days'],
      reach: {},
      assistant: { id: 'ada', name: 'Ada', avatar: '📚' },
    };
    const changed = reopen(answers, 'brain');
    // The form opens on what is there; saving it again is what replaces it.
    expect(changed.brain).toEqual(answers.brain);
    expect(changed.assistant).toEqual(answers.assistant);
    expect(changed.takeOn).toEqual(['days']);
    // And the map lights the chapter being changed, not the next gap.
    expect(mapState(changed, 'brain', 'brain')).toBe('now');
    expect(mapState(changed, 'brain', 'assistant')).toBe('done');
  });

  it('keeps the clock when the name changes', () => {
    const changed = reopen({ name: 'Amen', clock: 'UTC' }, 'hello');
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
  it('offers the brand, under the handle the shipped assistant already has', () => {
    expect(idFor(DEFAULT_ASSISTANT_NAME)).toBe('buddi');
  });

  it('files a name the server will accept', () => {
    expect(idFor('Ada')).toBe('ada');
    expect(idFor('Night Desk')).toBe('night-desk');
    expect(idFor('Rémy')).toBe('remy');
    expect(idFor('42')).toBe('assistant');
  });
});

/*
 * The order a restore actually reports.
 *
 * `recovery` is written inside the database step's rollback, before the files
 * are put back, so a restore that cannot be gated rolls back instead of coming
 * up ungated. A screen that promised the other order would say "bringing back
 * your files" after it had already said the installation was marked restored.
 */
describe('the restore, as it is narrated', () => {
  it('names the phases in the order the job reports them', () => {
    expect([...RESTORE_PHASES]).toEqual([
      'stopping', 'snapshot', 'database', 'recovery', 'files', 'starting', 'done',
    ]);
    expect([...RESTORE_FAILURES]).toEqual(['failed', 'rolled-back']);
  });

  it('has a sentence for each of them, in the same order', () => {
    const said = Object.keys(SCRIPT.restore.phases);
    expect(said.filter((phase) => !RESTORE_FAILURES.includes(phase as 'failed')))
      .toEqual([...RESTORE_PHASES]);
    for (const failure of RESTORE_FAILURES) expect(said).toContain(failure);
  });
});
