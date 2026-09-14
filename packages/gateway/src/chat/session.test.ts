/**
 * The terminal surface, end to end, with a fake provider and an in-memory
 * database. No terminal is involved anywhere: `out`, `ask` and the spinner are
 * ports, so everything the owner would see is a string this test can read.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type Queryable, type ToolContext } from '@buddi/core';
import { z } from 'zod';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { AgentCatalog, CatalogAgent } from '../telegram/types.js';
import type { ArtifactStore } from '../telegram/attachments.js';
import type { ApprovalPort } from './approvals.js';
import { ChatSession } from './session.js';
import { silentSpinner } from './spinner.js';
import type { TerminalStyle } from './terminal.js';

/* ---------------- in-memory core tables ---------------- */

const ACTION_ID = '22222222-2222-2222-2222-222222222222';
const REMINDER_ID = '33333333-3333-3333-3333-333333333333';

class FakeDb implements Queryable {
  conversations: { id: string; agent_id: string }[] = [];
  messages: { id: number; conversation_id: string; role: string; content: unknown }[] = [];
  events: { kind: string; payload: unknown }[] = [];
  reminders: Record<string, unknown>[] = [];
  artifacts: Record<string, unknown>[] = [];
  actions: Record<string, unknown>[] = [];
  #seq = 0;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
    }
    if (text.startsWith('insert into core.messages')) {
      this.messages.push({
        id: ++this.#seq,
        conversation_id: params[0],
        role: params[1],
        content: JSON.parse(params[2]),
      });
      return { rows: [] };
    }
    if (text.startsWith('select role, content from core.messages')) {
      return {
        rows: this.messages
          .filter((m) => m.conversation_id === params[0])
          .map((m) => ({ role: m.role, content: m.content })),
      };
    }
    if (text.startsWith('insert into core.events')) {
      this.events.push({ kind: params[0], payload: JSON.parse(params[2]) });
      return { rows: [] };
    }
    if (text.startsWith('with a as ( insert into core.actions')) {
      const row = {
        id: ACTION_ID,
        tool: params[0],
        tool_version: params[1],
        agent_id: params[2],
        conversation_id: params[3],
        job_id: params[4],
        canonical_args: JSON.parse(params[5]),
        envelope: JSON.parse(params[6]),
        args_hash: params[7],
        preview: params[8],
        expires_at: params[9],
        policy_version: params[10],
        created_at: params[11],
        state: 'pending',
        updated_at: params[11],
      };
      this.actions.push(row);
      return { rows: [row] };
    }
    if (text.includes('from core.actions a') || text.includes('from core.actions')) {
      return { rows: this.actions.filter((a) => a.id === params[0]) };
    }
    if (text.startsWith('select') && text.includes('from core.reminders')) {
      const state = params[1] ?? null;
      return {
        rows: this.reminders.filter((r) => state === null || r.state === state),
      };
    }
    if (text.startsWith('update core.reminders')) {
      const row = this.reminders.find((r) => r.id === params[0] && r.state === 'pending');
      if (!row) return { rows: [] };
      row.state = 'cancelled';
      row.cancel_reason = params[1];
      return { rows: [row] };
    }
    if (text.includes('from core.artifacts')) {
      return { rows: this.artifacts };
    }
    if (text.startsWith('select c.id,')) {
      return {
        rows: this.conversations
          .filter((c) => c.agent_id === params[0])
          .map((c) => ({
            id: c.id,
            created_at: new Date('2026-09-10T10:00:00Z'),
            last_at: new Date('2026-09-10T10:05:00Z'),
            message_count: this.messages.filter((m) => m.conversation_id === c.id).length,
            first_user: this.messages.find(
              (m) => m.conversation_id === c.id && m.role === 'user',
            )?.content,
          })),
      };
    }
    if (text.startsWith('select id from core.surface_identities') || text.includes('surface_identities')) {
      return { rows: [] };
    }
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

/* ---------------- a scripted provider ---------------- */

function textResponse(text: string): CompletionResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'fake-model-1',
  };
}

function toolResponse(name: string, input: unknown): CompletionResponse {
  return {
    content: [{ type: 'tool_use', id: 'tu-1', name, input }],
    stopReason: 'tool_use',
    usage: { input: 12, output: 6 },
    model: 'fake-model-1',
  };
}

function scriptedProvider(
  responses: CompletionResponse[],
): RuntimeProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let i = 0;
  return {
    requests,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      requests.push(req);
      const next = responses[i++] ?? textResponse('nothing more to say');
      return next;
    },
  } as RuntimeProvider & { requests: CompletionRequest[] };
}

/* ---------------- a fake catalog ---------------- */

const PROVIDER = {
  kind: 'anthropic' as const,
  credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
  model: 'fake-model-1',
};

function catalogAgent(
  id: string,
  handle: string,
  name: string,
  isDefault = false,
  tools: string[] = [],
): CatalogAgent {
  return {
    id,
    handle,
    name,
    description: `${name}, for testing`,
    isDefault,
    providerKind: 'anthropic',
    available: true,
    file: `${id}/agent.md`,
    model: PROVIDER.model,
    tools,
    maxTurns: 4,
    language: 'mirror',
    provider: PROVIDER,
    availability: { ok: true },
    skills: [],
    systemPromptTemplate: `${name}. Today is {{today}}.`,
    definition: () => ({
      id,
      name,
      systemPrompt: name,
      tools,
      provider: PROVIDER,
      maxTurns: 4,
    }),
  } as unknown as CatalogAgent;
}

function fakeCatalog(agents: CatalogAgent[]): AgentCatalog {
  const byDefault = agents.find((a) => a.isDefault) ?? (agents[0] as CatalogAgent);
  const handleOf = (raw: string): string => raw.trim().replace(/^@/, '').toLowerCase();
  return {
    get: (id) => agents.find((a) => a.id === id),
    byHandle: (handle) => agents.find((a) => a.handle === handleOf(handle)),
    list: () => agents,
    defaultAgent: () => byDefault,
    resolve: (idOrHandle) => {
      if (!idOrHandle) return byDefault;
      const found =
        agents.find((a) => a.id === idOrHandle) ?? agents.find((a) => a.handle === handleOf(idOrHandle));
      if (!found) {
        const err = new Error(`unknown agent: ${idOrHandle}`);
        err.name = 'UnknownAgentError';
        throw err;
      }
      return found;
    },
  } as AgentCatalog;
}

/* ---------------- the harness ---------------- */

const LEDGER = catalogAgent('finance-advisor', 'ledger', 'Finance Advisor', true);
const SCOUT = catalogAgent('scout', 'scout', 'Scout');

const STYLE: TerminalStyle = { color: false, width: 80, tty: false };

interface Harness {
  session: ChatSession;
  db: FakeDb;
  lines: string[];
  provider: ReturnType<typeof scriptedProvider>;
  answers: string[];
  asked: string[];
  text(): string;
}

function harness(
  opts: {
    responses?: CompletionResponse[];
    agents?: CatalogAgent[];
    registry?: ToolRegistry;
    artifacts?: ArtifactStore;
    approvals?: ApprovalPort;
    answers?: string[];
    files?: Record<string, Buffer>;
    quiet?: boolean;
    clearScreen?: () => void;
  } = {},
): Harness {
  const db = new FakeDb();
  const lines: string[] = [];
  const provider = scriptedProvider(opts.responses ?? [textResponse('Here is the answer.')]);
  const answers = opts.answers ?? [];
  const asked: string[] = [];
  const catalog = fakeCatalog(opts.agents ?? [LEDGER, SCOUT]);
  const ctx: ToolContext = {
    db: db as never,
    ownerId: 'owner',
    now: () => new Date('2026-09-14T12:00:00Z'),
    timezone: 'America/New_York',
  };
  const session = new ChatSession({
    pool: db,
    catalog,
    registry: opts.registry ?? new ToolRegistry(),
    ctx,
    now: () => new Date('2026-09-14T12:00:00Z'),
    timezone: 'America/New_York',
    providerFor: () => provider,
    agent: catalog.defaultAgent(),
    out: (text) => void lines.push(text),
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
    style: STYLE,
    spinner: silentSpinner(),
    quiet: opts.quiet !== false,
    home: '/home/owner',
    cwd: '/work',
    fileExists: (candidate) => Object.hasOwn(opts.files ?? {}, candidate),
    readFile: async (candidate) => (opts.files ?? {})[candidate] as Buffer,
    ...(opts.clearScreen ? { clearScreen: opts.clearScreen } : {}),
    ...(opts.artifacts ? { artifacts: opts.artifacts } : {}),
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
  });
  return { session, db, lines, provider, answers, asked, text: () => lines.join('\n') };
}

/* ---------------- the tests ---------------- */

describe('a plain turn', () => {
  it('runs the active agent and prints the answer', async () => {
    const h = harness();
    await h.session.handle('can I afford a bike?');
    expect(h.text()).toContain('Here is the answer.');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.db.conversations).toEqual([{ id: 'conv-1', agent_id: 'finance-advisor' }]);
  });

  it('records what the run cost, for /usage', async () => {
    const h = harness();
    await h.session.handle('hello');
    const usage = h.session.usage.text();
    expect(usage).toContain('fake-model-1');
    expect(usage).toContain('in 10 / out 5');
  });

  it('prints a compact footer, and prints none when --quiet', async () => {
    const loud = harness({ quiet: false });
    await loud.session.handle('hello');
    const footer = loud.lines.at(-1) as string;
    expect(footer).toMatch(/1 turn · 0 tools · in 10 \/ out 5 · \d+\.\ds/);

    const quiet = harness();
    await quiet.session.handle('hello');
    expect(quiet.lines.at(-1)).toBe('Here is the answer.');
  });
});

describe('/use', () => {
  it('switches agent, and the next message runs the new one in its own conversation', async () => {
    const h = harness({ responses: [textResponse('Scout here.')] });
    await h.session.handle('/use scout');
    expect(h.session.agent.id).toBe('scout');
    expect(h.text()).toContain('Scout');

    await h.session.handle('what is new?');
    expect(h.text()).toContain('Scout here.');
    // A fresh conversation, owned by the new agent: two agents never share one.
    const scoutConversations = h.db.conversations.filter((c) => c.agent_id === 'scout');
    expect(scoutConversations).toHaveLength(1);
    expect(
      h.db.messages.filter((m) => m.conversation_id === (scoutConversations[0] as { id: string }).id),
    ).not.toHaveLength(0);
  });

  it('refuses an unknown agent instead of falling back to the default', async () => {
    const h = harness();
    await h.session.handle('/use nobody');
    expect(h.session.agent.id).toBe('finance-advisor');
    expect(h.text()).toContain('Unknown agent');
  });

  it('says how to use it when given nothing', async () => {
    const h = harness();
    await h.session.handle('/use');
    expect(h.text()).toContain('/use');
    expect(h.session.agent.id).toBe('finance-advisor');
  });
});

describe('@handle', () => {
  it('routes one message without switching', async () => {
    const h = harness({ responses: [textResponse('Scout answering once.')] });
    await h.session.handle('@scout just this once');
    expect(h.text()).toContain('Scout answering once.');
    // Still talking to the agent we started on.
    expect(h.session.agent.id).toBe('finance-advisor');
    expect(h.db.conversations.map((c) => c.agent_id)).toEqual(['scout']);
  });

  it('names an unknown handle rather than running anything', async () => {
    const h = harness();
    await h.session.handle('@nobody hello');
    expect(h.text()).toContain('nobody');
    expect(h.provider.requests).toHaveLength(0);
  });

  it('asks what to say when the mention carries no question', async () => {
    const h = harness();
    await h.session.handle('@scout');
    expect(h.text()).toContain('Scout');
    expect(h.provider.requests).toHaveLength(0);
  });
});

describe('/attach', () => {
  function fakeStore(): ArtifactStore & { saved: unknown[] } {
    const saved: unknown[] = [];
    return {
      saved,
      async save(input) {
        saved.push(input);
        return {
          id: 'art-1',
          kind: 'image',
          mime: input.mime,
          filename: input.filename ?? null,
          sizeBytes: input.bytes.length,
          sha256: 'abc',
          storagePath: 'x/y.png',
          caption: null,
          createdAt: '2026-09-14T12:00:00Z',
        };
      },
      async load() {
        return { mime: 'image/png', data: Buffer.from('bytes').toString('base64') };
      },
    } as ArtifactStore & { saved: unknown[] };
  }

  it('stores the file, shows it on the prompt, and hands it to the next run', async () => {
    const store = fakeStore();
    const h = harness({
      artifacts: store,
      files: { '/home/owner/Downloads/x.png': Buffer.from('bytes') },
    });

    await h.session.handle('/attach ~/Downloads/x.png');
    expect(h.text()).toContain('x.png');
    expect(h.session.attachments).toHaveLength(1);
    expect(h.session.prompt()).toContain('1 file');

    await h.session.handle('what is in this?');
    // The persisted turn holds the reference, never the bytes.
    const userTurn = h.db.messages.find((m) => m.role === 'user');
    expect(JSON.stringify(userTurn?.content)).toContain('artifact_ref');
    expect(JSON.stringify(userTurn?.content)).toContain('artifact id art-1');
    // What the provider was sent carries the image itself.
    const sent = JSON.stringify(h.provider.requests[0]?.messages);
    expect(sent).toContain('image');
    // One message, one set of files.
    expect(h.session.attachments).toHaveLength(0);
    expect(h.session.prompt()).not.toContain('file');
  });

  it('offers to attach a bare path, and does nothing when told no', async () => {
    const store = fakeStore();
    const h = harness({
      artifacts: store,
      files: { '/work/budget.csv': Buffer.from('a,b') },
      answers: ['n'],
    });
    await h.session.handle('budget.csv');
    expect(h.asked[0]).toContain('Attach budget.csv?');
    expect(h.session.attachments).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });

  it('attaches a bare path on a bare Enter, because the offer defaults to yes', async () => {
    const store = fakeStore();
    const h = harness({
      artifacts: store,
      files: { '/work/budget.csv': Buffer.from('a,b') },
      answers: [''],
    });
    await h.session.handle('budget.csv');
    expect(store.saved).toHaveLength(1);
    expect(h.session.attachments).toHaveLength(1);
  });

  it('says so plainly when no path is there', async () => {
    const h = harness({ artifacts: fakeStore() });
    await h.session.handle('/attach ~/nope.pdf');
    expect(h.text()).toContain('No file at');
  });
});

describe('approvals', () => {
  /** A tool that is always gated: calling it records an action and stops. */
  function gatedRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: 'finance',
      version: '0.1.0',
      schema: 'finance',
      migrationsDir: '',
      tools: [
        {
          name: 'finance.pay',
          description: 'pay a bill',
          tier: 'gated',
          input: z.object({ amount: z.number() }),
          async describe(args) {
            return { envelope: args, preview: `Pay $${(args as { amount: number }).amount}` };
          },
          async execute() {
            return { paid: true };
          },
        },
      ],
    });
    return registry;
  }

  function approvalPort(): ApprovalPort & { decisions: string[] } {
    const decisions: string[] = [];
    return {
      decisions,
      async pending() {
        return 'Waiting for you: one thing.';
      },
      async resolveId(input) {
        return { ok: true, id: input };
      },
      async decide(actionId, decision) {
        decisions.push(`${actionId}:${decision}`);
        return decision === 'approved'
          ? {
              text: 'Approved and done — finance.pay',
              resume: { actionId, state: 'succeeded', result: { paid: true } },
            }
          : { text: 'Rejected — finance.pay', resume: { actionId, state: 'rejected' } };
      },
    };
  }

  const gatedAgent = catalogAgent('finance-advisor', 'ledger', 'Finance Advisor', true, [
    'finance.pay',
  ]);

  it('prints the stored preview, prompts, and on y executes and resumes the run', async () => {
    const approvals = approvalPort();
    const h = harness({
      agents: [gatedAgent, SCOUT],
      registry: gatedRegistry(),
      approvals,
      answers: ['y'],
      responses: [
        toolResponse('finance.pay', { amount: 40 }),
        textResponse('Paid, and your balance is fine.'),
      ],
    });

    await h.session.handle('pay the electricity bill');

    // The preview comes from the action the tool rendered, not from the model.
    expect(h.text()).toContain('Pay $40');
    expect(h.asked.some((q) => q.includes('[y]es'))).toBe(true);
    expect(approvals.decisions).toEqual([`${ACTION_ID}:approved`]);
    // The run continued with the outcome, in the same conversation.
    expect(h.text()).toContain('Paid, and your balance is fine.');
    expect(h.provider.requests).toHaveLength(2);
    const resumed = JSON.stringify(h.provider.requests[1]?.messages);
    expect(resumed).toContain('tool result (deferred)');
    expect(resumed).toContain('succeeded');
  });

  it('rejects on n, and tells the model it was rejected', async () => {
    const approvals = approvalPort();
    const h = harness({
      agents: [gatedAgent, SCOUT],
      registry: gatedRegistry(),
      approvals,
      answers: ['n'],
      responses: [
        toolResponse('finance.pay', { amount: 40 }),
        textResponse('Understood, I will not.'),
      ],
    });
    await h.session.handle('pay it');
    expect(approvals.decisions).toEqual([`${ACTION_ID}:rejected`]);
    expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('rejected');
  });

  it('leaves it pending on l, and never decides anything', async () => {
    const approvals = approvalPort();
    const h = harness({
      agents: [gatedAgent, SCOUT],
      registry: gatedRegistry(),
      approvals,
      answers: ['l'],
      responses: [toolResponse('finance.pay', { amount: 40 })],
    });
    await h.session.handle('pay it');
    expect(approvals.decisions).toEqual([]);
    expect(h.text()).toContain('/approvals');
    expect(h.provider.requests).toHaveLength(1);
  });

  it('asks again when the answer is neither y, n nor l — it never auto-approves', async () => {
    const approvals = approvalPort();
    const h = harness({
      agents: [gatedAgent, SCOUT],
      registry: gatedRegistry(),
      approvals,
      answers: ['maybe', 'l'],
      responses: [toolResponse('finance.pay', { amount: 40 })],
    });
    await h.session.handle('pay it');
    expect(approvals.decisions).toEqual([]);
    expect(h.asked.filter((q) => q.includes('[y]es'))).toHaveLength(2);
  });

  it('answers /approvals from the same machinery Telegram uses', async () => {
    const h = harness({ approvals: approvalPort() });
    await h.session.handle('/approvals');
    expect(h.text()).toContain('Waiting for you');
  });

  it('says approvals are not wired up rather than failing', async () => {
    const h = harness();
    await h.session.handle('/approvals');
    expect(h.text()).toContain('not wired up');
  });
});

describe('/reminders', () => {
  function withReminder(): Harness {
    const h = harness();
    h.db.reminders.push({
      id: REMINDER_ID,
      agent_id: 'finance-advisor',
      conversation_id: null,
      due_at: new Date('2026-09-15T13:00:00Z'),
      text: 'Card statement closes',
      context: null,
      state: 'pending',
      created_at: new Date('2026-09-14T12:00:00Z'),
      fired_at: null,
      cancelled_at: null,
      cancel_reason: null,
    });
    return h;
  }

  it('lists what is on the clock, with the id needed to cancel it', async () => {
    const h = withReminder();
    await h.session.handle('/reminders');
    expect(h.text()).toContain('Card statement closes');
    expect(h.text()).toContain(REMINDER_ID);
    expect(h.text()).toContain('Ledger');
  });

  it('cancels one by id', async () => {
    const h = withReminder();
    await h.session.handle(`/reminders cancel ${REMINDER_ID}`);
    expect(h.text()).toContain('Cancelled.');
    expect(h.db.reminders[0]?.state).toBe('cancelled');
  });

  it('cancels by an unambiguous prefix', async () => {
    const h = withReminder();
    await h.session.handle('/reminders cancel 33333333');
    expect(h.db.reminders[0]?.state).toBe('cancelled');
  });

  it('says nothing matches rather than cancelling the wrong one', async () => {
    const h = withReminder();
    await h.session.handle('/reminders cancel 99999999');
    expect(h.text()).toContain('Nothing pending matches');
    expect(h.db.reminders[0]?.state).toBe('pending');
  });

  it('has a plain answer when nothing is on the clock', async () => {
    const h = harness();
    await h.session.handle('/reminders');
    expect(h.text()).toContain('Nothing is on the clock');
  });
});

describe('the rest of the command table', () => {
  it('/help lists every command', async () => {
    const h = harness();
    await h.session.handle('/help');
    expect(h.text()).toContain('/agents');
    expect(h.text()).toContain('/attach');
    expect(h.text()).toContain('/usage');
  });

  it('/agents marks the active one and names each provider', async () => {
    const h = harness();
    await h.session.handle('/agents');
    expect(h.text()).toContain('@ledger');
    expect(h.text()).toContain('@scout');
    expect(h.text()).toContain('[anthropic]');
  });

  it('/model says what this agent runs on', async () => {
    const h = harness();
    await h.session.handle('/model');
    expect(h.text()).toContain('anthropic');
    expect(h.text()).toContain('fake-model-1');
    expect(h.text()).toContain('api-key');
  });

  it('/new starts a fresh conversation with the same agent', async () => {
    const h = harness();
    await h.session.handle('hello');
    const first = h.db.conversations.length;
    await h.session.handle('/new');
    expect(h.db.conversations.length).toBe(first + 1);
  });

  it('/id prints the conversation the session is writing to', async () => {
    const h = harness();
    await h.session.handle('/id');
    expect(h.text()).toContain('conv-1');
  });

  it('/usage says nothing has run yet before anything has', async () => {
    const h = harness();
    await h.session.handle('/usage');
    expect(h.text()).toContain('Nothing run yet');
  });

  it('/clear clears the screen and leaves the conversation alone', async () => {
    const cleared = vi.fn();
    const h = harness({ clearScreen: cleared });
    await h.session.handle('hello');
    const messages = h.db.messages.length;
    const conversations = h.db.conversations.length;
    await h.session.handle('/clear');
    expect(cleared).toHaveBeenCalledOnce();
    expect(h.db.messages).toHaveLength(messages);
    expect(h.db.conversations).toHaveLength(conversations);
  });

  it('answers an unknown command with a pointer to /help', async () => {
    const h = harness();
    await h.session.handle('/wat');
    expect(h.text()).toContain('/help');
    expect(h.provider.requests).toHaveLength(0);
  });

  it('/quit asks the caller to leave', async () => {
    const h = harness();
    expect(await h.session.handle('/quit')).toBe('quit');
  });
});

describe('multi-line input', () => {
  it('sends one message for a backslash continuation', async () => {
    const h = harness();
    expect(await h.session.feed('the first half \\')).toBe('continue');
    expect(h.provider.requests).toHaveLength(0);
    await h.session.feed('and the second');
    expect(h.provider.requests).toHaveLength(1);
    const sent = JSON.stringify(h.provider.requests[0]?.messages);
    expect(sent).toContain('the first half \\nand the second');
  });

  it('does not read a slash command inside a """ block', async () => {
    const h = harness();
    await h.session.feed('"""');
    await h.session.feed('/help');
    await h.session.feed('"""');
    expect(h.text()).not.toContain('/agents');
    expect(h.provider.requests).toHaveLength(1);
  });
});
