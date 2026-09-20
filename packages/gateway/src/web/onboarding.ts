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
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  AGENT_FILE,
  HANDLE,
  HANDLE_MAX,
  HANDLE_MIN,
  OPENING_TURN_SPEAKER,
  getOnboarding,
  getOwnerProfile,
  parseAgentFile,
  patchAgentSource,
  setOnboardingDetails,
  type AgentCatalog,
  type Onboarding,
  type OnboardingDetails,
  type Queryable,
} from '@buddi/core';
import { createHttpTransport, type HttpTransport } from '@buddi/runtime';
import { composeAgentFile, createAgentDirAtomic, replaceBody, writeFilesAtomic } from '../agents/platform-files.js';
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
  /** What the steps do not say: the handover conversation, the account chosen. */
  details: OnboardingDetails;
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
    details: record.details,
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
  /**
   * The account the wizard just tested, bound to the new agent.
   *
   * Explicit because the wizard knows which one it made the owner add, and
   * "the only usable account" stops being an answer the moment there are two.
   * Omitted — a caller that has no opinion — falls back to that rule.
   */
  accountId?: string;
}

/**
 * The example the owner's first agent takes the place of.
 *
 * The catalog's rule is that a private agent with the same id as an example
 * replaces it wholesale (docs/ARCHITECTURE.md, "Drop-in tools and skills"), so
 * writing the first agent under this id *is* the rename: there is one
 * assistant afterwards, the owner's, and Concierge is no longer listed beside
 * it pretending to be a colleague. The handle, name, face and description are
 * the owner's; only the id is inherited.
 */
export const SHIPPED_ASSISTANT_ID = 'concierge';

/** The id the first agent is written under: the example's, or the handle. */
export function firstAgentId(catalog: AgentCatalog, handle: string): string {
  const shipped = typeof catalog?.get === 'function' ? catalog.get(SHIPPED_ASSISTANT_ID) : undefined;
  // Only an *example* is replaced. An installation that has its own
  // `concierge` already is not one the wizard is writing a first agent for,
  // and the refusal below has already said so.
  return shipped && shipped.source === 'example' ? SHIPPED_ASSISTANT_ID : handle;
}

function checkHandle(value: string, catalog: AgentCatalog, replacing: string): string {
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
  const held = typeof catalog?.byHandle === 'function' ? catalog.byHandle(handle) : undefined;
  const byId = typeof catalog?.get === 'function' ? catalog.get(handle) : undefined;
  // `list()` is the roster, and the roster holds back the examples this
  // installation has not grown into yet (`EXAMPLES_HELD_BACK`). A handle that
  // one of those holds is still taken — it comes back the moment the owner has
  // an assistant — so the lookups that answer for a held-back agent are asked
  // too.
  const taken = [
    ...list.filter((agent) => agent.handle.toLowerCase() === handle || agent.id.toLowerCase() === handle),
    ...(held ? [held] : []),
    ...(byId ? [byId] : []),
    // The agent being replaced is not a collision with itself: the whole point
    // is that this file takes its place.
  ].find((agent) => agent.id !== replacing);
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
 * A path with every existing ancestor resolved through its symlinks.
 *
 * `path.relative` on the strings alone answers about spellings, not about
 * directories: a private agents directory that is a symlink into the examples
 * tree, or a `..` that a link undoes, would both read as safely outside. The
 * target itself does not exist yet — that is the point of creating it — so the
 * nearest existing ancestor is resolved and the rest re-joined onto it.
 */
function resolveThrough(target: string): string {
  const tail: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...[...tail].reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Is `child` the same directory as `parent`, or inside it? */
function within(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * One creation at a time in this process.
 *
 * Two requests arriving together would both read a catalog with no private
 * agent in it and both write one claiming `default: true`. The refusal below is
 * the rule; this is what makes the rule hold when the check and the write are
 * not one statement. It is per process, which is the whole surface: the agents
 * directory belongs to one installation and one gateway writes it.
 */
let creating: Promise<unknown> = Promise.resolve();

/**
 * Write the owner's first agent.
 *
 * The same writer `platform.create_agent` uses — the file is composed by
 * `composeAgentFile` and the directory is moved into place whole — so there is
 * one way an agent gets onto disk, and an agent made here is indistinguishable
 * from one the maker agent made.
 */
export function createFirstAgent(
  deps: OnboardingDeps,
  input: FirstAgentInput,
): Promise<{ id: string; handle: string; file: string; live: boolean; assigned: string | null }> {
  const run = creating.then(
    () => writeFirstAgent(deps, input),
    () => writeFirstAgent(deps, input),
  );
  creating = run.catch(() => undefined);
  return run;
}

async function writeFirstAgent(
  deps: OnboardingDeps,
  input: FirstAgentInput,
): Promise<{ id: string; handle: string; file: string; live: boolean; assigned: string | null }> {
  // This route writes the *first* agent and nothing else. Once the owner has
  // one, adding another is the maker agent's job, where a grant is proposed and
  // approved rather than assumed.
  if (hasPrivateAgent(deps.catalog)) {
    throw new OnboardingRefusal(409, 'You already have an agent of your own. Add another one from the Agents page.');
  }
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
  // The id is the shipped example's, so that writing this file *replaces*
  // Concierge instead of standing a second agent next to it. The handle is the
  // owner's, and the handle is what they will type.
  const id = firstAgentId(deps.catalog, input.handle.trim().replace(/^@/, '').toLowerCase());
  const handle = checkHandle(input.handle, deps.catalog, id);
  // Both refusals that depend on state outside this file happen here, before
  // the directory is moved into place.
  const account = chooseAccount(deps, input.accountId);

  const dir = path.join(deps.agentsDir, id);
  const file = path.join(dir, AGENT_FILE);
  const examples = resolveThrough(deps.examplesDir);
  if (within(resolveThrough(deps.agentsDir), examples) || within(resolveThrough(dir), examples)) {
    throw new OnboardingRefusal(409, 'That directory belongs to the shipped examples, which this never writes into.');
  }
  if (existsSync(dir)) {
    throw new OnboardingRefusal(409, `${dir} already exists on disk. Pick another handle.`);
  }

  const content = composeAgentFile({
    id,
    handle,
    name,
    description,
    // There is no private agent yet — the refusal above is what guarantees it —
    // so this one is the default, and the dashboard and every other surface
    // open on it rather than on a shipped example.
    default: true,
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

  return { id, handle, file, live, assigned: await assignAccount(deps, id, account) };
}

/* ------------------------------------------------------------------ *
 * Changing the assistant, and claiming the turn that introduces it
 * ------------------------------------------------------------------ */

/** What "change" may alter about the assistant after it exists. */
export interface FirstAgentUpdate {
  name?: string;
  description?: string;
  avatar?: string;
}

/** The owner's own agent, if they have one. Examples are not it. */
export function privateAgent(catalog: AgentCatalog): { id: string; handle: string; file: string; name: string; description: string } | undefined {
  const list = typeof catalog?.list === 'function' ? catalog.list() : [];
  const own = list.filter((agent) => agent.source !== 'example');
  const summary = own.find((agent) => agent.isDefault) ?? own[0];
  // The summary says who; the whole agent says which file, which is what an
  // edit needs.
  const chosen = summary && typeof catalog.get === 'function' ? catalog.get(summary.id) : undefined;
  return chosen
    ? { id: chosen.id, handle: chosen.handle, file: chosen.file, name: chosen.name, description: chosen.description }
    : undefined;
}

/**
 * Change the assistant's name, face or purpose — in place.
 *
 * The screen promises "change either, or keep them", and the owner may take it
 * up after the agent exists, when writing a *first* agent is refused. So this
 * edits the same file through the same primitives the maker agent edits with:
 * the frontmatter is patched key by key (everything else in the block survives
 * byte for byte), and the persona is rewritten only while it is still the one
 * first run generated — an owner who has since written their own words keeps
 * them.
 */
export function updateFirstAgent(
  deps: OnboardingDeps,
  input: FirstAgentUpdate,
): { id: string; handle: string; file: string; live: boolean } {
  const agent = privateAgent(deps.catalog);
  if (!agent) {
    throw new OnboardingRefusal(409, 'There is no assistant of your own to change yet.');
  }
  const name = input.name === undefined ? undefined : input.name.trim();
  if (name !== undefined && (name === '' || name.length > 60)) {
    throw new OnboardingRefusal(400, 'A name is one to 60 characters.');
  }
  const description = input.description === undefined ? undefined : input.description.trim();
  if (description !== undefined && (description === '' || description.length > 1000)) {
    throw new OnboardingRefusal(400, 'Say in a sentence or two what this agent is for (up to 1,000 characters).');
  }
  const avatar = input.avatar === undefined ? undefined : input.avatar.trim();
  if (avatar !== undefined && avatar !== '' && /[A-Za-z0-9./\\]/.test(avatar)) {
    throw new OnboardingRefusal(400, 'A face is an emoji.');
  }

  const source = readFileSync(agent.file, 'utf8');
  let patched: string;
  try {
    patched = patchAgentSource(
      source,
      {
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(avatar === undefined || avatar === '' ? {} : { avatar }),
      },
      agent.file,
    ).text;
  } catch (err) {
    throw new OnboardingRefusal(400, err instanceof Error ? err.message : String(err));
  }
  // The persona quotes the name and the purpose, so leaving it alone would
  // leave an assistant introducing itself by its old name. It is rewritten
  // only while it is still word for word the one this module generated.
  const untouched = bodyOf(patched) === firstAgentPersona({ name: agent.name, description: agent.description }).trim();
  const content = untouched
    ? replaceBody(patched, firstAgentPersona({ name: name ?? agent.name, description: description ?? agent.description }), agent.file)
    : patched;
  try {
    parseAgentFile(content, { dirName: agent.id, file: agent.file });
  } catch (err) {
    throw new OnboardingRefusal(400, `That would write a file the loader refuses: ${err instanceof Error ? err.message : String(err)}`);
  }
  writeFilesAtomic([{ path: agent.file, content }]);

  let live = true;
  try {
    deps.reload();
  } catch {
    live = false;
  }
  return { id: agent.id, handle: deps.catalog.get(agent.id)?.handle ?? agent.handle, file: agent.file, live };
}

/** Everything after the frontmatter block, trimmed. */
function bodyOf(source: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(source);
  return (match ? source.slice(match[0].length) : source).trim();
}

/**
 * The two facts the assistant should not have to ask for.
 *
 * The owner gave their name a minute ago and the assistant was named by them
 * in the same thread; a first message that opens with "what should I call
 * you?" is the installation forgetting, in front of the person who just told
 * it. The three asks stay the page's words — they are the script — and this
 * puts what the *server* knows in front of them.
 */
export async function withFirstRunFacts(deps: OnboardingDeps, instruction: string): Promise<string> {
  const profile = await getOwnerProfile(deps.pool).catch(() => null);
  const owner = profile?.preferredName?.trim() ?? '';
  const assistant = privateAgent(deps.catalog)?.name.trim() ?? '';
  const facts = [
    ...(owner === '' ? [] : [`The owner is called ${owner}.`]),
    ...(assistant === '' ? [] : [`You are ${assistant}.`]),
  ];
  return facts.length === 0 ? instruction : `${facts.join(' ')} ${instruction}`;
}

/**
 * Claim the one turn first run is allowed to send on the owner's behalf.
 *
 * The assistant has to speak first and the runtime has no turn nobody asked
 * for, so the thread sends the instruction as a message. That must happen
 * exactly once per installation: a reload during the handover would otherwise
 * open a second conversation and have the assistant introduce itself twice,
 * to an owner who is watching the first one.
 *
 * The conversation is recorded on the record, which is also what a reload
 * rejoins. A second claim for another conversation is refused, and a repeat
 * claim for the same one is refused once that conversation already holds the
 * turn — so a retry after a failed send still works.
 */
export async function claimOpeningTurn(deps: OnboardingDeps, conversationId: string): Promise<void> {
  const record = await getOnboarding(deps.pool);
  const claimed = record.details.conversationId;
  if (claimed !== undefined && claimed !== conversationId) {
    throw new OnboardingRefusal(409, 'Your assistant has already been introduced, in another conversation.');
  }
  const { rows } = await deps.pool.query(
    `select 1 from core.messages where conversation_id = $1::uuid and speaker = $2 limit 1`,
    [conversationId, OPENING_TURN_SPEAKER],
  );
  if (rows.length > 0) {
    throw new OnboardingRefusal(409, 'Your assistant has already introduced itself in this conversation.');
  }
  await setOnboardingDetails(deps.pool, { conversationId });
}

/**
 * Give the new agent a brain: the account the wizard just tested.
 *
 * Named by the caller when the caller knows it — the thread tested one a
 * moment ago — and otherwise inferred.
 *
 * An agent with no account cannot answer, and the step after this one is the
 * owner saying hello to it. The wizard names the account it made them add;
 * when it names none, exactly one usable account is still not a question worth
 * asking, and with two the wizard leaves it to the Agents page rather than
 * picking for them.
 *
 * A named account that is not usable is not silently swapped for another one:
 * binding an agent to a credential the owner did not choose is how an
 * installation ends up answering from somewhere they did not expect.
 */
function chooseAccount(
  deps: OnboardingDeps,
  chosen: string | undefined,
): { id: string; defaultModel: string } | null {
  const accounts = deps.providerAccounts;
  if (!accounts) return null;
  const view = accounts.view() as {
    accounts?: Array<{ id: string; defaultModel: string; enabled?: boolean; configured?: boolean; removalPending?: boolean }>;
  };
  const usable = (view.accounts ?? []).filter(
    (account) => account.enabled === true && account.configured === true && account.removalPending !== true,
  );
  const named = chosen === undefined ? undefined : usable.find((account) => account.id === chosen);
  // Refused *before* anything is written: a 409 that leaves an agent file on
  // disk is a wizard the owner cannot retry.
  if (chosen !== undefined && !named) {
    throw new OnboardingRefusal(409, 'That model account is not one this installation can run on. Pick another one.');
  }
  const only = named ?? (usable.length === 1 ? usable[0]! : undefined);
  return only?.defaultModel ? { id: only.id, defaultModel: only.defaultModel } : null;
}

async function assignAccount(
  deps: OnboardingDeps,
  agentId: string,
  only: { id: string; defaultModel: string } | null,
): Promise<string | null> {
  const accounts = deps.providerAccounts;
  if (!accounts || !only) return null;
  try {
    await accounts.assign(agentId, { accountId: only.id, model: only.defaultModel });
    return only.id;
  } catch {
    // Not fatal: the agent exists, and the Agents page is where an account is
    // chosen. Saying nothing here is better than failing a write that worked.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Ollama, from the server side
 * ------------------------------------------------------------------ */

/** Where Ollama answers when it is running on this machine. */
export const OLLAMA_BASE_URL = 'http://localhost:11434';

/**
 * Where the owner gets Ollama. It travels as *data* to the page: the dashboard
 * bundle may name no external host, and a link the server hands over is the
 * one way the card can offer it without breaking that rule.
 */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/** How long the probe waits. It is a question about this machine, not the network. */
export const OLLAMA_TIMEOUT_MS = 1_000;

/** One connection per probe, nothing pooled — the rule the whole repo keeps. */
const ollamaTransport: HttpTransport = createHttpTransport({ idleTimeoutMs: OLLAMA_TIMEOUT_MS });

export interface OllamaProbe {
  /** Ollama answered on its usual port, here, now. */
  running: boolean;
  /** The models it has pulled, in the order it lists them. */
  models: string[];
  downloadUrl: string;
  /**
   * Where an account for it points. Travels as data for the same reason the
   * download link does: the page names no address, not even a local one, and
   * the machine Ollama runs on is this one rather than the browser's.
   */
  baseUrl: string;
}

/**
 * Ask Ollama whether it is running, from here.
 *
 * The page must not do this itself: a dashboard that fetches
 * `localhost:11434` is a page reaching off its own origin, which is the one
 * thing the bundle is not allowed to do — and the answer would be about the
 * *browser's* machine rather than the installation's. So the gateway asks, on
 * the shared transport, with a second's patience and no retry: "is it there"
 * has no useful slow answer.
 */
export async function probeOllama(
  opts: { transport?: HttpTransport; baseUrl?: string; timeoutMs?: number } = {},
): Promise<OllamaProbe> {
  const transport = opts.transport ?? ollamaTransport;
  const base = (opts.baseUrl ?? OLLAMA_BASE_URL).replace(/\/+$/, '');
  try {
    const res = await transport(`${base}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) return notRunning(base);
    const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    const models = (Array.isArray(body?.models) ? body.models : [])
      .map((row) => (typeof row?.name === 'string' ? row.name : typeof row?.model === 'string' ? row.model : ''))
      .filter((name) => name !== '');
    return { running: true, models, downloadUrl: OLLAMA_DOWNLOAD_URL, baseUrl: `${base}/v1` };
  } catch {
    // Nothing listening, a refused connection, a second gone by: all of them
    // are "not running", which is what the card says and then polls.
    return notRunning(base);
  }
}

function notRunning(base: string): OllamaProbe {
  return { running: false, models: [], downloadUrl: OLLAMA_DOWNLOAD_URL, baseUrl: `${base}/v1` };
}
