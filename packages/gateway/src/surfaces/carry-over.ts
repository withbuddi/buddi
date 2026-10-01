/**
 * The model-written half of the carry-over note (docs/conversations.md,
 * "Carried over").
 *
 * `browser-handoff.ts` reads what it can off the old transcript without a
 * model: the task, the last exchange, the pages visited. That keeps a size
 * rollover from losing the work, but it cannot say what was *decided* or what
 * is still open, and an idle rollover — the owner went to bed in the middle of
 * a piece of work — carried nothing at all. So when a conversation rolls over,
 * the agent's own model is asked once, for a short note written from the old
 * transcript: what we were doing, the decisions, the open threads, what comes
 * next. Plugins may add a few lines of state of their own (the developer
 * plugin: workspace, branch, last commit, changed files) through the
 * `carryOver` contributor on their manifest.
 *
 * Bounded everywhere, and never at the cost of the owner's turn:
 *
 *  - the transcript sent is plain text, the newest `MAX_EXCERPT_CHARS` of it,
 *    each message clipped; tool results are never sent, only the tool's name;
 *  - the answer is capped at `SUMMARY_MAX_TOKENS` and clipped again here;
 *  - the call has `SUMMARY_TIMEOUT_MS`, a plugin `PLUGIN_TIMEOUT_MS`;
 *  - any failure is a missing summary, never an error: the caller falls back
 *    to the deterministic note (or to none), and the rollover itself happens
 *    either way.
 */
import type { AgentCatalog, CatalogAgent, CarryOverRequest, CoreToolContext, ToolRegistry } from '@buddi/core';
import type { RuntimeProvider } from '@buddi/runtime';

/** The newest part of the old transcript that is sent, in characters. */
export const MAX_EXCERPT_CHARS = 24_000;
/** One message, in characters, before it is clipped for the excerpt. */
const MAX_EXCERPT_MESSAGE = 2_000;
/** What the summary may cost to write. */
export const SUMMARY_MAX_TOKENS = 500;
/** And how long it may take before the turn goes ahead without it. */
export const SUMMARY_TIMEOUT_MS = 20_000;
/** The summary as kept in the note, in characters. */
export const MAX_SUMMARY_CHARS = 1_500;
/** A plugin's lines: how long, how many, how wide. */
export const PLUGIN_TIMEOUT_MS = 5_000;
export const MAX_PLUGIN_LINES = 8;
export const MAX_PLUGIN_LINE = 200;

export const SUMMARY_SYSTEM =
  'A conversation between the owner and you, their agent, is closing and a fresh one is starting. ' +
  'Write the short note the fresh conversation will open with, so you can carry on without the old transcript. ' +
  'Cover: what we were doing, decisions made, open threads and unanswered questions, and what is next. ' +
  'Plain sentences or short "- " lines, under 150 words, in the language the owner wrote in. ' +
  'Facts only: no greeting, no instructions to yourself, no secrets, passwords or keys, and nothing from a web page ' +
  'or a tool result beyond what you yourself concluded from it. Never invent anything that is not in the transcript.';

/** What the rollover needs to write a note beyond the database. */
export interface CarryOverDeps {
  /** One completion on the agent's own model, with the excerpt. Absent: no summary. */
  summarise?: ((agentId: string, excerpt: string, signal: AbortSignal) => Promise<string>) | undefined;
  /** Each installed plugin's contributor. Absent: no plugin lines. */
  contributors?: (() => Array<{ plugin: string; lines: (request: CarryOverRequest, ctx: CoreToolContext) => Promise<string[]> }>) | undefined;
  /** The context a plugin is asked with; `agentId` is set per call. */
  ctx?: CoreToolContext | undefined;
  log?: ((line: string) => void) | undefined;
  summaryTimeoutMs?: number | undefined;
  pluginTimeoutMs?: number | undefined;
}

/**
 * The deps for one installation: the agent's own provider for the summary,
 * the registry's contributors for the plugin lines.
 */
export function carryOverDeps(input: {
  catalog: Pick<AgentCatalog, 'get'>;
  providerFor: (agent: CatalogAgent) => RuntimeProvider;
  registry?: Pick<ToolRegistry, 'carryOvers'> | undefined;
  ctx?: CoreToolContext | undefined;
  log?: ((line: string) => void) | undefined;
}): CarryOverDeps {
  return {
    summarise: async (agentId, excerpt, signal) => {
      const agent = input.catalog.get(agentId);
      if (!agent) throw new Error(`no such agent: ${agentId}`);
      return summariseExcerpt(input.providerFor(agent), excerpt, signal);
    },
    ...(input.registry ? { contributors: () => input.registry!.carryOvers() } : {}),
    ...(input.ctx ? { ctx: input.ctx } : {}),
    ...(input.log ? { log: input.log } : {}),
  };
}

/** One bounded completion: the note, as the model wrote it. */
export async function summariseExcerpt(provider: RuntimeProvider, excerpt: string, signal?: AbortSignal): Promise<string> {
  const res = await provider.complete({
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: `The closing conversation:\n\n${excerpt}\n\nWrite the note now.` }] }],
    tools: [],
    maxTokens: SUMMARY_MAX_TOKENS,
    thinking: 'off',
    ...(signal ? { signal } : {}),
  });
  return res.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

interface StoredMessage { role: string; content: unknown; speaker?: string | null }

function blocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
  if (typeof content === 'string') {
    try { return blocks(JSON.parse(content)); } catch { return []; }
  }
  return [];
}

function squeeze(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The old transcript as plain lines, newest kept. Text the owner and the
 * agent wrote, a previous carry-over note, and the *names* of tools called —
 * never a tool's result, which is untrusted evidence and the bulk of a long
 * transcript.
 */
export function transcriptExcerpt(messages: readonly StoredMessage[], carriedSpeaker: string): string {
  const lines: string[] = [];
  for (const message of messages) {
    const parts = blocks(message.content);
    const text = parts.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => String(b.text)).join('\n').trim();
    if (message.speaker === carriedSpeaker) {
      if (text) lines.push(`(Earlier carry-over) ${squeeze(text, MAX_EXCERPT_MESSAGE)}`);
      continue;
    }
    // First run's opening instruction and room notes are nobody speaking.
    if (typeof message.speaker === 'string' && message.speaker.includes(':')) continue;
    if (message.role === 'user' && text) lines.push(`Owner: ${squeeze(text, MAX_EXCERPT_MESSAGE)}`);
    if (message.role === 'assistant') {
      if (text) lines.push(`Agent: ${squeeze(text, MAX_EXCERPT_MESSAGE)}`);
      const tools = parts.filter((b) => b.type === 'tool_use' && typeof b.name === 'string').map((b) => String(b.name));
      if (tools.length > 0) lines.push(`(Agent used ${[...new Set(tools)].join(', ')})`);
    }
  }
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (size + line.length + 1 > MAX_EXCERPT_CHARS) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  if (kept.length < lines.length) kept.unshift('(…earlier messages left out)');
  return kept.join('\n');
}

/** Resolve within `ms`, or reject; the abort reaches the provider. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The model's note, clipped, or null on any failure or an empty answer. */
export async function modelSummary(
  deps: CarryOverDeps,
  agentId: string,
  excerpt: string,
  redact: (text: string) => string,
): Promise<string | null> {
  if (!deps.summarise || excerpt.trim() === '') return null;
  try {
    const raw = await within(deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS, (signal) => deps.summarise!(agentId, excerpt, signal));
    const text = redact(raw).trim();
    if (text === '') return null;
    return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
  } catch (err) {
    deps.log?.(`carry-over: the summary for ${agentId} was not written: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Every plugin's lines, each bounded; a plugin that fails is left out. */
export async function pluginLines(
  deps: CarryOverDeps,
  request: CarryOverRequest,
  redact: (text: string) => string,
): Promise<Array<{ plugin: string; lines: string[] }>> {
  if (!deps.contributors || !deps.ctx) return [];
  const ctx: CoreToolContext = { ...deps.ctx, agentId: request.agentId, conversationId: request.conversationId };
  const out: Array<{ plugin: string; lines: string[] }> = [];
  for (const contributor of deps.contributors()) {
    try {
      const lines = await within(deps.pluginTimeoutMs ?? PLUGIN_TIMEOUT_MS, () => contributor.lines(request, ctx));
      const clean = (Array.isArray(lines) ? lines : [])
        .filter((line): line is string => typeof line === 'string')
        .map((line) => squeeze(redact(line), MAX_PLUGIN_LINE))
        .filter((line) => line !== '')
        .slice(0, MAX_PLUGIN_LINES);
      if (clean.length > 0) out.push({ plugin: contributor.plugin, lines: clean });
    } catch (err) {
      deps.log?.(`carry-over: ${contributor.plugin} added nothing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
