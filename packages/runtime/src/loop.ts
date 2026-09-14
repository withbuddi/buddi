/**
 * The agent loop. Proposes tool calls, consumes results, persists everything.
 *
 * It never executes an effect itself: every tool call goes through
 * `ToolRegistry.invoke`, which is where the trust model lives. A refusal is not
 * an exception — it comes back to the model as an error-flagged tool_result, so
 * the model can see *that* it was refused and why.
 *
 * Fail closed at startup: an agent naming a tool the registry does not have
 * throws before any provider call is made.
 */
import type { AgentDefinition, ToolContext, ToolRegistry } from '@buddi/core';
import type {
  ContentBlock,
  NeutralMessage,
  RuntimeProvider,
  ToolSchema,
  Usage,
} from './anthropic.js';
import {
  assertAttachmentCount,
  hydrateContent,
  hydrateMessages,
  toArtifactRefBlocks,
  type AttachmentRef,
  type LoadArtifact,
} from './attachments.js';

/**
 * The narrow slice of `pg.Pool` the loop needs. Depending on this instead of
 * `Pool` keeps the loop testable with a two-line in-memory stub.
 */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface RunAgentOptions {
  agent: AgentDefinition;
  provider: RuntimeProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  pool: Queryable;
  conversationId: string;
  /** The owner's turn. Omitted only when `resume` carries the turn instead. */
  userMessage?: string;
  /**
   * An extra system line appended to the agent's prompt for this run only —
   * how the surface tells the agent about its own rendering constraints
   * ("Telegram: plain text, no tables"). Presentation, not policy: it never
   * changes tools, tiers or authorization, and it is not persisted with the
   * agent definition.
   */
  systemSuffix?: string;
  /**
   * What the agent remembers, rendered as a system-prompt preamble for this run.
   *
   * The runtime holds no memory schema: it asks for a block of text by agent id
   * and prepends it. Whoever wires the run decides where it comes from (the
   * memory plugin, in this build) — and whether there is any memory at all.
   * An empty string means "no block", not an empty heading.
   */
  memoryPreamble?: (agentId: string) => Promise<string>;
  /**
   * Files handed in with this message — a Telegram photo, a dropped statement.
   * Metadata only: the bytes are hydrated for the API call and never persisted
   * into `core.messages`, which stores the reference instead.
   */
  attachments?: AttachmentRef[];
  /**
   * How the runtime gets an attachment's bytes back. Injected because the
   * runtime owns no artifact schema — whoever wires the run points it at the
   * store. Absent means "this run carries no files"; a reference it cannot
   * resolve becomes a visible placeholder, never a silent omission.
   */
  loadArtifact?: LoadArtifact;
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  /**
   * Resuming a run that stopped awaiting an approval.
   *
   * The tool_use that asked for it was already answered (with "awaiting owner
   * approval"), so the outcome comes back as this run's opening turn instead —
   * a tool result delivered late, and said in those words. Exactly one of
   * `userMessage` and `resume` carries the turn; both, or neither, is a defect.
   */
  resume?: ApprovalResume;
  /** Called the moment a tool call becomes a pending approval. */
  onApprovalRequired?: (actionId: string, preview: string) => void;
}

/** How a decided action comes back into the run that proposed it. */
export interface ApprovalResume {
  actionId: string;
  /** The approval's state now: 'succeeded', 'failed', 'rejected', 'unknown'… */
  state: string;
  /** What the effect returned, when it ran. */
  result?: unknown;
  error?: string;
}

export interface RunResult {
  text: string;
  turns: number;
  /**
   * `awaiting-approval` is not an end: the run is suspendable at that point and
   * `pendingActionId` names what it is waiting for. Everything durable has
   * already been written, so no worker and no transaction stays open.
   */
  stopped: 'end_turn' | 'max_turns' | 'max_tokens' | 'awaiting-approval';
  usage: Usage;
  /** Set only when `stopped === 'awaiting-approval'`. */
  pendingActionId?: string;
}

/**
 * What the model is told while it waits. It names the action, so the transcript
 * carries the link between the proposal and the decision that follows it.
 */
export function awaitingApprovalText(actionId: string): string {
  return `awaiting owner approval (action ${actionId}); this effect has not happened`;
}

/**
 * The tool result that comes back late, once the owner has decided.
 *
 * Written as a plain user turn because the tool_use it belongs to was already
 * answered before the run suspended: the API requires that, and inventing a
 * second result for the same call would be a lie about what happened.
 */
export function approvalOutcomeText(resume: ApprovalResume): string {
  const head = `tool result (deferred) for action ${resume.actionId}: ${resume.state}`;
  if (resume.state === 'succeeded') {
    return `${head}\nresult: ${JSON.stringify(resume.result ?? null)}`;
  }
  if (resume.state === 'rejected') {
    return `${head}\nThe owner rejected it. Do not propose the same effect again unless asked; say what you will do instead.`;
  }
  if (resume.state === 'unknown') {
    return `${head}\nThe effect was dispatched and never confirmed. Do not retry it: say plainly that it is unresolved.`;
  }
  return `${head}${resume.error ? `\nerror: ${resume.error}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * Persistence helpers (core.conversations / core.messages / core.events)
 * ------------------------------------------------------------------ */

export async function createConversation(
  pool: Queryable,
  agentId: string,
): Promise<string> {
  const { rows } = await pool.query(
    `insert into core.conversations (agent_id) values ($1) returning id`,
    [agentId],
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) {
    throw new Error('createConversation: insert returned no id');
  }
  return String(id);
}

export async function loadMessages(
  pool: Queryable,
  conversationId: string,
): Promise<NeutralMessage[]> {
  const { rows } = await pool.query(
    `select role, content from core.messages
      where conversation_id = $1
      order by created_at asc, id asc`,
    [conversationId],
  );
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: normalizeContent(r.content),
  }));
}

/** jsonb comes back parsed from `pg`; tolerate a string for other drivers. */
function normalizeContent(raw: unknown): ContentBlock[] {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  return Array.isArray(value) ? (value as ContentBlock[]) : [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function persistMessage(
  pool: Queryable,
  conversationId: string,
  role: 'user' | 'assistant',
  content: ContentBlock[],
): Promise<void> {
  await pool.query(
    `insert into core.messages (conversation_id, role, content)
     values ($1, $2, $3::jsonb)`,
    [conversationId, role, JSON.stringify(content)],
  );
}

async function appendEvent(
  pool: Queryable,
  kind: string,
  payload: unknown,
  conversationId: string,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)`,
    [kind, conversationId, JSON.stringify(payload ?? null)],
  );
}

/* ------------------------------------------------------------------ *
 * Tool selection — fail closed before the first API call
 * ------------------------------------------------------------------ */

export function selectTools(registry: ToolRegistry, agent: AgentDefinition): ToolSchema[] {
  const specs = new Map(registry.list().map((s) => [s.name, s]));
  const selected: ToolSchema[] = [];
  for (const name of agent.tools) {
    const spec = specs.get(name);
    if (!spec) {
      throw new Error(
        `agent '${agent.id}' requires tool '${name}', which is not registered`,
      );
    }
    selected.push({
      name: spec.name,
      description: spec.description,
      input_schema: spec.inputSchema,
    });
  }
  return selected;
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * The system prompt for one run: what the agent remembers, then the agent's own
 * prompt, then an optional surface hint.
 *
 * Memory goes first and the persona second on purpose — the persona's rules are
 * the last word the model reads, so a remembered line can never read as an
 * override of them.
 */
export function composeSystem(
  systemPrompt: string,
  systemSuffix?: string,
  memoryPreamble?: string,
): string {
  const suffix = (systemSuffix ?? '').trim();
  const memory = (memoryPreamble ?? '').trim();
  const body = suffix === '' ? systemPrompt : `${systemPrompt}\n\n${suffix}`;
  return memory === '' ? body : `${memory}\n\n${body}`;
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const { agent, provider, registry, ctx, pool, conversationId, userMessage } = opts;
  const resume = opts.resume;

  // A turn comes from the owner or from a decided approval — never from both,
  // and never from neither.
  if ((userMessage === undefined) === (resume === undefined)) {
    throw new Error('runAgent: pass exactly one of userMessage and resume');
  }
  const openingText = resume ? approvalOutcomeText(resume) : (userMessage as string);

  // Fail closed: unknown tool names are a configuration defect, not a runtime
  // refusal — and they are caught before a single token is sent anywhere.
  const tools = selectTools(registry, agent);
  const memory = opts.memoryPreamble ? await opts.memoryPreamble(agent.id) : '';
  const system = composeSystem(agent.systemPrompt, opts.systemSuffix, memory);

  // Provenance for every tool call this run makes. The caller's context is not
  // mutated: it is shared across runs, and a run's identity is its own.
  // Provenance rides along: a gated call records the job it belongs to on the
  // action, which is how the decision later finds the run that is suspended.
  const toolCtx: ToolContext = { ...ctx, conversationId, agentId: agent.id };

  // Attachments: cap first, hydrate second, persist third. The caps fail closed
  // before anything is written, so an over-limit message leaves no half-state.
  const attachments = opts.attachments ?? [];
  assertAttachmentCount(attachments);

  const history = await loadMessages(pool, conversationId);
  // Stored history carries artifact_ref blocks; the provider needs the bytes.
  const replayed = await hydrateMessages(history, opts.loadArtifact);

  const userBlocks: ContentBlock[] = [
    { type: 'text', text: openingText },
    ...toArtifactRefBlocks(attachments),
  ];
  const sentUserBlocks = await hydrateContent(userBlocks, opts.loadArtifact, {
    enforceCaps: true,
  });
  // What is persisted is the reference, never the base64.
  await persistMessage(pool, conversationId, 'user', userBlocks);
  const messages: NeutralMessage[] = [
    ...replayed,
    { role: 'user', content: sentUserBlocks },
  ];

  await appendEvent(
    pool,
    resume ? 'run.resumed' : 'run.started',
    {
      agentId: agent.id,
      tools: agent.tools,
      maxTurns: agent.maxTurns,
      ...(resume ? { actionId: resume.actionId, approvalState: resume.state } : {}),
    },
    conversationId,
  );

  const usage: Usage = { input: 0, output: 0 };
  let turns = 0;
  let stopped: RunResult['stopped'] = 'max_turns';
  let text = '';
  /** The action this run is waiting on, once one exists. */
  let pendingActionId: string | undefined;

  while (turns < agent.maxTurns) {
    turns++;
    const res = await provider.complete({
      system,
      messages,
      tools,
    });
    usage.input += res.usage.input;
    usage.output += res.usage.output;

    const assistantContent = res.content;
    messages.push({ role: 'assistant', content: assistantContent });
    await persistMessage(pool, conversationId, 'assistant', assistantContent);

    const turnText = textOf(assistantContent);
    if (turnText) {
      text = turnText;
      opts.onText?.(turnText);
    }

    const toolUses = assistantContent.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    if (res.stopReason !== 'tool_use' || toolUses.length === 0) {
      stopped = res.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
      break;
    }

    const results: ContentBlock[] = [];
    for (const call of toolUses) {
      opts.onToolCall?.(call.name, call.input);
      await appendEvent(
        pool,
        'tool.called',
        { name: call.name, input: call.input },
        conversationId,
      );

      const outcome = await registry.invoke(call.name, call.input, toolCtx);
      if (outcome.ok) {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(outcome.output ?? null),
        });
        await appendEvent(
          pool,
          'tool.result',
          { name: call.name, ok: true },
          conversationId,
        );
      } else if (outcome.reason === 'approval-required') {
        // Not a refusal: the call was recorded as an action and the owner has
        // been asked. The tool_use is answered so the transcript stays valid,
        // and it is answered *without* `is_error` — nothing went wrong.
        //
        // Every remaining call in this turn is still answered (the API requires
        // one result per tool_use), and the run then stops: it is resumable
        // from durable state alone, with no worker and no transaction held.
        if (pendingActionId === undefined) pendingActionId = outcome.actionId;
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: awaitingApprovalText(outcome.actionId),
        });
        opts.onApprovalRequired?.(outcome.actionId, outcome.preview);
        await appendEvent(
          pool,
          'tool.result',
          {
            name: call.name,
            ok: false,
            reason: outcome.reason,
            actionId: outcome.actionId,
          },
          conversationId,
        );
      } else {
        // The model gets to see refusals, verbatim reason included.
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `${outcome.reason}: ${outcome.message}`,
          is_error: true,
        });
        await appendEvent(
          pool,
          'tool.result',
          { name: call.name, ok: false, reason: outcome.reason },
          conversationId,
        );
      }
    }

    messages.push({ role: 'user', content: results });
    await persistMessage(pool, conversationId, 'user', results);

    if (pendingActionId !== undefined) {
      stopped = 'awaiting-approval';
      break;
    }
  }

  await appendEvent(
    pool,
    'run.finished',
    { turns, stopped, usage, ...(pendingActionId ? { actionId: pendingActionId } : {}) },
    conversationId,
  );

  return {
    text,
    turns,
    stopped,
    usage,
    ...(pendingActionId ? { pendingActionId } : {}),
  };
}
