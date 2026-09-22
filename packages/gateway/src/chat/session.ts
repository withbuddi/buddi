/**
 * The terminal surface.
 *
 * Same contract as the Telegram surface, and for the same reason: a surface
 * maps owner input to a conversation, submits it to the runtime and renders the
 * reply. It never executes a tool, never decides an authorization, and never
 * invents an answer. Where Telegram taps a button, the terminal types a letter;
 * where Telegram edits a bubble, the terminal rewrites one line.
 *
 * Everything the owner sees is produced here, but nothing about the *process*
 * is: readline, history, the pager and the signal handlers live in `cli.ts` and
 * reach this class as three small ports — `out`, `ask` and `spinner`. That is
 * what lets the whole surface be tested against a fake provider and an
 * in-memory database, with no terminal anywhere in sight.
 *
 * Conversations are per agent, exactly as in Telegram: `/use` resumes that
 * agent's own thread, `@handle` borrows one for a single message, and two
 * agents never share a history.
 */
import {
  CLI_SURFACE,
  renderOffers,
  DEFAULT_TIMEZONE,
  cancelReminder,
  getAction,
  listArtifacts,
  listReminders,
  listSurfaceIdentitiesDetailed,
  localDateTimeString,
  ToolRegistry,
  type AgentCatalog,
  type CatalogAgent,
  type Queryable,
  type ToolContext,
} from '@buddi/core';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  createConversation,
  runAgent,
  type ApprovalResume,
  type AttachmentRef,
  type RunAgentOptions,
  type RunResult,
  type RuntimeProvider,
} from '@buddi/runtime';
import { nativeSearchRecorder } from '@buddi/tool-web';
import type { Pool } from 'pg';
import { approvalRequestText } from '../telegram/approvals.js';
import {
  formatBytes,
  type ArtifactStore,
} from '../telegram/attachments.js';
import {
  NO_MAKER_TEXT,
  NO_RECAP_MISSION_TEXT,
  RECAP_NOT_REGISTERED_TEXT,
  RECAP_UNAVAILABLE_TEXT,
  roleUnavailableText,
  UNKNOWN_AGENT_TEXT,
  USE_WITHOUT_ID_TEXT,
  devicesText,
  emptyMentionText,
  handleLabel,
  newAgentOpening,
  parseMention,
  stripToolNames,
  unknownHandleText,
  type RunMission,
} from '../telegram/surface.js';
import { ROLE_MAKER, ROLE_OVERVIEW, ROLE_RECAP } from '../agents/roles.js';
import { isUnknownAgentError } from '../telegram/types.js';
import { FIRST_RUN_SUFFIX } from '../agents/first-run.js';
import { attachFile, type PendingAttachment } from './attach.js';
import type { ApprovalPort } from './approvals.js';
import {
  MultilineInput,
  attachQuestion,
  attachmentCandidate,
  helpText,
  isKnownCommand,
  parseCommand,
  saidYes,
  unknownCommandText,
} from './commands.js';
import type { EngagementHooks } from '../missions/engagement.js';
import { listRecentConversations, type ConversationLine } from './conversations.js';
import { renderMarkdown } from './render.js';
import type { Spinner } from './spinner.js';
import { bold, dim, green, red, yellow, type TerminalStyle } from './terminal.js';
import { formatWebSearches, UsageLedger } from './usage.js';
import {
  ASK_POLICY_SUFFIX,
  ASK_TOOLS,
  capturedNote,
  createAskManifest,
  MAX_CAPTURES,
  PendingQuestions,
  turnAskedOwner,
  type AskSink,
  type PendingQuestion,
} from '../surfaces/pending-question.js';
import {
  OFFER_POLICY_SUFFIX,
  OFFER_TOOLS,
  createOfferManifest,
  storeTurnOffers,
  withdrawTurnOffers,
  type OfferSink,
} from '../surfaces/offered-actions.js';
import { failedTurnReply } from '../surfaces/failure.js';
import { approvalResumeContext, type ApprovalResumption } from '../surfaces/owner-request.js';
import { conversationForTurn } from '../surfaces/conversation-lifetime.js';

/** The chat id this surface books its inline mission runs against. */
export const CLI_CHAT_ID = 'cli';

/** Most reminders anyone wants to read at a prompt. */
export const REMINDERS_LIMIT = 20;

/** `/files` with no count. */
export const FILES_LIMIT = 10;

/** How many times one turn may be continued by an approval decision. */
const MAX_APPROVAL_CONTINUATIONS = 4;

/** What the owner is asked when a run stops on a gated call. */
export const APPROVAL_QUESTION = 'Approve this? [y]es / [n]o / [l]ater ';

/** Left pending on purpose. */
export const APPROVAL_LATER_TEXT =
  'Left pending. It is in /approvals here, and on Telegram with buttons.';

/** `/quiet` with nothing proactive to quieten. A fact, not an error. */
export const QUIET_UNAVAILABLE_TEXT =
  'There is nothing proactive running here yet, so there is nothing to quieten.';

/** No approval machinery in this build: a fact about the installation. */
export const APPROVALS_UNAVAILABLE_TEXT =
  'Approvals are not wired up in this build, so nothing can be waiting for one.';

/** No artifact store: said plainly, and the session carries on. */
export const FILES_UNAVAILABLE_TEXT =
  'The artifact store is not wired up in this build, so files cannot be attached here.';

export type HandleResult = 'continue' | 'quit';

/** What one turn did, for the caller that needs an exit code. */
export interface TurnOutcome {
  stopped: RunResult['stopped'] | 'cancelled' | 'failed';
  pendingActionId?: string;
  /**
   * The turn ended by asking the owner something — declared by the run through
   * `conversation.ask`, or read conservatively out of what it wrote.
   */
  askedOwner?: boolean;
}

export interface ChatSessionDeps {
  pool: Queryable;
  catalog: AgentCatalog;
  registry: ToolRegistry;
  ctx: ToolContext;
  now: () => Date;
  timezone?: string;
  /** The adapter for one agent — its own pinned provider, never the process's. */
  providerFor(agent: CatalogAgent): RuntimeProvider;
  /** The agent this session starts on. */
  agent: CatalogAgent;
  /** An existing conversation for that agent (`--resume`, `--last`). */
  conversationId?: string;
  /** Everything the owner reads. One line at a time, newline added. */
  out(text: string): void;
  /** One question, one answer. Approvals and the attach offer use it. */
  ask(question: string): Promise<string>;
  style: TerminalStyle;
  spinner: Spinner;
  memoryPreamble?: (agentId: string) => Promise<string>;
  artifacts?: ArtifactStore;
  approvals?: ApprovalPort;
  runMission?: RunMission;
  /**
   * `/quiet`, and "the owner said something". Absent: `/quiet` says there is
   * nothing proactive to quieten, and nothing is counted.
   */
  engagement?: EngagementHooks;
  /**
   * The mission `/recap` runs, resolved by the composition root from the
   * installed plugins' suggestions for the `recap` role. Absent: no plugin
   * suggests one, and the command says exactly that.
   */
  recapMissionId?: string;
  /** Long answers may go through a pager. Defaults to `out`. */
  present?(text: string): Promise<void>;
  /** `--quiet`: no run footer. */
  quiet?: boolean;
  clearScreen?(): void;
  /** Filesystem ports, injected so the surface is testable. */
  home?: string;
  cwd?: string;
  fileExists?(candidate: string): boolean;
  readFile?(candidate: string): Promise<Buffer>;
  log?(line: string): void;
}

export class ChatSession {
  readonly #deps: ChatSessionDeps;
  readonly #conversations = new Map<string, string>();
  readonly #usage = new UsageLedger();
  /**
   * The one-shot agent that ended its turn asking the owner something, and so
   * owns the owner's next line. One session, one key.
   */
  readonly #pending = new PendingQuestions();
  readonly multiline = new MultilineInput();
  #agent: CatalogAgent;
  #attachments: PendingAttachment[] = [];
  /** Set while a run is in flight, so Ctrl-C has something to cancel. */
  #cancel: (() => void) | null = null;

  constructor(deps: ChatSessionDeps) {
    this.#deps = deps;
    this.#agent = deps.agent;
    if (deps.conversationId) this.#conversations.set(deps.agent.id, deps.conversationId);
  }

  get agent(): CatalogAgent {
    return this.#agent;
  }

  get attachments(): readonly PendingAttachment[] {
    return this.#attachments;
  }

  get usage(): UsageLedger {
    return this.#usage;
  }

  /** True while a run is in flight — what Ctrl-C asks before exiting. */
  get busy(): boolean {
    return this.#cancel !== null;
  }

  #timezone(): string {
    return this.#deps.timezone ?? DEFAULT_TIMEZONE;
  }

  #style(): TerminalStyle {
    return this.#deps.style;
  }

  #out(text: string): void {
    this.#deps.out(text);
  }

  /**
   * `ledger ›`, with the attachment count when the next message carries files.
   * The active agent is in front of the owner at all times: a message sent to
   * the wrong agent is the one mistake this surface can actually prevent.
   */
  prompt(): string {
    if (this.multiline.active) return `${dim(this.multiline.continuation, this.#style().color)} `;
    const color = this.#style().color;
    const files =
      this.#attachments.length === 0
        ? ''
        : dim(` (${this.#attachments.length} file${this.#attachments.length === 1 ? '' : 's'})`, color);
    return `${bold(this.#agent.handle, color)}${files} ${dim('›', color)} `;
  }

  /** The conversation this agent is talking in, created on first contact. */
  async conversationFor(agent: CatalogAgent): Promise<string> {
    const existing = this.#conversations.get(agent.id);
    if (existing) return existing;
    const id = await createConversation(this.#deps.pool, agent.id);
    this.#conversations.set(agent.id, id);
    return id;
  }

  /** Abandon the run in flight. The prompt comes back; nothing is rolled back. */
  cancel(): void {
    this.#cancel?.();
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  /**
   * One physical line from the owner.
   *
   * Multi-line accumulation comes first — inside a `"""` block a line starting
   * with `/` is text, because that is what pasting means — then commands, then
   * `@handle`, then a run.
   */
  async feed(line: string): Promise<HandleResult> {
    const fed = this.multiline.feed(line);
    if (fed.kind === 'pending') return 'continue';
    return this.handle(fed.text, { literal: fed.literal });
  }

  /**
   * One complete message, multi-line accumulation already done.
   *
   * `literal` is what a `"""` block produces: the text is sent as written,
   * with no command, mention or path read out of it.
   */
  async handle(input: string, opts: { literal?: boolean } = {}): Promise<HandleResult> {
    const text = input.trim();
    if (text === '') return 'continue';

    // The owner said something here. That is what clears the unanswered
    // counter, whatever the message turns out to be — a command included.
    await this.#deps.engagement?.noteActivity();

    if (opts.literal) {
      // A """ block is text sent exactly as written, with nothing read out of
      // it. It is not read as an answer either: it goes to the active agent,
      // and it ends any pending question.
      this.#pending.clear(CLI_CHAT_ID);
      await this.runTurn(this.#agent, input);
      return 'continue';
    }

    // An agent that ended a one-shot turn asking the owner something owns the
    // owner's next message. Decided before commands so that every command
    // escapes the capture and ends it by the same rule.
    const claimed = this.#pending.claim(CLI_CHAT_ID, text, this.#deps.now().getTime());
    if (claimed.pending) {
      await this.#answerPending(claimed.pending, text);
      return 'continue';
    }

    const command = parseCommand(text);
    if (command && isKnownCommand(command.name)) {
      return this.#command(command.name, command.arg);
    }

    // `@ledger can I afford it?` — this one message goes to that agent, in that
    // agent's own conversation, and the session keeps the agent it was on.
    const mention = parseMention(text);
    if (mention) {
      const addressed = this.#deps.catalog.byHandle(mention.handle);
      if (!addressed) {
        this.#out(unknownHandleText(mention.handle));
        return 'continue';
      }
      if (mention.rest === '') {
        this.#out(emptyMentionText(addressed.handle));
        return 'continue';
      }
      const previous = this.#agent;
      const outcome = await this.runTurn(addressed, mention.rest);
      // The one-shot asked the owner something. It has no claim on the
      // session — but it does have a claim on the answer.
      if (outcome.askedOwner === true && addressed.id !== previous.id) {
        this.#pending.open(CLI_CHAT_ID, {
          askedAgentId: addressed.id,
          askedAgentName: addressed.name,
          previousAgentId: previous.id,
          previousAgentName: previous.name,
          at: this.#deps.now().getTime(),
        });
        this.#out(
          dim(
            `(${addressed.name} asked you something, so your next message goes there.)`,
            this.#style().color,
          ),
        );
      }
      return 'continue';
    }

    // A path on its own line is an offer, never an action: the owner confirms.
    const candidate = attachmentCandidate(text, {
      home: this.#deps.home ?? process.env.HOME ?? '',
      exists: this.#deps.fileExists ?? (() => false),
      ...(this.#deps.cwd ? { cwd: this.#deps.cwd } : {}),
    });
    if (candidate) {
      const answer = await this.#deps.ask(attachQuestion(text));
      if (saidYes(answer)) await this.attach(candidate);
      else this.#out(dim('Not attached.', this.#style().color));
      return 'continue';
    }

    if (command) {
      // A slash word that is neither a command nor a file.
      this.#out(unknownCommandText(command.name));
      return 'continue';
    }

    await this.runTurn(this.#agent, text);
    return 'continue';
  }

  /* ---------------------------------------------------------------- *
   * Commands
   * ---------------------------------------------------------------- */

  async #command(name: string, arg: string): Promise<HandleResult> {
    const color = this.#style().color;
    switch (name) {
      case '/quit':
        return 'quit';
      case '/help':
        this.#out(helpText());
        return 'continue';
      case '/clear':
        (this.#deps.clearScreen ?? ((): void => {}))();
        return 'continue';
      case '/agents':
        this.#out(this.agentsText());
        return 'continue';
      case '/use':
        await this.#use(arg);
        return 'continue';
      case '/whoami':
        this.#out(
          `You are talking to ${this.#agent.name} (@${this.#agent.handle}). ` +
            `You are the owner of this installation — /agents to switch.`,
        );
        return 'continue';
      case '/new':
        await this.newAgent(arg);
        return 'continue';
      case '/reset': {
        const id = await createConversation(this.#deps.pool, this.#agent.id);
        this.#conversations.set(this.#agent.id, id);
        this.#out(`New conversation with ${this.#agent.name}.`);
        this.#out(dim(id, color));
        return 'continue';
      }
      case '/id':
        this.#out(await this.conversationFor(this.#agent));
        return 'continue';
      case '/tools':
        this.#out(this.toolsText());
        return 'continue';
      case '/model':
        this.#out(this.modelText());
        return 'continue';
      case '/usage':
        this.#out(this.#usage.text());
        return 'continue';
      case '/status':
        await this.status();
        return 'continue';
      case '/recap':
        await this.recap();
        return 'continue';
      case '/reminders':
        await this.reminders(arg);
        return 'continue';
      case '/quiet':
        this.#out(
          this.#deps.engagement
            ? await this.#deps.engagement.quiet(arg)
            : QUIET_UNAVAILABLE_TEXT,
        );
        return 'continue';
      case '/files':
        await this.files(arg);
        return 'continue';
      case '/attach':
        await this.attachPath(arg);
        return 'continue';
      case '/devices':
        this.#out(
          devicesText(await listSurfaceIdentitiesDetailed(this.#deps.pool), this.#timezone()),
        );
        return 'continue';
      case '/approvals':
        this.#out(
          this.#deps.approvals
            ? await this.#deps.approvals.pending()
            : APPROVALS_UNAVAILABLE_TEXT,
        );
        return 'continue';
      case '/approve':
        await this.decide(arg, 'approved');
        return 'continue';
      case '/reject':
        await this.decide(arg, 'rejected');
        return 'continue';
      case '/resume':
        await this.resume(arg);
        return 'continue';
      default:
        this.#out(unknownCommandText(name));
        return 'continue';
    }
  }

  /** `/agents` — handle, provider, availability, and which one is active. */
  agentsText(): string {
    const color = this.#style().color;
    const agents = this.#deps.catalog.list();
    if (agents.length === 0) return 'No agents are installed.';
    const width = agents.reduce((max, a) => Math.max(max, a.handle.length), 0) + 1;
    const lines = agents.map((a) => {
      const active = a.id === this.#agent.id;
      const marker = active ? green('›', color) : ' ';
      const handle = `@${a.handle}`.padEnd(width + 1);
      const tail = a.available
        ? dim(`[${a.providerKind}]`, color)
        : yellow(`[${a.providerKind}: ${a.unavailableReason ?? 'unavailable'}]`, color);
      return `${marker} ${active ? bold(handle, color) : handle} ${a.name} — ${
        a.description
      } ${tail}`;
    });
    return ['Agents:', ...lines, '', 'Switch with /use <handle>, or start a message with @handle.'].join(
      '\n',
    );
  }

  /** `/tools` — what the *active* agent is granted, in registry order. */
  toolsText(): string {
    const color = this.#style().color;
    const granted = this.#deps.registry
      .list()
      .filter((spec) => this.#agent.tools.includes(spec.name));
    if (granted.length === 0) return `${this.#agent.name} has no tools.`;
    return [
      `${this.#agent.name} can call:`,
      ...granted.map(
        (spec) => `  ${bold(spec.name, color)} ${dim(`[${spec.tier}]`, color)} — ${spec.description}`,
      ),
    ].join('\n');
  }

  /** `/model` — the pin, the credential kind, and whether it can run at all. */
  modelText(): string {
    const agent = this.#agent;
    const lines = [
      `${agent.name} (@${agent.handle})`,
      `  provider: ${agent.provider.kind}`,
      `  model: ${agent.model}`,
      `  credential: ${agent.provider.credential.kind} (${agent.provider.credential.env})`,
    ];
    if (agent.provider.baseUrl) lines.push(`  base url: ${agent.provider.baseUrl}`);
    lines.push(
      agent.availability.ok
        ? '  available on this machine'
        : `  unavailable: [${agent.availability.problem.code}] ${agent.availability.problem.message}`,
    );
    return lines.join('\n');
  }

  /** `/use <handle|id>` — switch, or explain why not. Never a silent default. */
  async #use(arg: string): Promise<void> {
    const requested = arg.trim();
    if (requested === '') {
      this.#out(USE_WITHOUT_ID_TEXT);
      return;
    }
    let agent: CatalogAgent;
    try {
      agent = this.#deps.catalog.resolve(requested);
    } catch (err) {
      if (!isUnknownAgentError(err)) throw err;
      this.#out(UNKNOWN_AGENT_TEXT);
      return;
    }
    this.#agent = agent;
    // Switching agent is the owner saying who they are talking to; a question
    // somebody asked them before that does not outrank it.
    this.#pending.clear(CLI_CHAT_ID);
    const id = await this.conversationFor(agent);
    this.#out(`You are now talking to ${agent.name}.`);
    // Listed, not hidden, and said before the first message rather than as an
    // error after it: this machine cannot reach that agent's credential.
    if (!agent.availability.ok) {
      this.#out(
        yellow(
          `${agent.name} cannot run here: ${agent.availability.problem.message}`,
          this.#style().color,
        ),
      );
    }
    this.#out(dim(`conversation ${id}`, this.#style().color));
  }

  /**
   * `/new` — switch to whoever claims the `maker` role and open the interview.
   *
   * Unlike `/status`, the switch sticks: making an agent is a conversation, and
   * a session that bounced back to the previous agent after the first question
   * would strand the owner mid-interview. The opening line is sent as the owner
   * — they already said what they wanted by typing the command.
   */
  async newAgent(arg: string): Promise<void> {
    const resolution = this.#deps.catalog.agentForRole(ROLE_MAKER);
    if (!resolution.ok) {
      this.#out(NO_MAKER_TEXT);
      return;
    }
    const maker = resolution.agent;
    if (maker.id !== this.#agent.id) {
      this.#agent = maker;
      await this.conversationFor(maker);
      this.#out(`You are now talking to ${maker.name}.`);
      if (!maker.availability.ok) {
        this.#out(
          yellow(
            `${maker.name} cannot run here: ${maker.availability.problem.message}`,
            this.#style().color,
          ),
        );
      }
    }
    await this.runTurn(maker, newAgentOpening(arg), { carry: false });
  }

  /**
   * `/status` — answered by whichever agent claims the `overview` role, in that
   * agent's own conversation, whoever this session is talking to. The active
   * agent is left exactly as it was, same as Telegram. No agent claiming the
   * role is a fact about the installation, said plainly, not an error.
   */
  async status(): Promise<void> {
    const resolution = this.#deps.catalog.agentForRole(ROLE_OVERVIEW);
    if (!resolution.ok) {
      this.#out(roleUnavailableText(ROLE_OVERVIEW));
      return;
    }
    const overview = resolution.agent;
    if (overview.id !== this.#agent.id) {
      this.#out(
        dim(
          `(${overview.name} answers this one; you are still talking to ${this.#agent.name}.)`,
          this.#style().color,
        ),
      );
    }
    await this.runTurn(overview, 'Status', { carry: false });
  }

  /** `/recap` — the recap mission, run now through the same executor. */
  async recap(): Promise<void> {
    const resolution = this.#deps.catalog.agentForRole(ROLE_RECAP);
    if (!resolution.ok) {
      this.#out(roleUnavailableText(ROLE_RECAP));
      return;
    }
    const missionId = this.#deps.recapMissionId;
    if (missionId === undefined) {
      this.#out(NO_RECAP_MISSION_TEXT);
      return;
    }
    const runMission = this.#deps.runMission;
    if (!runMission) {
      this.#out(RECAP_UNAVAILABLE_TEXT);
      return;
    }
    const speaker = resolution.agent;
    const spinner = this.#deps.spinner;
    const startedAt = Date.now();
    spinner.start(handleLabel(speaker.handle));
    try {
      const outcome = await runMission(missionId, CLI_CHAT_ID, (name) =>
        spinner.noteToolCall(name),
      );
      spinner.stop();
      await this.#present(outcome.ok ? outcome.text : RECAP_NOT_REGISTERED_TEXT);
      if (outcome.ok) this.#footer({ turns: 0, tools: 0, startedAt });
    } catch (err) {
      spinner.stop();
      this.#out(red(`recap failed: ${errorText(err)}`, this.#style().color));
    }
  }

  /** `/reminders`, and `/reminders cancel <id>`. */
  async reminders(arg: string): Promise<void> {
    const parts = arg.split(/\s+/).filter((p) => p !== '');
    if ((parts[0] ?? '').toLowerCase() === 'cancel') {
      const id = parts[1];
      if (!id) {
        this.#out('Send /reminders cancel <id> — /reminders lists the ids.');
        return;
      }
      const resolved = await this.#resolveReminderId(id);
      if (!resolved) {
        this.#out(`Nothing pending matches "${id}".`);
        return;
      }
      const cancelled = await cancelReminder(
        this.#deps.pool,
        resolved,
        'cancelled by the owner in the terminal',
      );
      this.#out(cancelled ? 'Cancelled.' : 'That reminder is no longer pending.');
      return;
    }

    const reminders = await listReminders(this.#deps.pool, {
      state: 'pending',
      limit: REMINDERS_LIMIT,
    });
    if (reminders.length === 0) {
      this.#out('Nothing is on the clock.');
      return;
    }
    const color = this.#style().color;
    const lines = reminders.map((r) => {
      const agent = this.#deps.catalog.get(r.agentId);
      const who = agent ? handleLabel(agent.handle) || agent.name : r.agentId;
      return (
        `  ${bold(localDateTimeString(r.dueAt, this.#timezone()), color)} — ${firstLineOf(r.text)}\n` +
        `    ${dim(`${r.id}  set by ${who}`, color)}`
      );
    });
    this.#out(['On the clock:', ...lines, '', 'Drop one with /reminders cancel <id>.'].join('\n'));
  }

  /** A pending reminder id, from a full id or an unambiguous prefix. */
  async #resolveReminderId(input: string): Promise<string | undefined> {
    const wanted = input.trim().toLowerCase();
    const reminders = await listReminders(this.#deps.pool, {
      state: 'pending',
      limit: REMINDERS_LIMIT,
    });
    const matches = reminders
      .map((r) => r.id)
      .filter((id) => id.toLowerCase().startsWith(wanted));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** `/files [n]` — what this installation has stored, newest first. */
  async files(arg: string): Promise<void> {
    const limit = Number.parseInt(arg.trim(), 10);
    const rows = await listArtifacts(this.#deps.pool as unknown as Pool, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : FILES_LIMIT,
    });
    if (rows.length === 0) {
      this.#out('No files stored yet. Attach one with /attach <path>.');
      return;
    }
    const color = this.#style().color;
    this.#out(
      [
        'Recent files:',
        ...rows.map((r) => {
          const when = r.createdAt
            ? localDateTimeString(new Date(r.createdAt), this.#timezone())
            : 'unknown';
          return (
            `  ${bold(r.filename ?? '(unnamed)', color)} — ${r.kind}, ${formatBytes(r.sizeBytes)}, ${when}\n` +
            `    ${dim(r.id, color)}`
          );
        }),
      ].join('\n'),
    );
  }

  /* ---------------------------------------------------------------- *
   * Attachments
   * ---------------------------------------------------------------- */

  /** `/attach <path>` — resolve what the owner typed, then store it. */
  async attachPath(arg: string): Promise<void> {
    const raw = arg.trim();
    if (raw === '') {
      this.#out('Send /attach <path>, for example /attach ~/Downloads/statement.pdf');
      return;
    }
    const resolved = attachmentCandidate(raw, {
      home: this.#deps.home ?? process.env.HOME ?? '',
      exists: this.#deps.fileExists ?? (() => false),
      ...(this.#deps.cwd ? { cwd: this.#deps.cwd } : {}),
    });
    if (!resolved) {
      this.#out(`No file at ${raw}.`);
      return;
    }
    await this.attach(resolved);
  }

  /** Store one file and stage it for the next message. */
  async attach(absolutePath: string): Promise<void> {
    const store = this.#deps.artifacts;
    const readFile = this.#deps.readFile;
    if (!store || !readFile) {
      this.#out(FILES_UNAVAILABLE_TEXT);
      return;
    }
    if (this.#attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      this.#out(
        `That is one file too many: ${MAX_ATTACHMENTS_PER_MESSAGE} per message is the runtime's cap. Send this message first.`,
      );
      return;
    }
    try {
      const attached = await attachFile(absolutePath, {
        store,
        readFile,
        createdBy: this.#deps.ctx.ownerId,
      });
      this.#attachments.push(attached);
      const color = this.#style().color;
      this.#out(
        `Attached ${bold(attached.filename, color)} ${dim(
          `(${attached.mime}, ${formatBytes(attached.sizeBytes)})`,
          color,
        )}${attached.viewable ? '' : dim(' — read through the artifacts tools', color)}`,
      );
    } catch (err) {
      this.#out(red(`Could not attach that file: ${errorText(err)}`, this.#style().color));
    }
  }

  /* ---------------------------------------------------------------- *
   * /resume
   * ---------------------------------------------------------------- */

  /**
   * `/resume` — the picker. With an argument it takes a number from the last
   * list or a conversation id; with none it prints the list and asks.
   */
  async resume(arg: string): Promise<void> {
    const rows = await listRecentConversations(this.#deps.pool, this.#agent.id, 10);
    if (rows.length === 0) {
      this.#out(`No earlier conversations with ${this.#agent.name}.`);
      return;
    }
    const chosen = arg.trim() === '' ? await this.#pick(rows) : this.#choose(rows, arg.trim());
    if (!chosen) return;
    this.#conversations.set(this.#agent.id, chosen);
    this.#out(`Continuing ${dim(chosen, this.#style().color)} with ${this.#agent.name}.`);
  }

  #choose(rows: readonly ConversationLine[], answer: string): string | undefined {
    const index = Number.parseInt(answer, 10);
    if (Number.isFinite(index) && index >= 1 && index <= rows.length) {
      return (rows[index - 1] as ConversationLine).id;
    }
    const wanted = answer.toLowerCase();
    const match = rows.find((r) => r.id.toLowerCase().startsWith(wanted));
    if (match) return match.id;
    this.#out(`Nothing here matches "${answer}".`);
    return undefined;
  }

  async #pick(rows: readonly ConversationLine[]): Promise<string | undefined> {
    this.#out(this.resumeText(rows));
    const answer = (await this.#deps.ask('Which one? [1-' + rows.length + ', or blank] ')).trim();
    if (answer === '') {
      this.#out(dim('Staying where you are.', this.#style().color));
      return undefined;
    }
    return this.#choose(rows, answer);
  }

  /** The picker's list. Pure, so the numbering is testable. */
  resumeText(rows: readonly ConversationLine[]): string {
    const color = this.#style().color;
    return [
      `Recent conversations with ${this.#agent.name}:`,
      ...rows.map((r, i) => {
        const when = r.lastMessageAt ?? r.createdAt;
        const stamp = when ? localDateTimeString(when, this.#timezone()) : 'unknown';
        const preview = r.preview === '' ? dim('(nothing said)', color) : r.preview;
        return `  ${bold(String(i + 1), color)}. ${stamp} ${dim(
          `· ${r.messages} message${r.messages === 1 ? '' : 's'}`,
          color,
        )}\n     ${preview}\n     ${dim(r.id, color)}`;
      }),
    ].join('\n');
  }

  /* ---------------------------------------------------------------- *
   * Approvals
   * ---------------------------------------------------------------- */

  /** `/approve <id>` and `/reject <id>`. */
  async decide(arg: string, decision: 'approved' | 'rejected'): Promise<void> {
    const approvals = this.#deps.approvals;
    if (!approvals) {
      this.#out(APPROVALS_UNAVAILABLE_TEXT);
      return;
    }
    const resolved = await approvals.resolveId(arg);
    if (!resolved.ok) {
      this.#out(resolved.text);
      return;
    }
    const outcome = await approvals.decide(resolved.id, decision);
    this.#out(outcome.text);
    // A run started at *this* prompt is not durable, so nothing else will wake
    // it: the session feeds the decision back in itself.
    if (outcome.resume) await this.#continueAfterApproval(outcome.resume);
  }

  /**
   * The inline prompt, when a run this session started stops on a gated call.
   *
   * The preview is the one the *tool* rendered and stored on the action —
   * never model prose — and the three answers are the three honest ones.
   */
  async #askApproval(actionId: string): Promise<ApprovalResume | undefined> {
    const approvals = this.#deps.approvals;
    const action = await getAction(this.#deps.pool, actionId);
    if (action) this.#out(approvalRequestText(action, this.#timezone()));
    if (!approvals) {
      this.#out(APPROVALS_UNAVAILABLE_TEXT);
      return undefined;
    }

    for (;;) {
      const host = action?.tool === 'host.exec';
      const answer = (await this.#deps.ask(host ? 'Allow host command? [y] once / [c] conversation auto-mode / [a] always for this agent / [n] reject / [l] later: ' : APPROVAL_QUESTION)).trim().toLowerCase();
      if (answer === 'l' || answer === 'later') {
        this.#out(APPROVAL_LATER_TEXT);
        return undefined;
      }
      if (host && ['c', 'conversation', 'a', 'always'].includes(answer)) {
        const outcome = await approvals.decide(actionId, 'approved', answer.startsWith('c') ? 'conversation' : 'always');
        this.#out(outcome.text);
        return outcome.resume;
      }
      if (answer === 'y' || answer === 'yes' || answer === 'n' || answer === 'no') {
        const decision = answer.startsWith('y') ? 'approved' : 'rejected';
        const outcome = await approvals.decide(actionId, decision);
        this.#out(outcome.text);
        return outcome.resume;
      }
      this.#out(dim('y to approve, n to reject, l to decide later.', this.#style().color));
    }
  }

  /** Continue the suspended run with the outcome, in its own conversation. */
  async #continueAfterApproval(resume: ApprovalResume): Promise<void> {
    const action = await getAction(this.#deps.pool, resume.actionId);
    if (!action || !action.conversationId) return;
    const agent = this.#deps.catalog.get(action.agentId) ?? this.#agent;
    // Typing `/approve` is the owner acting, so the run it continues is an
    // owner request — the same rule the dashboard and Telegram follow.
    await this.#run(agent, action.conversationId, { resume, approval: { tool: action.tool } });
  }

  /* ---------------------------------------------------------------- *
   * Runs
   * ---------------------------------------------------------------- */

  /**
   * The owner's answer to a question a one-shot agent asked.
   *
   * It runs that agent, in that agent's own conversation, with the session's
   * agent untouched — the same shape a one-shot mention has, because that is
   * what this is: the second half of one the owner already sent. The marker is
   * the dim aside `/status` already uses when somebody other than the active
   * agent speaks, printed before the spinner so the owner sees the handle it is
   * about to run under.
   */
  async #answerPending(taken: PendingQuestion, text: string): Promise<void> {
    const asked = this.#deps.catalog.get(taken.askedAgentId);
    if (!asked) {
      // Deleted between the question and the answer: there is nothing to hand
      // it to, so it goes to the active agent as it would have.
      await this.runTurn(this.#agent, text);
      return;
    }

    const color = this.#style().color;
    this.#out(
      dim(
        `(${taken.askedAgentName} asked that, so this goes there; you are still talking to ${taken.previousAgentName}.)`,
        color,
      ),
    );
    // An answer belongs to the turn that asked it: a conversation boundary
    // never lands between a question and its answer.
    const outcome = await this.runTurn(asked, text, { carry: false, continuation: true });
    const again = outcome.askedOwner === true && taken.captures < MAX_CAPTURES;
    this.#pending.settle(CLI_CHAT_ID, taken, outcome.askedOwner === true, this.#deps.now().getTime());
    this.#out(dim(capturedNote(taken, { stillAsking: again }), color));
  }

  /**
   * The conversation this turn runs in — which is not always the one the last
   * turn ran in.
   *
   * `conversationFor` above answers "which conversation is this session's
   * thread with this agent". This asks whether that thread is still live, by
   * the rule Telegram and the dashboard share: three hours idle, or a
   * transcript past the size budget. A terminal session left open overnight is
   * the ordinary way this happens. `/reset` is unchanged and still does it in
   * one word.
   *
   * The boundary is silent. It used to print one dim line above the answer;
   * the owner does not need to know a transcript rolled over, since what the
   * agent remembers about them is not kept in one.
   */
  async #conversationForTurn(
    agent: CatalogAgent,
    opts: { continuation?: boolean } = {},
  ): Promise<string> {
    const current = this.#conversations.get(agent.id);
    const { conversationId, boundary } = await conversationForTurn(this.#deps.pool, {
      ...(current === undefined ? {} : { current }),
      start: async () => {
        const id = await createConversation(this.#deps.pool, agent.id);
        this.#conversations.set(agent.id, id);
        return id;
      },
      now: this.#deps.now(),
      ...(opts.continuation === undefined ? {} : { continuation: opts.continuation }),
      log: (line: string) => this.#deps.log?.(line),
    });
    if (boundary) {
      // The thread a question was asked in is over; nothing may still claim the
      // owner's next message on its behalf. Nothing is printed: which
      // transcript this turn runs in is bookkeeping, and `/status` says which
      // conversation this is for anyone who wants to know.
      this.#pending.clear(CLI_CHAT_ID);
    }
    return conversationId;
  }

  /** One owner turn with one agent. */
  async runTurn(
    agent: CatalogAgent,
    text: string,
    opts: { carry?: boolean; continuation?: boolean } = {},
  ): Promise<TurnOutcome> {
    const conversationId = await this.#conversationForTurn(agent, {
      ...(opts.continuation === undefined ? {} : { continuation: opts.continuation }),
    });
    // Files staged with /attach ride with exactly one message, the way a
    // Telegram caption rides with the document it arrived on.
    const staged = opts.carry === false ? [] : this.#attachments;
    this.#attachments = [];
    // Every file goes as a reference; the runtime writes the model's note
    // from it at send time, and the transcript keeps only the reference.
    const attachments: AttachmentRef[] = staged.map((a) => ({
      artifactId: a.artifactId,
      mime: a.mime,
      kind: a.kind,
      filename: a.filename,
      sizeBytes: a.sizeBytes,
    }));

    return this.#run(agent, conversationId, {
      userMessage: text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  /**
   * The very first turn of a brand-new installation, with the default agent.
   *
   * The caller has already claimed the first run in core; this only runs it.
   * The owner has typed nothing yet, so the turn opens with a bare hello and
   * the whole of what they read is written by the agent, following its
   * first-run skill — there is no greeting in this file to go stale.
   */
  async firstRun(): Promise<TurnOutcome> {
    const agent = this.#deps.catalog.defaultAgent();
    const conversationId = await this.conversationFor(agent);
    return this.#run(agent, conversationId, {
      userMessage: 'Hello.',
      systemSuffix: FIRST_RUN_SUFFIX,
    });
  }

  /**
   * The one shared shape of a run: spinner up, runtime, spinner down, answer,
   * footer — and the approval prompt when the run stops instead of finishing.
   */
  async #run(
    agent: CatalogAgent,
    conversationId: string,
    turn: {
      userMessage?: string;
      resume?: ApprovalResume;
      /** Set only with `resume`, and only when an owner decision is what wakes it. */
      approval?: ApprovalResumption;
      attachments?: AttachmentRef[];
      depth?: number;
      /** One extra instruction for this turn, after the surface paragraph. */
      systemSuffix?: string;
    },
  ): Promise<TurnOutcome> {
    const deps = this.#deps;
    const spinner = deps.spinner;
    const startedAt = Date.now();
    let tools = 0;

    // `conversation.ask` is registered per run, the way the mission tools are:
    // a copy of the base registry, so nothing outside an interactive turn can
    // call it. It is how a turn declares that it ended on a question.
    const sink: AskSink = {};
    // Its sibling: what this turn offers the owner to do next. The terminal has
    // nothing to tap, which is not a reason to withhold the tool — the offers
    // are real rows, the dashboard can take one, and here they are said in
    // words. That decision is `renderOffers`', from the declared profile.
    const offers: OfferSink = {};
    const registry = new ToolRegistry();
    for (const manifest of deps.registry.manifests()) registry.register(manifest);
    registry.register(createAskManifest(sink));
    registry.register(createOfferManifest(offers));

    // An offer belongs to the turn that made it: this turn's first act is to
    // withdraw whatever the previous one left on the table.
    await withdrawTurnOffers(deps.pool, conversationId, deps.now());

    const base = agent.definition(deps.now(), this.#timezone());
    const options: RunAgentOptions = {
      agent: { ...base, tools: [...base.tools, ...ASK_TOOLS, ...OFFER_TOOLS] },
      provider: deps.providerFor(agent),
      registry,
      ctx: turn.approval ? approvalResumeContext(deps.ctx, turn.approval) : deps.ctx,
      pool: deps.pool,
      // The provider's own web search leaves the same audit row `web.search`
      // does; see @buddi/tool-web's native.ts.
      onNativeSearch: nativeSearchRecorder(deps.pool),
      conversationId,
      // The terminal renders markdown, so it declares that it does. The
      // profile is composed into the prompt by the loop; a turn's own
      // instruction is separate and stays a one-off.
      surface: CLI_SURFACE,
      systemSuffix: [
        ASK_POLICY_SUFFIX,
        OFFER_POLICY_SUFFIX,
        ...(turn.systemSuffix === undefined ? [] : [turn.systemSuffix]),
      ].join('\n\n'),
      ...(turn.userMessage !== undefined ? { userMessage: turn.userMessage } : {}),
      ...(turn.resume ? { resume: turn.resume } : {}),
      ...(turn.attachments ? { attachments: turn.attachments } : {}),
      ...(deps.memoryPreamble ? { memoryPreamble: deps.memoryPreamble } : {}),
      ...(deps.artifacts ? { loadArtifact: (id: string) => deps.artifacts!.load(id) } : {}),
      onToolCall: (name) => {
        tools++;
        spinner.noteToolCall(name);
      },
    };

    spinner.start(handleLabel(agent.handle));
    let result: RunResult | undefined;
    try {
      result = await this.#cancellable(runAgent(options));
    } catch (err) {
      spinner.stop();
      // The cause chain goes to stderr, where an operator finds it; the prompt
      // gets sentences. `renderOffers` reads CLI_SURFACE — nothing to tap here
      // — so a retry is spelled out as something the owner can ask for.
      const outcome = await failedTurnReply(deps.pool, {
        error: err,
        profile: CLI_SURFACE,
        agentId: agent.id,
        agentName: handleLabel(agent.handle),
        conversationId,
        ...(turn.userMessage === undefined ? {} : { prompt: turn.userMessage }),
        toolsCalled: tools,
        now: deps.now(),
        log: deps.log ?? ((line) => console.error(line)),
      });
      this.#out(red(outcome.rendered.text, this.#style().color));
      return { stopped: 'failed' };
    } finally {
      spinner.stop();
    }

    if (result === undefined) {
      this.#out(dim('cancelled — the turn was already sent, so it stays in the transcript.', this.#style().color));
      return { stopped: 'cancelled' };
    }

    // Safety net, not the mechanism: CLI_SURFACE says markdown renders here,
    // and nothing tells the model to name a tool. This catches one that did.
    const text = stripToolNames(result.text).trim();
    // Whatever this turn offered, stored and then said. `renderOffers` reads
    // CLI_SURFACE — no buttons here — and spells them out as things the owner
    // can ask for, which is what they actually are at a prompt.
    const stored =
      result.stopped === 'awaiting-approval'
        ? []
        : await storeTurnOffers(deps.pool, {
            sink: offers,
            agentId: agent.id,
            conversationId,
            now: deps.now(),
          });
    const shown = renderOffers(CLI_SURFACE, text, stored).text;
    if (shown !== '') await this.#present(shown);
    this.#usage.record(
      result.snapshot.servedModel ?? result.snapshot.model,
      result.usage,
      result.turns,
      tools,
    );
    this.#footer({ turns: result.turns, tools, startedAt, result });

    if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
      const depth = turn.depth ?? 0;
      const resume = await this.#askApproval(result.pendingActionId);
      if (resume && depth < MAX_APPROVAL_CONTINUATIONS) {
        return this.#run(agent, conversationId, { resume, depth: depth + 1 });
      }
      // Waiting on a button, not on an answer: no claim on the next message.
      return { stopped: 'awaiting-approval', pendingActionId: result.pendingActionId };
    }
    return {
      stopped: result.stopped,
      askedOwner: turnAskedOwner(sink.asked !== undefined, text),
    };
  }

  /**
   * Race the run against Ctrl-C.
   *
   * The provider call cannot be un-sent, so cancelling is exactly what it says:
   * the session stops waiting and gives the prompt back. Whatever the run
   * eventually writes is already durable and stays in the transcript — said out
   * loud rather than hidden, because a half-run turn the owner cannot see would
   * be worse than one they were told about.
   */
  async #cancellable<T>(work: Promise<T>): Promise<T | undefined> {
    let resolveCancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      resolveCancel = (): void => resolve(undefined);
    });
    this.#cancel = resolveCancel;
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      this.#cancel = null;
      // An abandoned run must not become an unhandled rejection.
      void work.catch(() => {});
    }
  }

  /** Long answers go through the pager when the caller wired one. */
  async #present(text: string): Promise<void> {
    const rendered = renderMarkdown(text, this.#style());
    if (this.#deps.present) await this.#deps.present(rendered);
    else this.#out(rendered);
  }

  /** `turns 2 · tools 3 · in 1,204 / out 318 · 4.1s`. Suppressed by --quiet. */
  #footer(run: { turns: number; tools: number; startedAt: number; result?: RunResult }): void {
    if (this.#deps.quiet) return;
    const seconds = ((Date.now() - run.startedAt) / 1000).toFixed(1);
    const usage = run.result?.usage;
    const parts = [
      `${run.turns} turn${run.turns === 1 ? '' : 's'}`,
      `${run.tools} tool${run.tools === 1 ? '' : 's'}`,
      ...(usage ? [`in ${usage.input.toLocaleString('en-US')} / out ${usage.output.toLocaleString('en-US')}`] : []),
      // Only when there were any: a footer that says "0 web searches" on every
      // turn is noise, and the meter only matters when it moved.
      ...(usage?.webSearches ? [formatWebSearches(usage.webSearches)] : []),
      `${seconds}s`,
    ];
    this.#out(dim(parts.join(' · '), this.#style().color));
  }
}

function firstLineOf(text: string): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
