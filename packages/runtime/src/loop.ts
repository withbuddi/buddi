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
  userMessage: string;
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
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}

export interface RunResult {
  text: string;
  turns: number;
  stopped: 'end_turn' | 'max_turns' | 'max_tokens';
  usage: Usage;
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

  // Fail closed: unknown tool names are a configuration defect, not a runtime
  // refusal — and they are caught before a single token is sent anywhere.
  const tools = selectTools(registry, agent);
  const memory = opts.memoryPreamble ? await opts.memoryPreamble(agent.id) : '';
  const system = composeSystem(agent.systemPrompt, opts.systemSuffix, memory);

  // Provenance for every tool call this run makes. The caller's context is not
  // mutated: it is shared across runs, and a run's identity is its own.
  const toolCtx: ToolContext = { ...ctx, conversationId, agentId: agent.id };

  const history = await loadMessages(pool, conversationId);
  const userBlocks: ContentBlock[] = [{ type: 'text', text: userMessage }];
  await persistMessage(pool, conversationId, 'user', userBlocks);
  const messages: NeutralMessage[] = [...history, { role: 'user', content: userBlocks }];

  await appendEvent(
    pool,
    'run.started',
    { agentId: agent.id, tools: agent.tools, maxTurns: agent.maxTurns },
    conversationId,
  );

  const usage: Usage = { input: 0, output: 0 };
  let turns = 0;
  let stopped: RunResult['stopped'] = 'max_turns';
  let text = '';

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
  }

  await appendEvent(pool, 'run.finished', { turns, stopped, usage }, conversationId);

  return { text, turns, stopped, usage };
}
