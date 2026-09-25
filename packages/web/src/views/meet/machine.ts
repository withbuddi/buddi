/**
 * The thread's state machine: four questions and a handover, in order.
 *
 * Pure on purpose. Everything the screen does — which question is open, which
 * answers are replayed above it, what a reload lands on, what "change" reopens
 * — is decided here from the server's own answers, so the component only
 * renders and saves. That is also what makes the resume rule testable without
 * a browser: `answersFrom` reads the record, the profile and the accounts, and
 * `firstOpen` says which question has not been answered yet.
 */
import type { OnboardingView, OwnerView, ProviderAccountsView } from '../../api';

/** The questions, in the order they are asked. `handover` is the last one. */
export const QUESTIONS = ['name', 'clock', 'brain', 'browser', 'assistant', 'handover'] as const;

export type QuestionId = (typeof QUESTIONS)[number];

/** Which recorded step each question belongs to (`/api/onboarding/step`). */
export const STEP_OF: Record<QuestionId, string> = {
  name: 'you',
  clock: 'you',
  brain: 'model',
  browser: 'browser',
  assistant: 'agent',
  handover: 'hello',
};

/** The account the assistant thinks with, as the thread knows it. */
export interface BrainAnswer {
  accountId: string;
  /** What the owner picked, in their words: "Claude", "Ollama". */
  label: string;
  /** The account's default model, which is what buddi names in its reply. */
  model: string;
}

/**
 * The agents' own browser, as this step left it. `other` is a mode that is
 * not the agents' own browser, where there is nothing to fetch.
 */
export type BrowserAnswer = 'chrome' | 'chromium' | 'installed' | 'skipped' | 'none' | 'other';

export interface AssistantAnswer {
  id: string;
  name: string;
  avatar: string;
}

/** Everything that has been answered. An absent key is an unanswered question. */
export interface MeetAnswers {
  name?: string;
  clock?: string;
  brain?: BrainAnswer;
  browser?: BrowserAnswer;
  assistant?: AssistantAnswer;
}

/** What the server says, from the three reads the thread resumes off. */
export interface MeetFacts {
  onboarding?: OnboardingView | undefined;
  owner?: OwnerView | undefined;
  accounts?: ProviderAccountsView | undefined;
  /** The agent of the owner's own, when the roster has one. */
  assistant?: AssistantAnswer | undefined;
  /** Which browser the agents' own browser finds now; absent in another mode. */
  browser?: 'chrome' | 'chromium' | 'none' | undefined;
}

/** An account that could actually answer a question. */
export function usableAccounts(view: ProviderAccountsView | undefined): ProviderAccountsView['accounts'] {
  return (view?.accounts ?? []).filter(
    (account) => account.enabled && account.configured && account.removalPending !== true,
  );
}

/**
 * Which account is the assistant's brain.
 *
 * In order: what the assistant is actually bound to, then what this first run
 * recorded choosing. Never "the first usable one" — an installation may hold
 * several, and guessing would name a model in buddi's confirmation that the
 * assistant does not think with.
 */
export function brainFrom(facts: MeetFacts): BrainAnswer | undefined {
  const usable = usableAccounts(facts.accounts);
  const bound = facts.assistant
    ? (facts.accounts?.bindings ?? []).find((binding) => binding.agentId === facts.assistant!.id)
    : undefined;
  const chosen = bound?.accountId ?? facts.onboarding?.details?.accountId;
  if (!chosen) return undefined;
  const account = usable.find((row) => row.id === chosen);
  if (!account) return undefined;
  // The bound model is the one the assistant answers on; the account's default
  // is what a brain chosen but not yet bound will use.
  return { accountId: account.id, label: account.label, model: bound?.model ?? account.defaultModel };
}

/**
 * The answers as the server has them.
 *
 * Not as the page remembers them: a reload, a second tab and a restart all
 * replay from here, and anything this cannot see was never really answered.
 */
export function answersFrom(facts: MeetFacts): MeetAnswers {
  const brain = brainFrom(facts);
  const assistant = facts.onboarding && !facts.onboarding.needs.agent ? facts.assistant : undefined;
  return {
    ...(facts.owner?.preferredName ? { name: facts.owner.preferredName } : {}),
    ...(facts.owner?.timezone ? { clock: facts.owner.timezone } : {}),
    ...(brain ? { brain } : {}),
    // Recorded once, never a gate: on a replay it says what is there now. An
    // assistant that exists was made after this step, or before it existed.
    ...(facts.onboarding?.stepsDone.includes('browser') || assistant ? { browser: facts.browser ?? 'other' } : {}),
    // An agent of the owner's own is what the record calls answered; the
    // roster is where its name and face come from.
    ...(assistant ? { assistant } : {}),
  };
}

/** Is this question answered? */
export function answered(answers: MeetAnswers, id: QuestionId): boolean {
  if (id === 'name') return typeof answers.name === 'string' && answers.name !== '';
  if (id === 'clock') return typeof answers.clock === 'string' && answers.clock !== '';
  if (id === 'brain') return answers.brain !== undefined;
  if (id === 'browser') return answers.browser !== undefined;
  if (id === 'assistant') return answers.assistant !== undefined;
  return false;
}

/** The first question with no answer — where a reload lands. */
export function firstOpen(answers: MeetAnswers): QuestionId {
  return QUESTIONS.find((id) => !answered(answers, id)) ?? 'handover';
}

/** The questions to draw, in order: every answered one, then the open one. */
export function thread(answers: MeetAnswers, open: QuestionId): QuestionId[] {
  const upto = QUESTIONS.indexOf(open);
  return QUESTIONS.filter((id, at) => at < upto || id === open);
}

/**
 * What "change" does.
 *
 * It reopens that question and keeps every later answer, because none of them
 * is untrue: a new name is a new greeting, and a new brain is re-tested and
 * re-bound to the assistant that already exists rather than a second assistant
 * being made. The only thing dropped is the answer being changed.
 */
export function reopen(answers: MeetAnswers, id: QuestionId): MeetAnswers {
  const next = { ...answers };
  delete next[id as 'name'];
  return next;
}

/* ------------------------------------------------------------------ *
 * The other branch: this buddi is an old one, coming back
 * ------------------------------------------------------------------ */

/**
 * The phases a restore passes through, in the order the job reports them.
 *
 * `recovery` comes before `files`: the recovery row is written through the
 * engine's `afterDatabase` hook, inside the rollback, so a restore that cannot
 * be gated rolls back rather than coming up ungated. The job also reports
 * phases of its own (`verify`, `archive`, `encrypt`) in between, so this is a
 * subsequence of what arrives, never the whole of it.
 */
export const RESTORE_PHASES = [
  'stopping',
  'snapshot',
  'database',
  'recovery',
  'files',
  'starting',
  'done',
] as const;

/** The two ways a restore ends badly. Nothing follows either. */
export const RESTORE_FAILURES = ['failed', 'rolled-back'] as const;

/**
 * Where a restore in flight is remembered.
 *
 * Session storage, not the record: the restore takes the gateway down with it,
 * so for a minute there is nowhere on the server to ask, and the tab that
 * started it is the only thing that knows a job id. It is deliberately gone
 * when the tab is, because a job id from yesterday is not worth resuming.
 * Every access is guarded: a browser may refuse storage outright.
 */
const RESTORE_KEY = 'buddi.firstRun.restore';

export function rememberRestore(jobId: string | null): void {
  try {
    if (jobId === null) window.sessionStorage.removeItem(RESTORE_KEY);
    else window.sessionStorage.setItem(RESTORE_KEY, jobId);
  } catch {
    /* Private browsing, or storage turned off. A reload simply starts over. */
  }
}

export function rememberedRestore(): string | null {
  try {
    return window.sessionStorage.getItem(RESTORE_KEY);
  } catch {
    return null;
  }
}

/** Where the thread carries on once a restore has finished. */
export interface RestoreResume {
  answers: MeetAnswers;
  open: QuestionId;
  /** False when nothing is left to ask and the owner belongs in the dashboard. */
  stay: boolean;
}

/**
 * The thread after a restore.
 *
 * The record the archive carried normally says first run is done, which is
 * exactly the state that would otherwise send the owner away from this screen.
 * It is not done: a backup never carries keys, so the restored accounts cannot
 * answer and the brain is the one question that always has to be asked again.
 * Everything else — the name, the clock, the assistant — came back with it.
 */
export function afterRestore(facts: MeetFacts): RestoreResume {
  const answers = answersFrom(facts);
  const open = firstOpen(answers);
  return { answers, open, stay: open !== 'handover' };
}

/**
 * Which AI a pasted key belongs to.
 *
 * `sk-ant-` is Anthropic's, and everything else that looks like a key is
 * OpenAI's. It is a guess, which is why the card offers to be corrected.
 */
export function keyKind(secret: string): 'anthropic' | 'openai' {
  return secret.trim().startsWith('sk-ant-') ? 'anthropic' : 'openai';
}


/** `Ada` → `ada`. What the server files the assistant under. */
export function idFor(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 20)
    .replace(/-+$/, '');
  return cleaned === '' ? 'assistant' : cleaned;
}
