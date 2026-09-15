/**
 * The terminal surface, end to end, with a fake provider and an in-memory
 * database. No terminal is involved anywhere: `out`, `ask` and the spinner are
 * ports, so everything the owner would see is a string this test can read.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, roleProblemMessage, type Queryable, type ToolContext } from '@buddi/core';
import { z } from 'zod';
import type { CompletionRequest, CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import type { AgentCatalog, CatalogAgent } from '../telegram/types.js';
import type { ArtifactStore } from '../telegram/attachments.js';
import type { ApprovalPort } from './approvals.js';
import { NO_MAKER_TEXT } from '../telegram/surface.js';
import { ChatSession } from './session.js';
import { silentSpinner } from './spinner.js';
import type { TerminalStyle } from './terminal.js';

/* ---------------- in-memory core tables ---------------- */

const ACTION_ID = '22222222-2222-2222-2222-222222222222';
const REMINDER_ID = '33333333-3333-3333-3333-333333333333';

class FakeDb implements Queryable {
  conversations: { id: string; agent_id: string }[] = [];
  messages: {
    id: number;
    conversation_id: string;
    role: string;
    content: unknown;
    /** When it was written, by this fake's clock — the lifetime rule reads it. */
    at: Date;
  }[] = [];
  /** The clock rows are stamped with, so a transcript can be given an age. */
  clock: () => number = () => Date.now();
  events: { kind: string; payload: unknown }[] = [];
  reminders: Record<string, unknown>[] = [];
  artifacts: Record<string, unknown>[] = [];
  actions: Record<string, unknown>[] = [];
  offers: Record<string, unknown>[] = [];
  withdrawn: string[] = [];
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
        at: new Date(this.clock()),
      });
      return { rows: [] };
    }
    if (text.startsWith('select role, content from core.messages')) {
      const rows = this.messages
        .filter((m) => m.conversation_id === params[0])
        .map((m) => ({ role: m.role, content: m.content }));
      // Two readers, one prefix: the runtime replays the whole transcript, and
      // closing a failed turn asks only what the last message was.
      return { rows: text.includes('order by created_at desc') ? rows.slice(-1) : rows };
    }
    // The lifetime vitals. `at` is the per-message clock this fake stamps, so a
    // test can age a conversation without sleeping.
    if (text.startsWith('select coalesce(count(m.id), 0) as messages')) {
      if (!this.conversations.some((c) => c.id === params[0])) return { rows: [] };
      const rows = this.messages.filter((m) => m.conversation_id === params[0]);
      return {
        rows: [
          {
            messages: rows.length,
            last_at: rows.at(-1)?.at ?? null,
            chars: rows.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0),
          },
        ],
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
    if (text.startsWith('insert into core.offers')) {
      const row = {
        id: `offer-${this.offers.length + 1}`,
        agent_id: params[0],
        conversation_id: params[1],
        label: params[2],
        prompt: params[3],
        created_at: params[4],
        expires_at: params[5],
        taken_at: null,
        taken_via: null,
        taken_job_id: null,
      };
      this.offers.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('update core.offers set expires_at')) {
      const stale = this.offers.filter(
        (o) => o.conversation_id === params[0] && o.taken_at === null,
      );
      for (const row of stale) row.expires_at = params[1];
      this.withdrawn.push(...stale.map((o) => o.id as string));
      return { rows: stale.map((o) => ({ id: o.id })) };
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
  roles: string[] = [],
): CatalogAgent {
  return {
    id,
    handle,
    name,
    description: `${name}, for testing`,
    isDefault,
    roles,
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
    agentsWithRole: (role: string) => agents.filter((a) => a.roles.includes(role)),
    agentForRole: (role: string) => {
      const found = agents.find((a) => a.roles.includes(role));
      return found
        ? { ok: true, agent: found }
        : {
            ok: false,
            problem: { code: 'no-agent-for-role', role, message: roleProblemMessage(role) },
          };
    },
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

const LEDGER = catalogAgent('finance-advisor', 'ledger', 'Finance Advisor', true, [], [
  'overview',
  'recap',
]);
const SCOUT = catalogAgent('scout', 'scout', 'Scout');
/** The maker. `/new` reaches it by role; nothing in the session names it. */
const FATHER = catalogAgent('agent-father', 'father', 'Agent Father', false, [], ['maker']);

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
    /** A provider that does something other than answer — a failing one. */
    provider?: RuntimeProvider;
  } = {},
): Harness {
  const db = new FakeDb();
  const lines: string[] = [];
  const provider = scriptedProvider(opts.responses ?? [textResponse('Here is the answer.')]);
  const adapter = opts.provider ?? provider;
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
    providerFor: () => adapter,
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

/** A provider whose call fails, the way the owner's did. */
function failingProvider(err: unknown): RuntimeProvider {
  return {
    async complete(): Promise<CompletionResponse> {
      throw err;
    },
  } as RuntimeProvider;
}

/** `fetch failed`, with the fault that actually happened on `cause`. */
function transportFailure(): Error {
  return Object.assign(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    }),
    { type: 'transport_error', status: 0 },
  );
}

/* ---------------- the tests ---------------- */

/**
 * The terminal used to print `error: fetch failed` — the same non-answer
 * Telegram gave, in a different colour. It says something now, and because
 * `CLI_SURFACE` declares it has nothing to tap, the retry is spelled out as a
 * sentence the owner can ask for rather than a button that is not there.
 */
describe('a turn that fails at the prompt', () => {
  it('says what happened in words, and never the raw error', async () => {
    const h = harness({ provider: failingProvider(transportFailure()) });
    await h.session.handle('draft a reply to Parfait');
    expect(h.text()).toContain("couldn't reach the model");
    expect(h.text()).not.toContain('fetch failed');
    expect(h.text()).not.toContain('UND_ERR_SOCKET');
  });

  it('offers the retry as words, and stores the owner\u2019s own sentence', async () => {
    const h = harness({ provider: failingProvider(transportFailure()) });
    await h.session.handle('draft a reply to Parfait');
    expect(h.text()).toContain('Try again');
    expect(h.db.offers).toHaveLength(1);
    expect(h.db.offers[0]?.prompt).toBe('draft a reply to Parfait');
  });

  it('offers nothing when trying again would fail the same way', async () => {
    const h = harness({
      provider: failingProvider(
        Object.assign(new Error('bad request'), { type: 'invalid_request_error', status: 400 }),
      ),
    });
    await h.session.handle('draft a reply to Parfait');
    expect(h.text()).toContain('trying again would fail');
    expect(h.db.offers).toHaveLength(0);
  });

  it('closes the turn in the transcript instead of leaving it hanging', async () => {
    const h = harness({ provider: failingProvider(transportFailure()) });
    await h.session.handle('draft a reply to Parfait');
    // His message is still there. What follows it is the truth about it.
    expect(h.db.messages[0]?.role).toBe('user');
    const marker = h.db.messages[1];
    expect(marker?.role).toBe('assistant');
    expect(JSON.stringify(marker?.content)).toContain('This turn failed before I could answer');
  });
});

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

describe('a one-shot that ends by asking the owner something', () => {
  const WHAT_TIME = 'What time tonight should I set that for — 8pm, 9pm, something else?';

  it('captures the owner answer, marks where it went, and hands the chat back', async () => {
    const h = harness({
      responses: [
        textResponse(WHAT_TIME),
        textResponse('Set for 7pm tonight.'),
        textResponse('Nothing else due today.'),
      ],
    });

    await h.session.handle('@scout remind me tonight to move the sites off cloudways');
    await h.session.handle('7pm');
    await h.session.handle('and what is due today?');

    // The answer went to the agent that asked, in that agent conversation…
    expect(h.db.conversations.map((c) => c.agent_id)).toEqual(['scout', 'finance-advisor']);
    expect(h.text()).toContain('Set for 7pm tonight.');
    // …the session never changed hands…
    expect(h.session.agent.id).toBe('finance-advisor');
    // …and both ends of the detour are said out loud.
    expect(h.text()).toContain('(Scout asked you something, so your next message goes there.)');
    expect(h.text()).toContain(
      '(Scout asked that, so this goes there; you are still talking to Finance Advisor.)',
    );
    expect(h.text()).toContain(
      '(Scout asked that, so your answer went there; you are back with Finance Advisor now.)',
    );
    // The message after that is the active agent's again.
    expect(h.text()).toContain('Nothing else due today.');
  });

  it('changes nothing when the owner has actually switched with /use', async () => {
    const h = harness({
      responses: [textResponse(WHAT_TIME), textResponse('Set for 7pm tonight.')],
    });
    await h.session.handle('/use scout');
    await h.session.handle('remind me tonight to move the sites');
    await h.session.handle('7pm');

    expect(h.session.agent.id).toBe('scout');
    expect(h.db.conversations.map((c) => c.agent_id)).toEqual(['scout']);
    expect(h.text()).not.toContain('asked that');
  });

  it('lets a command, a third agent and a fresh request escape', async () => {
    for (const escape of ['/whoami', '@ledger how much is left?', 'remind me to call the bank']) {
      const h = harness({ responses: [textResponse(WHAT_TIME), textResponse('ok')] });
      await h.session.handle('@scout remind me tonight');
      await h.session.handle(escape);
      expect(h.text(), escape).not.toContain('asked that, so this goes there');
    }
  });

  it('does not fire when the one-shot simply answered', async () => {
    const h = harness({
      responses: [textResponse('I can do that.'), textResponse('Here is the answer.')],
    });
    await h.session.handle('@scout can you do that?');
    await h.session.handle('thanks');
    expect(h.db.conversations.map((c) => c.agent_id)).toEqual(['scout', 'finance-advisor']);
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

  it('/reset starts a fresh conversation with the same agent', async () => {
    const h = harness();
    await h.session.handle('hello');
    const first = h.db.conversations.length;
    await h.session.handle('/reset');
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

describe('/new — the maker, by role', () => {
  it('switches to the maker and opens with the owner sentence', async () => {
    const h = harness({ agents: [LEDGER, SCOUT, FATHER] });
    await h.session.handle('/new');

    const request = h.provider.requests.at(-1) as any;
    expect(JSON.stringify(request.messages)).toContain('I want to make a new agent.');
    expect(h.text()).toContain('You are now talking to Agent Father.');
    // It sticks: the next plain sentence is still the maker's to answer.
    expect(h.session.agent.id).toBe('agent-father');
  });

  it('opens with what the owner typed when they said more', async () => {
    const h = harness({ agents: [LEDGER, SCOUT, FATHER] });
    await h.session.handle('/new something that watches my GitHub issues');
    const request = h.provider.requests.at(-1) as any;
    const sent = JSON.stringify(request.messages);
    expect(sent).toContain('something that watches my GitHub issues');
    expect(sent).not.toContain('I want to make a new agent.');
  });

  it('says so in one line when nobody claims the role, and runs nothing', async () => {
    const h = harness({ agents: [LEDGER, SCOUT] });
    await h.session.handle('/new');
    expect(h.lines).toEqual([NO_MAKER_TEXT]);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.session.agent.id).toBe('finance-advisor');
  });
});

/* ------------------------------------------------------------------ *
 * Offered actions at a prompt
 * ------------------------------------------------------------------ */

/**
 * The terminal has nothing to tap, and that is not a reason to withhold the
 * tool. The offers a turn declares are real rows — the dashboard can take one,
 * and the owner can take one here by asking for it in words — so what changes
 * between surfaces is only how they are *said*. That decision belongs to
 * `renderOffers` and the declared profile, and this is the half of it the
 * terminal sees: a short list of things the owner can ask for, under the
 * answer, and only when the turn genuinely offered something.
 */
describe('a turn that offers the owner something to do, at a prompt', () => {
  const offerCall = (actions: { label: string; prompt: string }[]): CompletionResponse =>
    toolResponse('conversation.offer', { actions });

  it('says the offers in words, because the terminal has no buttons', async () => {
    const h = harness({
      responses: [
        offerCall([
          { label: 'Send it', prompt: 'send the reply I drafted to Dorothée' },
          { label: 'Edit the draft', prompt: 'change the second paragraph of that reply' },
        ]),
        textResponse("The draft is ready. It hasn't been sent."),
      ],
    });
    await h.session.handle('draft a reply to Dorothée');

    const shown = h.text();
    expect(shown).toContain("It hasn't been sent.");
    expect(shown).toContain('You can ask me to:');
    expect(shown).toContain('Send it');
    expect(shown).toContain('Edit the draft');

    // Stored, bound to the agent and this conversation — the same rows the
    // dashboard lists and Telegram binds a button to.
    expect(h.db.offers).toHaveLength(2);
    expect(h.db.offers[0]).toMatchObject({
      agent_id: 'finance-advisor',
      conversation_id: 'conv-1',
      label: 'Send it',
      prompt: 'send the reply I drafted to Dorothée',
    });
  });

  it('adds nothing at all to a turn that offered nothing', async () => {
    const h = harness();
    await h.session.handle('anything due?');
    expect(h.text()).toBe('Here is the answer.');
    expect(h.db.offers).toEqual([]);
  });

  it('withdraws the previous turn’s offers when the owner says something else', async () => {
    const h = harness({
      responses: [
        offerCall([{ label: 'Send it', prompt: 'send the reply I drafted' }]),
        textResponse('Drafted.'),
        textResponse('Sure, something else.'),
      ],
    });
    await h.session.handle('draft a reply');
    expect(h.db.offers).toHaveLength(1);

    // The owner ignores the offer and moves on. The turn that moves on is the
    // turn that retires what the last one left on the table.
    await h.session.handle('what is my balance?');
    expect(h.db.withdrawn).toContain('offer-1');
    expect(h.db.offers[0]?.expires_at).toEqual(new Date('2026-09-14T12:00:00Z'));
  });
});

/*
 * The terminal keeps one conversation per agent for the length of the process,
 * which is the right thing for a session and the wrong thing for a session left
 * open overnight. The rule is the one Telegram and the dashboard use, and it is
 * applied where the turn starts rather than where the session does.
 */
describe('a conversation has a lifetime here too', () => {
  const NOW = Date.parse('2026-09-14T12:00:00Z');

  /** Backdate everything already written, as if the owner walked away. */
  function walkAway(h: Harness, hours: number): void {
    for (const m of h.db.messages) m.at = new Date(NOW - hours * 3_600_000);
  }

  it('continues the thread when the owner comes back ten minutes later', async () => {
    const h = harness({ responses: [textResponse('One.'), textResponse('Two.')] });
    h.db.clock = () => NOW;
    await h.session.handle('any new mail?');
    for (const m of h.db.messages) m.at = new Date(NOW - 10 * 60_000);

    await h.session.handle('and the other one?');
    expect(h.db.conversations).toHaveLength(1);
    expect(h.text()).not.toContain('New conversation');
  });

  it('starts a fresh one the next morning, and says why', async () => {
    const h = harness({ responses: [textResponse('One.'), textResponse('Two.')] });
    h.db.clock = () => NOW;
    await h.session.handle('any new mail?');
    walkAway(h, 14);

    await h.session.handle('any new mail?');
    expect(h.db.conversations).toHaveLength(2);
    expect(h.text()).toContain('(New conversation — we last spoke 14 hours ago.');
    // The second run replayed nothing of the first: that is the whole point.
    // (The request object is the live message array, so the answer it appended
    // after the call is in it too — the owner's message is the only history.)
    const sent = h.provider.requests.at(-1)?.messages ?? [];
    expect(sent.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('starts a fresh one when the transcript has grown past its budget', async () => {
    const h = harness({
      responses: [textResponse('x'.repeat(90_000)), textResponse('Two.')],
    });
    h.db.clock = () => NOW;
    await h.session.handle('read me everything');
    await h.session.handle('and now something else');
    expect(h.db.conversations).toHaveLength(2);
    expect(h.text()).toContain('the last one had grown long');
  });

  it('a failed turn is not answered by the next message', async () => {
    // The live sequence: the run dies, the owner is told, and hours later he
    // asks something else. Before this, the dead question came back as the
    // opening paragraph of the answer to the new one.
    const requests: CompletionRequest[] = [];
    let calls = 0;
    const provider: RuntimeProvider = {
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        requests.push(req);
        calls += 1;
        if (calls === 1) throw transportFailure();
        return textResponse('Here is the Dorothée draft.');
      },
    };
    const h = harness({ provider });
    h.db.clock = () => NOW;

    await h.session.handle('draft a response to Parfait Sedjro');
    expect(h.text()).toContain("couldn't reach the model");

    await h.session.handle('can you draft a reply to the mail of Dorothee Tabiou?');
    const history = requests.at(-1)?.messages ?? [];
    // Parfait is still in the transcript — the record does not lie — but the
    // turn after it says it failed, so nothing reads as outstanding work.
    // The request object is the live array the loop appends to, so the answer
    // this run produced is on the end of it; the history is what precedes it.
    const roles = history.map((m) => m.role);
    expect(roles.slice(0, 3)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(history[1])).toContain('This turn failed before I could answer');
    expect(JSON.stringify(history[2])).toContain('Dorothee');
  });
});
