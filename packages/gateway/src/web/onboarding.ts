/**
 * First run, from the dashboard — the server's half of the wizard.
 *
 * `core.onboarding` already holds the record: pending, in-progress, done or
 * skipped, plus the steps that got answered. The Telegram interview writes it
 * through the agent's `owner.*` tools; the web wizard writes it through these
 * four routes. One record, one state machine, two surfaces — which is what
 * makes a wizard the owner finished on the dashboard stop the Telegram
 * interview and its nudge arc from ever opening (`shouldStartFirstRun` speaks
 * only while the state is still `pending`, and `readArcState` only counts
 * against a row the interview started).
 *
 * Nothing here is a tool call. This is the owner acting on their own
 * installation from a page that already carries their session, their Origin
 * and their CSRF header, so it goes behind that gate and no other — the same
 * standing as saving their name or adding a model account.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  AGENT_FILE,
  HANDLE,
  HANDLE_MAX,
  HANDLE_MIN,
  getOnboarding,
  getOwnerProfile,
  parseAgentFile,
  type AgentCatalog,
  type Onboarding,
  type Queryable,
} from '@buddi/core';
import { insideExamples } from '../agents/owner-tools.js';
import { composeAgentFile, createAgentDirAtomic } from '../agents/platform-files.js';
import type { ProviderAccounts } from '../provider-accounts.js';

/** The surface recorded against everything the wizard writes. */
export const WEB_ONBOARDING_SURFACE = 'web';

/**
 * The wizard's screens, as step names.
 *
 * Deliberately not `ONBOARDING_STEPS`: those are the questions the *interview*
 * asks, and the store's contract is that any string may be recorded. These are
 * what the page resumes from.
 */
export const WEB_ONBOARDING_STEPS = [
  'welcome',
  'you',
  'model',
  'agent',
  'hello',
  'extras',
] as const;

export type WebOnboardingStep = (typeof WEB_ONBOARDING_STEPS)[number];

/**
 * What the owner's first agent may reach.
 *
 * Its own memory, the clock, the owner's profile, the canvas, and the four
 * read-only platform tools that let it say who else is installed. No plugin
 * family and no role: a first agent is a conversation partner, and every
 * capability beyond this is something the owner adds deliberately afterwards.
 *
 * It lives here rather than in the dashboard bundle because a tool name is the
 * server's vocabulary — the page names no tool.
 */
export const FIRST_AGENT_TOOLS: readonly string[] = [
  'memory.*',
  'reminder.*',
  'schedule.*',
  'owner.*',
  'canvas.*',
  'platform.list_agents',
  'platform.read_agent',
  'platform.installed_tools',
  'platform.list_skills',
];

/** What the wizard still has to ask for. Each one is a screen that matters. */
export interface OnboardingNeeds {
  /** No name for the owner yet. */
  owner: boolean;
  /** No provider account this installation could actually run on. */
  model: boolean;
  /** No agent of the owner's own; the shipped examples do not count. */
  agent: boolean;
}

export interface OnboardingView {
  state: Onboarding['state'];
  stepsDone: string[];
  needs: OnboardingNeeds;
}

export interface OnboardingDeps {
  pool: Queryable;
  catalog: AgentCatalog;
  providerAccounts?: ProviderAccounts | undefined;
  /** Where the owner's own agents live. */
  agentsDir: string;
  /** The examples tree, which this never writes into. */
  examplesDir: string;
  reload: () => void;
}

/** Does this installation hold an agent the owner made? Examples are not one. */
export function hasPrivateAgent(catalog: AgentCatalog): boolean {
  const list = typeof catalog?.list === 'function' ? catalog.list() : [];
  return list.some((agent) => agent.source !== 'example');
}

/**
 * Is there a credential the agents could run on?
 *
 * A process with no account service cannot answer, and answers "nothing is
 * needed": the wizard's redirect keys off this, and an installation whose
 * models are configured some other way must never be sent back to a setup
 * screen it already passed.
 */
export function hasUsableModel(accounts: ProviderAccounts | undefined): boolean {
  if (!accounts) return true;
  const view = accounts.view() as {
    accounts?: Array<{ enabled?: boolean; configured?: boolean; removalPending?: boolean }>;
  };
  return (view.accounts ?? []).some(
    (account) => account.enabled === true && account.configured === true && account.removalPending !== true,
  );
}

/** The record and what is still missing, in one read. Nothing here writes. */
export async function readOnboarding(deps: OnboardingDeps): Promise<OnboardingView> {
  const record = await getOnboarding(deps.pool);
  const profile = await getOwnerProfile(deps.pool);
  return {
    state: record.state,
    stepsDone: record.stepsDone,
    needs: {
      owner: profile.preferredName === null,
      model: !hasUsableModel(deps.providerAccounts),
      agent: !hasPrivateAgent(deps.catalog),
    },
  };
}

/** A refusal with the status the route answers with. */
export class OnboardingRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OnboardingRefusal';
  }
}

export interface FirstAgentInput {
  name: string;
  handle: string;
  description: string;
  avatar?: string;
}

function checkHandle(value: string, catalog: AgentCatalog): string {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    throw new OnboardingRefusal(400, `A handle is ${HANDLE_MIN} to ${HANDLE_MAX} characters.`);
  }
  if (!HANDLE.test(handle)) {
    throw new OnboardingRefusal(
      400,
      'A handle is lower-case letters, digits and hyphens, starting with a letter — like ada or night-desk.',
    );
  }
  const list = typeof catalog?.list === 'function' ? catalog.list() : [];
  const taken = list.find(
    (agent) => agent.handle.toLowerCase() === handle || agent.id.toLowerCase() === handle,
  );
  if (taken) {
    throw new OnboardingRefusal(409, `@${handle} is already ${taken.name}. Pick another one.`);
  }
  return handle;
}

/** The persona a generic first agent starts with: the owner's words, framed. */
export function firstAgentPersona(input: { name: string; description: string }): string {
  return [
    `You are ${input.name}. There is exactly one owner: the person you are talking to. Today is {{today}}.`,
    '',
    'What you are for, in the owner\'s own words:',
    '',
    input.description
      .trim()
      .split('\n')
      .map((line) => `> ${line.trim()}`)
      .join('\n'),
    '',
    '## How you work',
    '',
    '- Answer in one or two short paragraphs. Lead with the answer, then the reason.',
    '- Ask one thing at a time and wait. Never send a list of questions.',
    '- You hold your memory, the clock, the owner\'s profile and the roster-reading tools, and nothing else.',
    '  When something needs data you cannot reach, say so plainly and say what would answer it — never guess,',
    '  not even at a small number.',
    '- Write down what the owner tells you about themselves with the memory and profile tools, as they say it.',
    '- You are the first agent of this installation. If the owner asks what else is possible, say that agents',
    '  are files they can add, and that you can be given more tools whenever they want.',
  ].join('\n');
}

/**
 * Write the owner's first agent.
 *
 * The same writer `platform.create_agent` uses — the file is composed by
 * `composeAgentFile` and the directory is moved into place whole — so there is
 * one way an agent gets onto disk, and an agent made here is indistinguishable
 * from one the maker agent made.
 */
export async function createFirstAgent(
  deps: OnboardingDeps,
  input: FirstAgentInput,
): Promise<{ id: string; handle: string; file: string; live: boolean; assigned: string | null }> {
  const name = input.name.trim();
  if (name === '' || name.length > 60) {
    throw new OnboardingRefusal(400, 'A name is one to 60 characters.');
  }
  const description = input.description.trim();
  if (description === '' || description.length > 1000) {
    throw new OnboardingRefusal(400, 'Say in a sentence or two what this agent is for (up to 1,000 characters).');
  }
  const avatar = (input.avatar ?? '').trim();
  if (avatar !== '' && /[A-Za-z0-9./\\]/.test(avatar)) {
    throw new OnboardingRefusal(400, 'A face is an emoji.');
  }
  const handle = checkHandle(input.handle, deps.catalog);
  const id = handle;

  const dir = path.join(deps.agentsDir, id);
  const file = path.join(dir, AGENT_FILE);
  if (insideExamples(file, deps.examplesDir)) {
    throw new OnboardingRefusal(409, 'That directory belongs to the shipped examples.');
  }
  if (existsSync(dir)) {
    throw new OnboardingRefusal(409, `${dir} already exists on disk. Pick another handle.`);
  }

  const content = composeAgentFile({
    id,
    handle,
    name,
    description,
    // The first private agent becomes the default, so the dashboard and every
    // surface open on it rather than on a shipped example.
    ...(hasPrivateAgent(deps.catalog) ? {} : { default: true }),
    tools: [...FIRST_AGENT_TOOLS],
    language: 'mirror',
    ...(avatar === '' ? {} : { avatar }),
    persona: firstAgentPersona({ name, description }),
  });
  // The loader's own verdict, before anything is written.
  try {
    parseAgentFile(content, { dirName: id });
  } catch (err) {
    throw new OnboardingRefusal(
      400,
      `That would write a file the loader refuses: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  createAgentDirAtomic(dir, { [AGENT_FILE]: content });

  let live = true;
  try {
    deps.reload();
  } catch {
    // The file is on disk and the next start will read it; the page says so.
    live = false;
  }

  return { id, handle, file, live, assigned: await assignOnlyAccount(deps, id) };
}

/**
 * Give the new agent the account the owner just added.
 *
 * An agent with no account cannot answer, and the step after this one is the
 * owner saying hello to it. With exactly one usable account there is nothing
 * to choose, so choosing is not a question worth asking; with two, the wizard
 * leaves it to the Agents page rather than picking for them.
 */
async function assignOnlyAccount(deps: OnboardingDeps, agentId: string): Promise<string | null> {
  const accounts = deps.providerAccounts;
  if (!accounts) return null;
  const view = accounts.view() as {
    accounts?: Array<{ id: string; defaultModel: string; enabled?: boolean; configured?: boolean; removalPending?: boolean }>;
  };
  const usable = (view.accounts ?? []).filter(
    (account) => account.enabled === true && account.configured === true && account.removalPending !== true,
  );
  if (usable.length !== 1) return null;
  const only = usable[0]!;
  if (!only.defaultModel) return null;
  try {
    await accounts.assign(agentId, { accountId: only.id, model: only.defaultModel });
    return only.id;
  } catch {
    // Not fatal: the agent exists, and the Agents page is where an account is
    // chosen. Saying nothing here is better than failing a write that worked.
    return null;
  }
}
