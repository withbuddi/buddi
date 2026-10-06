/**
 * `agent.delegate` — one agent asking another to answer a question (roadmap
 * step 5, "delegation via the queue", synchronous first cut).
 *
 * The tool runs a *nested* agent run: a new conversation for the target agent,
 * persisted exactly like any other, with the caller's task as the user message.
 * The nested run's reply comes back as text; the caller's model then uses it.
 * Nothing about the nested run is privileged — the target gets its own file's
 * tools, its own persona and the same registry, so delegation can never widen a
 * grant: an agent cannot reach a tool through a colleague that it could not
 * reach itself, because the colleague's grant is its own file's grant.
 *
 * Authorization is in code and fails closed (docs/architecture.md, "Trust model"):
 *
 *  - the caller must be known (`ctx.agentId`) — an anonymous run delegates nothing;
 *  - the target must appear in the caller's allowlist, which the host resolves
 *    from a file next to the agent; no allowlist means no delegation, except for
 *    the front desk and the maker, whom the host lets ask everyone by default;
 *  - the target must exist in the catalog — an unknown id is refused, never
 *    coerced to the default agent;
 *  - depth is capped: a delegated run carries `delegationDepth`, and the tool
 *    refuses at depth >= 1. A delegate cannot re-delegate, so a cycle cannot
 *    exist and a turn cannot fan out into a tree of runs.
 *  - the nested turn budget is capped (8) whatever the target's file says.
 *
 * One thing *is* inherited: the caller's surface profile. The delegate's
 * answer is quoted onto the caller's screen, so it must be composed for that
 * screen — a colleague writing a markdown table for a Telegram reply is a
 * broken message, not a broken colleague.
 *
 * Refusals are thrown: `ToolRegistry.invoke` turns them into an error-flagged
 * tool_result, so the calling model sees *that* it was refused and why.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  getArtifact,
  listArtifacts,
  readArtifactBytes,
  type AgentDefinition,
  type CoreToolContext,
  type ToolDefinition,
  type ToolRegistry,
} from '@buddi/core';
import type { RuntimeProvider } from './anthropic.js';
import { createConversation, runAgent as defaultRunAgent, type Queryable, type RunResult } from './loop.js';
import { base64Bytes, MAX_IMAGE_BYTES, type LoadArtifact } from './attachments.js';

/** The tool name. Namespaced like every other tool; the plugin family is `agent`. */
export const DELEGATE_TOOL = 'agent.delegate';

/** Turn budget for a nested run, whatever the target agent's file asks for. */
export const MAX_NESTED_TURNS = 8;

/** Depth at which delegation is refused: a delegate never delegates again. */
export const MAX_DELEGATION_DEPTH = 1;

/** What delegation needs from an agent in the catalog — `CatalogAgent` satisfies it. */
export interface DelegateAgent {
  id: string;
  /** How the owner names it: `@credo`. Returned so the caller can quote it. */
  handle: string;
  name: string;
  /**
   * Set when a tool family this agent was granted is not installed here. It
   * holds no tools and may not take a turn, so it may not be delegated to
   * either: a colleague that cannot do the work must refuse where the asking
   * agent can read why, not answer emptily.
   */
  heldBack?: { message: string };
  definition(now: Date, timezone?: string): AgentDefinition;
}

/**
 * The catalog slice delegation uses. `get` (not `resolve`) on purpose: an
 * unknown id must come back as "no such agent", never as the default one.
 */
export interface DelegateCatalog {
  get(id: string): DelegateAgent | undefined;
  list(): ReadonlyArray<{ id: string }>;
}

/** The loop entry point, injectable so tests do not need the real one. */
export type RunAgentFn = typeof defaultRunAgent;

export interface DelegateDeps {
  /**
   * Resolved lazily: the tool registry is built *before* the catalog is loaded
   * (the catalog resolves its agent files against the registry), so the tool
   * cannot hold the catalog at construction time. Throwing here is a refusal.
   */
  catalog: () => DelegateCatalog;
  /** The registry the nested run executes against — the same one, always. */
  registry: ToolRegistry;
  /**
   * Also lazy: the provider is resolved after the registry exists. It takes the
   * *target* agent, because provider choice is pinned per agent — a colleague
   * on another provider must be run on that provider, never on the caller's.
   */
  provider: (agent: DelegateAgent) => RuntimeProvider;
  /** Defaults to the caller's `ctx.db`; injected in tests. */
  pool?: Queryable;
  /** Defaults to the caller's own context (owner, clock, db). */
  ctxBase?: CoreToolContext;
  runAgent?: RunAgentFn;
  /** The caller's allowlist. Unknown caller or missing file: `[]`. */
  allowlistFor(agentId: string): string[];
  maxNestedTurns?: number;
  /** A one-off instruction passed to the nested run, when the host has one. */
  systemSuffix?: string;
  memoryPreamble?: (agentId: string) => Promise<string>;
  /**
   * Bytes for a file the colleague made, so an image can be shown to the
   * asking model. Defaults to the artifact store under the caller's `ctx.db`.
   */
  loadArtifact?: LoadArtifact;
  /**
   * The `session` tools a delegate may hold, decided from the asking run
   * (docs/browser.md, "Delegates"). The gateway answers `['browser.act']`
   * only when the asking conversation is an owner conversation (a live owner
   * request, depth 0) that has a browser session open; absent or empty, a
   * delegate holds none. Core still checks the owner request on every call.
   */
  delegableSession?: (ctx: CoreToolContext) => readonly string[];
}

/** What a delegate may hold of the asking run's session tools: only from a live owner request at depth 0. */
function delegableFrom(ctx: CoreToolContext, deps: Pick<DelegateDeps, 'delegableSession'>): readonly string[] {
  if ((ctx.delegationDepth ?? 0) !== 0 || !ctx.ownerRequest || ctx.ownerRequest.expiresAt <= Date.now()) return [];
  try { return [...(deps.delegableSession?.(ctx) ?? [])]; } catch { return []; }
}

export const delegateInput = z.object({
  agent: z.string().min(1).describe('Catalog id of the colleague to ask, e.g. credit-coach'),
  task: z
    .string()
    .min(1)
    .describe('The concrete question to answer, written as you would ask a colleague'),
  context: z
    .string()
    .optional()
    .describe('Facts the colleague needs and cannot look up itself'),
});

export type DelegateInput = z.infer<typeof delegateInput>;

/** Written in the caller's conversation while its colleague waits on the owner. */
export const DELEGATION_WAITING = 'delegation.waiting';

/**
 * How the colleague's run ended, in one word, so the caller never has to read
 * it off an empty string.
 *
 * - `answered`: it wrote an answer and stopped on its own.
 * - `stopped`: it wrote something but ran out of budget first.
 * - `no-answer`: it ended without writing anything; what it made, or what
 *   failed, is still listed.
 * - `awaiting-approval`: it is paused on an approval the owner has been asked
 *   for. The caller's run pauses with it and resumes when the owner decides.
 * - `failed`: the approval it waited on was rejected or expired, or its run
 *   could not go on.
 */
export type DelegationStatus = 'answered' | 'stopped' | 'no-answer' | 'awaiting-approval' | 'failed';

export interface DelegatedArtifact {
  id: string;
  filename: string | null;
  mime: string;
  kind: string;
}

export interface DelegateOutput {
  agent: string;
  /** The target's handle, without the `@`: what the answer is attributed to. */
  handle: string;
  name: string;
  conversationId: string;
  /** The nested run's own id, so a reader can follow it while it is alive. */
  runId: string;
  text: string;
  status: DelegationStatus;
  /** What the caller should do with this, when `text` alone would mislead. */
  note?: string;
  /**
   * One sentence naming the files the colleague made, which the loop records
   * as part of the asking turn: the owner sees them under the caller's reply,
   * so the caller must not send them to the colleague to fetch.
   */
  attached?: string;
  /** Files the colleague saved in its conversation, by library id. */
  artifacts?: DelegatedArtifact[];
  /** The colleague's failed tool calls, newest last. */
  errors?: Array<{ tool: string; error: string }>;
  /**
   * The approval the colleague is paused on. Deliberately not `actionId`: a
   * reader that finds an `actionId` in a result draws it as this call's own
   * gate, and this call is not gated — its colleague is.
   */
  waitingOn?: { action: string; tool: string | null };
}

/** Insert one row into the event log. Same SQL shape as the loop's. */
async function appendEvent(
  pool: Queryable,
  kind: string,
  payload: unknown,
  conversationId?: string,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)`,
    [kind, conversationId ?? null, JSON.stringify(payload ?? null)],
  );
}

/** The nested run's user message: the task, and the caller's context under it. */
export function delegationMessage(input: DelegateInput, from: string): string {
  const context = (input.context ?? '').trim();
  const header = `You are being asked a question by ${from}, another of the owner's agents. Answer it directly, with the numbers you can look up yourself. Your answer is read by ${from}, not by the owner.`;
  const body = context === '' ? input.task : `${input.task}\n\nContext from ${from}:\n${context}`;
  return `${header}\n\n${body}`;
}

/** What `delegationOutput` needs to know about the colleague's run. */
export interface DelegationRun {
  target: Pick<DelegateAgent, 'id' | 'handle' | 'name'>;
  conversationId: string;
  runId: string;
  result: Pick<RunResult, 'text' | 'stopped' | 'pendingActionId'>;
}

/**
 * What a delegation hands back, from the colleague's run and its thread.
 *
 * Never a bare empty string: a run that ended on a tool result, or paused on
 * an approval, wrote no final words, and `""` with nothing beside it is what
 * made a caller tell the owner its colleague "returned an empty result". So
 * the colleague's last words in its thread stand in for missing ones, the
 * files it saved come back as library ids, its failed calls come back with
 * their reasons, and `status` and `note` say which of those the caller has.
 *
 * Shared by the tool and by the host that continues a delegation after an
 * approval, so both return one shape.
 */
export async function delegationOutput(pool: Queryable, run: DelegationRun): Promise<DelegateOutput> {
  const { target, conversationId, runId, result } = run;
  const who = `@${target.handle}`;
  const thread = await readThread(pool, conversationId);
  const text = result.text.trim() !== '' ? result.text : thread.lastSaid;
  // Whatever the colleague produced travels back with its words: a poster
  // is the answer, not a sentence about a poster. Ids only; the caller
  // attaches or describes them with the artifact tools it holds.
  let artifacts: DelegatedArtifact[] = [];
  try {
    artifacts = (await listArtifacts(pool as never, { conversationId, limit: 20 })).map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, kind: a.kind }));
  } catch {
    /* The reply stands on its own; a listing that fails costs the attachments, not the answer. */
  }
  const base = {
    agent: target.id,
    handle: target.handle,
    name: target.name,
    conversationId,
    runId,
    text,
    ...(artifacts.length > 0 ? { attached: attachedLine(artifacts, who), artifacts } : {}),
    ...(thread.errors.length > 0 ? { errors: thread.errors } : {}),
  };
  if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
    const tool = thread.gates.get(result.pendingActionId) ?? null;
    return {
      ...base,
      status: 'awaiting-approval',
      waitingOn: { action: result.pendingActionId, tool },
      note:
        `${who} needs the owner's approval${tool ? ` for ${tool}` : ''} before it can go on, and the owner has been asked in this conversation. ` +
        'Say so in one line and end your turn. Its answer comes back to you when the owner decides; do not ask again or retry.',
    };
  }
  if (text.trim() !== '') {
    return { ...base, status: result.stopped === 'end_turn' ? 'answered' : 'stopped' };
  }
  const note = artifacts.length > 0
    ? `${who} ended without writing an answer; what it made is attached to this turn.`
    : thread.errors.length > 0
      ? `${who} ended without an answer; what failed is under errors. Tell the owner what failed; do not retry blindly.`
      : `${who} ended without an answer or a file (stopped: ${result.stopped}). Say so plainly; do not invent one.`;
  return { ...base, status: 'no-answer', note };
}

/**
 * What the asking model is told about the colleague's files. They are part of
 * its own turn by the time it reads this (the loop records them with the
 * result), so the owner already has them: a caller that says "that image
 * lives in @art's output" is describing a file the owner can see.
 */
export function attachedLine(artifacts: readonly DelegatedArtifact[], who: string): string {
  const names = artifacts.map((a) => `${a.filename ?? 'an untitled file'} (${a.kind})`).join(', ');
  return `What ${who} made is attached to this turn: ${names}. ` +
    `The owner sees it under your reply; do not tell them to ask ${who} for it.`;
}

/** Images a model can be shown, the same list the preview route serves. */
const PICTURE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Who the caller asked for, as the caller may have written it: a catalog id,
 * or an allowed colleague's handle, with or without its `@`. A handle is
 * resolved only to an agent already on the list, so it never widens it.
 */
function resolveAllowed(wanted: string, allowed: readonly string[], catalog: DelegateCatalog | null): string | null {
  const name = wanted.trim().replace(/^@/, '');
  if (allowed.includes(name)) return name;
  if (!catalog) return null;
  const lower = name.toLowerCase();
  return allowed.find((id) => catalog.get(id)?.handle.toLowerCase() === lower) ?? null;
}

/**
 * The refusal for a colleague not on the caller's list, in the words the
 * owner can act on: who is on it, who is not, and where the list changes.
 */
export function notOnListRefusal(from: string, wanted: string, allowed: readonly string[], catalog: DelegateCatalog | null): string {
  const handle = (id: string): string => {
    const bare = id.trim().replace(/^@/, '');
    const agent = catalog?.get(bare) ?? null;
    return `@${agent?.handle ?? bare}`;
  };
  const self = handle(from);
  const who = allowed.length === 0
    ? `${self} may not delegate to anyone`
    : `${self} may delegate to ${allowed.map(handle).join(', ')}`;
  return `delegation refused: ${who}; ${handle(wanted)} is not on its list. The owner adds it on ${self}'s Team tab.`;
}

/** The gate text the loop answers a gated call with. See `awaitingApprovalText`. */
const GATE = /^awaiting owner approval \(action ([0-9a-f-]{36})\)/;

/** The colleague's thread, read once: its last words, its failures, its gates. */
async function readThread(pool: Queryable, conversationId: string): Promise<{
  lastSaid: string;
  errors: Array<{ tool: string; error: string }>;
  gates: Map<string, string>;
}> {
  const gates = new Map<string, string>();
  let rows: Array<{ role: string; content: unknown }>;
  try {
    ({ rows } = await pool.query(
      `select role, content from core.messages where conversation_id = $1 order by created_at asc, id asc`,
      [conversationId],
    ));
  } catch {
    return { lastSaid: '', errors: [], gates };
  }
  const names = new Map<string, string>();
  const errors: Array<{ tool: string; error: string }> = [];
  let lastSaid = '';
  for (const row of rows ?? []) {
    const blocks = Array.isArray(row.content) ? (row.content as Array<Record<string, unknown>>) : [];
    if (row.role === 'assistant') {
      const said = blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? '').trim())
        .filter((t) => t !== '')
        .join('\n\n');
      if (said !== '') lastSaid = said;
      for (const b of blocks) if (b.type === 'tool_use') names.set(String(b.id), String(b.name));
      continue;
    }
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const tool = names.get(String(b.tool_use_id)) ?? 'tool';
      const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null);
      const gate = GATE.exec(content);
      if (gate) gates.set(gate[1] as string, tool);
      if (b.is_error === true) errors.push({ tool, error: content.length > 400 ? `${content.slice(0, 399)}…` : content });
    }
  }
  return { lastSaid, errors: errors.slice(-3), gates };
}

export function createDelegateTool(deps: DelegateDeps): ToolDefinition<DelegateInput, DelegateOutput> {
  const maxTurns = deps.maxNestedTurns ?? MAX_NESTED_TURNS;
  const run = deps.runAgent ?? defaultRunAgent;

  return {
    name: DELEGATE_TOOL,
    description:
      'Ask another of the owner\'s agents a question and get its answer back as text. ' +
      'The colleague answers in its own fresh conversation with its own tools; it cannot see this one. ' +
      'Any files or images it makes are attached to your turn: the owner sees them under your reply, ' +
      'and you see an image yourself when your model takes images. ' +
      'Use it when a question belongs to a specialist you are allowed to ask. ' +
      'The front desk and the maker may ask any agent, new ones included; every other agent asks only the colleagues on its own list. ' +
      '`agent` is a catalog **id**, never a handle and never a guess: the ids you may pass are ' +
      'listed under "Colleagues you may ask" in your wiring section. ' +
      'Quote the answer back to the owner and attribute it by the handle the result ' +
      'carries, written with an @ — "@credo says: ...".',
    tier: 'auto',
    // The colleague's files are recorded as part of the asking turn, credited
    // to the colleague (the loop reads `agent` off this tool's output).
    producesArtifacts: true,
    input: delegateInput,
    /*
     * The first picture the colleague made, shown to the asking model the way
     * a screenshot is: once, with the result, never stored as base64. The
     * loop decides whether this model takes images.
     */
    async image(output, ctx) {
      const picture = (output?.artifacts ?? []).find((a) => a.kind === 'image' && PICTURE_MIMES.has(a.mime.toLowerCase()));
      if (!picture) return undefined;
      const load: LoadArtifact = deps.loadArtifact ?? (async (id) => {
        const pool = (deps.pool ?? (ctx as unknown as CoreToolContext).db) as never;
        const row = await getArtifact(pool, id);
        if (!row) return null;
        return { mime: row.mime, data: (await readArtifactBytes(process.env, row)).toString('base64') };
      });
      const loaded = await load(picture.id);
      if (!loaded || !PICTURE_MIMES.has(loaded.mime.toLowerCase()) || base64Bytes(loaded.data) > MAX_IMAGE_BYTES) return undefined;
      return { mime: loaded.mime, data: loaded.data };
    },
    async execute(input, ctx: CoreToolContext): Promise<DelegateOutput> {
      const from = ctx.agentId;
      if (!from) {
        throw new Error(
          'delegation refused: this run has no agent identity, so no allowlist applies',
        );
      }

      // A room has its own way to bring a colleague in, with a budget and a
      // shared transcript; delegation would step around both.
      if (ctx.group) {
        throw new Error(
          `delegation refused: this is a group run ("${ctx.group.name}"); ask a member through group.ask, or answer for the room`,
        );
      }

      const depth = ctx.delegationDepth ?? 0;
      if (depth >= MAX_DELEGATION_DEPTH) {
        throw new Error(
          `delegation refused: "${from}" is itself a delegated run (depth ${depth}); ` +
            'a delegate may not delegate again. Answer with what you have.',
        );
      }

      const allowed = deps.allowlistFor(from);
      // Read for handles only: an unbound catalog still refuses, below.
      let known: DelegateCatalog | null = null;
      try { known = deps.catalog(); } catch { /* the refusal names ids instead */ }
      const wanted = resolveAllowed(input.agent, allowed, known);
      if (wanted === null) {
        throw new Error(notOnListRefusal(from, input.agent, allowed, known));
      }

      const catalog = known ?? deps.catalog();
      const target = catalog.get(wanted);
      if (!target) {
        throw new Error(
          `delegation refused: unknown agent "${wanted}" ` +
            `(installed: ${catalog.list().map((a) => a.id).join(', ') || 'none'})`,
        );
      }

      if (target.heldBack) {
        throw new Error(
          `delegation refused: "${target.id}" cannot run here — ${target.heldBack.message}`,
        );
      }

      const pool = deps.pool ?? (ctx.db as unknown as Queryable);
      const base = deps.ctxBase ?? ctx;
      const now = base.now ?? ctx.now;

      const conversationId = await createConversation(pool, target.id);
      const runId = randomUUID();
      /*
       * Written the moment the colleague's conversation exists, and *before*
       * the nested run takes its first turn: a panel watching this call has to
       * be able to find the conversation while the work is still happening,
       * and the result — which is where the ids would otherwise live — does
       * not exist for another minute. The tool-use id ties it to the exact
       * call the caller's transcript already shows.
       */
      await appendEvent(
        pool,
        'delegation.started',
        {
          from,
          to: target.id,
          agentId: target.id,
          conversationId,
          runId,
          ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
        },
        ctx.conversationId ?? conversationId,
      );

      const definition = target.definition(now(), base.timezone ?? ctx.timezone);
      let result;
      try {
        result = await run({
          agent: { ...definition, maxTurns: Math.min(definition.maxTurns, maxTurns) },
          provider: deps.provider(target),
          registry: deps.registry,
          // The nested run is one level deeper, and it is the target's run: the
          // loop stamps `agentId`/`conversationId` itself.
          ctx: {
            ...base,
            delegationDepth: depth + 1,
            delegatedSession: delegableFrom(ctx, deps),
            // An unattended mission's grant never reaches a delegate.
            unattendedSession: [],
            unattendedChrome: false,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
          pool,
          conversationId,
          runId,
          userMessage: delegationMessage(input, from),
          // A delegate's budget is this platform's cap, not the agent's own,
          // and its answer is quoted back into the caller's. It does not tell
          // the owner to say "continue" to a conversation that ends here.
          budgetNotice: false,
          // The delegate answers onto the caller's screen: its words are quoted
          // back verbatim into the same Telegram bubble or the same dashboard
          // panel. So it inherits the caller's surface profile rather than
          // being composed with none — a delegate that wrote a markdown table
          // for Telegram would break the reply that carries it.
          ...(ctx.surface ? { surface: ctx.surface } : {}),
          systemSuffix: deps.systemSuffix,
          memoryPreamble: deps.memoryPreamble,
        });
      } catch (err) {
        await appendEvent(
          pool,
          'delegation.finished',
          {
            from,
            to: target.id,
            conversationId,
            runId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          ctx.conversationId ?? conversationId,
        );
        throw err;
      }

      const output = await delegationOutput(pool, { target, conversationId, runId, result });

      if (output.status === 'awaiting-approval' && result.pendingActionId) {
        /*
         * The colleague is paused on the owner, and so is this run: `suspend`
         * ends the caller's turn awaiting the very same action, exactly as a
         * gate of its own would, and nothing is held open while the owner
         * decides. This event is how the decision finds its way back: the
         * host continues the colleague's run with the outcome, and the
         * colleague's answer resumes the caller (docs/groups.md does the same
         * for a room).
         */
        await appendEvent(
          pool,
          DELEGATION_WAITING,
          {
            from,
            to: target.id,
            conversationId,
            runId,
            actionId: result.pendingActionId,
            // What the caller's own run stopped on. It stays the same however
            // many approvals the colleague asks for on the way.
            parentActionId: result.pendingActionId,
            ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
          },
          ctx.conversationId ?? conversationId,
        );
        ctx.suspend?.(result.pendingActionId);
        return output;
      }

      await appendEvent(
        pool,
        'delegation.finished',
        {
          from,
          to: target.id,
          conversationId,
          runId,
          ok: true,
          turns: result.turns,
          stopped: result.stopped,
          status: output.status,
          ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
        },
        ctx.conversationId ?? conversationId,
      );
      return output;
    },
  };
}
