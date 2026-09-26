#!/usr/bin/env node
/**
 * `buddi chat` / `buddi ask` — the terminal surface.
 *
 * This file is the *process*: argument parsing, the composition root, readline,
 * history, tab completion, the pager and the signal handlers. Everything the
 * owner actually reads is produced by `ChatSession` (`chat/session.ts`), which
 * knows nothing about terminals — that split is what lets the whole surface be
 * tested with a fake provider and an in-memory database.
 *
 * Two entry points, deliberately different:
 *
 *  - `chat` is for a person. It has a spinner, colour, markdown, a footer and a
 *    prompt that names the agent.
 *  - `ask` is for a script. One turn, plain stdout, no spinner, no ANSI, and an
 *    exit code that means something: 2 when the run stopped awaiting approval.
 *
 * The CLI is its own process. Nothing here runs inside `buddi serve`, so a
 * change to this file needs no service restart.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getAction,
  resolveDataDir,
  CLI_SURFACE,
  TERMINAL_STATES,
  UnknownAgentError,
  type ActionRecord,
  type CatalogAgent,
} from '@buddi/core';
import type { ApprovalResume, AttachmentRef } from '@buddi/runtime';
import { failedTurnReply } from './surfaces/failure.js';
import { createConversation, createProvider, runAgent } from '@buddi/runtime';
import { nativeSearchRecorder } from '@buddi/tool-web';
import type { Pool } from 'pg';
import { AGENTS_DIR, memoryPreambleFor } from './agents/catalog.js';
import { main as runAgentsCli } from './agents-cli.js';
import { bindDelegation } from './agents/delegation.js';
import { bindOwnerTools } from './agents/owner-tools.js';
import { shouldStartFirstRun } from './agents/first-run.js';
import { createWiringAsync, loadEnvironment, type Wiring } from './bootstrap.js';
import { CliApprovals } from './chat/approvals.js';
import { COMMAND_NAMES } from './chat/commands.js';
import { ChatSession, QUIET_UNAVAILABLE_TEXT } from './chat/session.js';
import { Spinner, silentSpinner } from './chat/spinner.js';
import { bold, dim, styleFor, type TerminalStyle } from './chat/terminal.js';
import { describeDatabaseError } from './db-ready.js';
import { attachFile } from './chat/attach.js';
import { createInlineMissionRunner } from './missions/inline.js';
import { createEngagementHooks } from './missions/engagement.js';
import { recapMissionId } from './missions/recap.js';
import { createCoreArtifactStore } from './telegram/attachments.js';
import { stripToolNames } from './telegram/surface.js';

const USAGE = `buddi — your personal agents

  buddi chat                 start a new conversation with the default agent
  buddi chat --agent <handle>  ... with a specific agent, by @handle or id
  buddi chat --resume <id>   continue a conversation
  buddi chat --last          continue the most recent conversation
  buddi chat --quiet         no run footer
  buddi ask "<question>"     one turn, then exit
  buddi ask "<question>" --agent <handle>
  buddi ask "<question>" --resume <id>
  buddi ask "<question>" --file <path> --wait <seconds> --json
  buddi agents               every agent, its engine and whether it can run
  buddi agents show <handle> | set <handle> [--provider p] [--model m]
  buddi agents models | test <handle>

In chat: /help lists every command. Exit codes for ask: 0 answered, 1 failed,
2 usage, 3 stopped awaiting your approval (or no database, or no such agent).`;

export type ParsedArgs = {
  command: 'chat' | 'ask' | 'agents' | 'help';
  question?: string;
  resume?: string;
  /** Agent handle or id from --agent; undefined means the catalog default. */
  agent?: string;
  last: boolean;
  /** `--quiet`: suppress the per-run footer. Absent means "show it". */
  quiet?: boolean;
  /** `ask --json`: one object on stdout instead of the answer's text. */
  json?: boolean;
  /** `ask --file <path>`, repeatable: stored in the library, sent with the question. */
  files?: string[];
  /** `ask --wait <seconds>`: how long to wait for an approval given elsewhere. */
  waitSeconds?: number;
};

/** An approval the run stopped on, polled every this often under `--wait`. */
export const WAIT_POLL_MS = 2_000;

/** What `ask` says when it stops for an approval. */
export function approvalStopText(actionId: string, conversationId: string): string {
  return (
    `This run is waiting for your approval (action ${actionId}).\n` +
    `Approve it on the dashboard or Telegram, then run buddi ask again with --resume ${conversationId}`
  );
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [raw, ...rest] = argv;
  const command =
    raw === 'chat' ? 'chat' : raw === 'ask' ? 'ask' : raw === 'agents' ? 'agents' : 'help';
  const parsed: ParsedArgs = { command, last: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--agent') {
      const value = rest[++i];
      if (!value) throw new Error('--agent needs an agent handle or id');
      parsed.agent = value;
    } else if (arg === '--resume') {
      const value = rest[++i];
      if (!value) throw new Error('--resume needs a conversation id');
      parsed.resume = value;
    } else if (arg === '--') {
      // `pnpm chat -- --last` passes the separator through; ignore it.
      continue;
    } else if (arg === '--last') {
      parsed.last = true;
    } else if (arg === '--quiet' || arg === '-q') {
      parsed.quiet = true;
    } else if (arg === '--json' && command === 'ask') {
      parsed.json = true;
    } else if (arg === '--file' && command === 'ask') {
      const value = rest[++i];
      if (!value) throw new Error('--file needs a path');
      parsed.files = [...(parsed.files ?? []), value];
    } else if (arg === '--wait' && command === 'ask') {
      const value = Number(rest[++i]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--wait needs a number of seconds');
      parsed.waitSeconds = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (parsed.question === undefined) {
      parsed.question = arg;
    } else {
      parsed.question = `${parsed.question} ${arg}`;
    }
  }
  return parsed;
}

async function lastConversation(pool: Pool, agentId: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select id from core.conversations
      where agent_id = $1
      order by created_at desc, id desc
      limit 1`,
    [agentId],
  );
  return rows[0]?.id ? String(rows[0].id) : undefined;
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

/** Where the prompt remembers what was typed. Beside every other artifact. */
export function historyFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), 'cli-history');
}

/** Lines kept between sessions. Enough to find last week's question. */
export const HISTORY_LIMIT = 1000;

/**
 * Node's readline holds history newest-first; the file is written oldest-first,
 * because that is what `tail` and every other shell history looks like.
 */
export function loadHistory(file: string): string[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '')
      .slice(-HISTORY_LIMIT)
      .reverse();
  } catch {
    return [];
  }
}

export function saveHistory(file: string, history: readonly string[]): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const oldestFirst = [...history].reverse().slice(-HISTORY_LIMIT);
    writeFileSync(file, `${oldestFirst.join('\n')}\n`, { mode: 0o600 });
  } catch {
    // History is a convenience. A read-only data dir must not cost a session.
  }
}

/* ------------------------------------------------------------------ *
 * Tab completion
 * ------------------------------------------------------------------ */

/**
 * Slash commands, agent handles and — after `/attach` — paths.
 *
 * Pure apart from the directory listing it is handed, so the rule is testable:
 * `completerFor` takes a `readdir` and returns readline's completer.
 */
export function completerFor(opts: {
  handles: readonly string[];
  listDir(dir: string): string[];
  home: string;
  cwd: string;
}): (line: string) => [string[], string] {
  return (line: string): [string[], string] => {
    const attach = /^\/attach\s+(\S*)$/.exec(line);
    if (attach) {
      const typed = attach[1] as string;
      const expanded = typed.startsWith('~/') ? path.join(opts.home, typed.slice(2)) : typed;
      const dir = expanded.endsWith('/') ? expanded : path.dirname(expanded);
      const prefix = expanded.endsWith('/') ? '' : path.basename(expanded);
      const base = path.isAbsolute(dir) ? dir : path.resolve(opts.cwd, dir);
      const entries = opts.listDir(base)
        .filter((name) => name.startsWith(prefix))
        .map((name) => {
          const joined = expanded.endsWith('/')
            ? `${typed}${name}`
            : `${typed.slice(0, typed.length - prefix.length)}${name}`;
          return `/attach ${joined}`;
        });
      return [entries, line];
    }

    if (/^\/\S*$/.test(line)) {
      const hits = COMMAND_NAMES.filter((name) => name.startsWith(line));
      return [hits.length > 0 ? hits : [...COMMAND_NAMES], line];
    }

    const use = /^\/use\s+(@?\S*)$/.exec(line);
    if (use) {
      const typed = (use[1] as string).replace(/^@/, '');
      const hits = opts.handles.filter((h) => h.startsWith(typed)).map((h) => `/use ${h}`);
      return [hits, line];
    }

    if (/^@\S*$/.test(line)) {
      const typed = line.slice(1);
      const hits = opts.handles.filter((h) => h.startsWith(typed)).map((h) => `@${h} `);
      return [hits, line];
    }

    return [[], line];
  };
}

/* ------------------------------------------------------------------ *
 * The pager
 * ------------------------------------------------------------------ */

/**
 * Long answers go through `less -R`, and only when there is a person and a
 * window to page in. A pipe, a short answer or a missing pager all fall back to
 * writing the text, which is what a script wants anyway.
 */
export function shouldPage(text: string, style: TerminalStyle, rows: number): boolean {
  if (!style.tty) return false;
  if (rows <= 0) return false;
  return text.split('\n').length > rows - 2;
}

async function page(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('less', ['-R', '-F', '-X'], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.on('error', () => resolve(false));
      child.on('close', () => resolve(true));
      child.stdin.on('error', () => {});
      child.stdin.end(`${text}\n`);
    } catch {
      resolve(false);
    }
  });
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

/**
 * The chat surface's entry point. `argv` is the command and its options —
 * `buddi` (@buddi/cli) passes the slice it owns, so the single global binary
 * calls this function instead of re-implementing it.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // `agents` is a command group of its own (list, show, set, models, test) and
  // owns everything after its own word — including flags this parser would
  // reject. It needs no database and no pool, so it is dispatched before any
  // wiring exists.
  if (argv[0] === 'agents') {
    const code = await runAgentsCli(argv.slice(1));
    if (code !== 0) process.exitCode = code;
    return;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return;
  }

  await loadEnvironment();

  const style = styleFor(process.env, process.stdout);

  // A script pipes its question in: `echo "…" | buddi ask`.
  if (args.command === 'ask' && !args.question && process.stdin.isTTY !== true) {
    const piped = (await readStdin()).trim();
    if (piped !== '') args.question = piped;
  }
  // With no question, `--resume` finishes a run that stopped for an approval.
  if (args.command === 'ask' && !args.question && !args.resume) {
    console.error('buddi ask needs a question: buddi ask "can I afford a bike?"');
    process.exit(2);
  }

  /*
   * The composition root, vault included. `createWiringAsync` hydrates the
   * secrets from the keychain before anything reads them — without it, a
   * `.env` holding `ANTHROPIC_API_KEY=<vault>` after `buddi vault import-env`
   * would be sent to the API as if the marker were the key.
   */
  let wiring: Wiring;
  try {
    wiring = await createWiringAsync(process.env);
  } catch (err) {
    // A person is waiting at a prompt: fail fast, with the sentence that says
    // what to do about it. No database is something to fix first: 3.
    console.error(describeDatabaseError(err, process.env.DATABASE_URL));
    process.exit(3);
  }
  const { pool, registry, catalog, now, timezone, ctx } = wiring;

  // Fails closed: an unknown --agent is never coerced into the default. A
  // handle (`--agent ledger`, `--agent @ledger`) names the same agent as its id.
  let selected: CatalogAgent;
  try {
    selected = catalog.resolve(args.agent);
  } catch (err) {
    if (err instanceof UnknownAgentError) {
      console.error(err.message);
      console.error(`agents live in ${AGENTS_DIR}; run "buddi agents" to list them`);
      process.exit(3);
    }
    throw err;
  }
  const agent = selected.definition(now(), timezone);

  // The *selected* agent's provider, not the process's: an agent pinned to
  // another provider is run on that provider or not at all.
  if (!selected.available) {
    console.error(`@${selected.handle} cannot run: ${String(selected.unavailableReason).replace(/\.$/, '')}. Configure its account in dashboard Providers.`);
    process.exit(3);
  }
  // The cause chain of every failed attempt, on stderr. At a terminal that is
  // where an operator looks, and it is the only record `buddi chat` keeps.
  const provider = wiring.providerFor(selected);
  /** Delegation needs both halves; rebound here for the *selected* agent. */
  bindDelegation(registry, {
    catalog,
    provider,
    providerFor: ({ id }) => {
      const target = catalog.get(id);
      return target ? wiring.providerFor(target) : provider;
    },
  });

  bindOwnerTools(registry, { catalog, surface: CLI_SURFACE.id });

  /** Every run starts with what this agent remembers about the owner. */
  const memoryPreamble = memoryPreambleFor(pool);

  try {
    let conversationId = args.resume;
    if (!conversationId && args.last) {
      conversationId = await lastConversation(pool, agent.id);
      if (!conversationId) console.error('no previous conversation; starting a new one');
    }

    if (args.command === 'ask') {
      if (!conversationId) conversationId = await createConversation(pool, agent.id);
      await ask(args.question, conversationId, {
        agent: selected,
        wiring,
        provider,
        memoryPreamble,
        json: args.json === true,
        files: args.files ?? [],
        waitSeconds: args.waitSeconds,
      });
      return;
    }

    if (!conversationId) conversationId = await createConversation(pool, agent.id);
    await chat(args, selected, conversationId, wiring, style, memoryPreamble);
  } finally {
    await pool.end();
  }
}

/* ------------------------------------------------------------------ *
 * ask — one turn, for a script
 * ------------------------------------------------------------------ */

/** All of stdin, for a question piped in. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** How a decided action wakes the run that stopped on it. */
export function approvalResumeFrom(action: ActionRecord): ApprovalResume {
  const outcome = (action.outcome ?? {}) as { result?: unknown; error?: unknown };
  return {
    actionId: action.id,
    tool: action.tool,
    state: action.state,
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
  };
}

/**
 * The action a conversation's last run stopped on, once it is decided and not
 * yet taken up again. Only actions that belong to no queue job: those the
 * queue wakes on its own.
 */
async function decidedButNotResumed(
  pool: Wiring['pool'],
  conversationId: string,
): Promise<{ action: ActionRecord; decided: boolean } | undefined> {
  const { rows } = await pool.query(
    `select a.id from core.actions a
      where a.conversation_id = $1 and a.job_id is null
        and not exists (
          select 1 from core.events e
           where e.kind = 'run.resumed' and e.conversation_id = a.conversation_id
             and e.payload->>'actionId' = a.id::text)
      order by a.created_at desc
      limit 1`,
    [conversationId],
  );
  const id = rows[0]?.id as string | undefined;
  if (!id) return undefined;
  const action = await getAction(pool, id);
  if (!action) return undefined;
  return { action, decided: TERMINAL_STATES.includes(action.state) };
}

/** Poll an action until it is decided, or the time is up. */
async function waitForDecision(
  pool: Wiring['pool'],
  actionId: string,
  seconds: number,
): Promise<ActionRecord | undefined> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const action = await getAction(pool, actionId);
    if (action && TERMINAL_STATES.includes(action.state)) return action;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()))));
  }
}

/**
 * `ask` — one turn, for a script.
 *
 * The answer on stdout (or one JSON object with `--json`), everything else on
 * stderr, no spinner and no ANSI. Exit 0 answered, 1 failed, 3 stopped for an
 * approval: with `--wait` the run waits for a decision made elsewhere and
 * finishes; without it, the sentence says how to finish it later.
 */
async function ask(
  question: string | undefined,
  conversationId: string,
  deps: {
    agent: CatalogAgent;
    wiring: Wiring;
    provider: ReturnType<typeof createProvider>;
    memoryPreamble: (agentId: string) => Promise<string>;
    json: boolean;
    files: readonly string[];
    waitSeconds: number | undefined;
  },
): Promise<void> {
  const { wiring } = deps;
  const runId = randomUUID();
  const startedAt = new Date();
  if (!deps.json) console.error(`conversation: ${conversationId}`);

  const store = createCoreArtifactStore({ pool: wiring.pool, env: process.env });
  const attachments: AttachmentRef[] = [];
  for (const file of deps.files) {
    try {
      const saved = await attachFile(path.resolve(file), {
        store,
        readFile: (candidate) => readFile(candidate),
        createdBy: wiring.ctx.ownerId,
      });
      attachments.push({
        artifactId: saved.artifactId,
        mime: saved.mime,
        kind: saved.kind,
        filename: saved.filename,
        sizeBytes: saved.sizeBytes,
      });
    } catch (err) {
      console.error(`Could not attach ${file}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  // No question: finish the run this conversation stopped on, if it can be.
  let resume: ApprovalResume | undefined;
  if (question === undefined) {
    const found = await decidedButNotResumed(wiring.pool, conversationId);
    if (!found) {
      console.error('Nothing in that conversation is waiting to be finished. Ask a question: buddi ask "…" --resume <id>.');
      process.exitCode = 2;
      return;
    }
    let action: ActionRecord | undefined = found.action;
    if (!found.decided) {
      action = deps.waitSeconds === undefined ? undefined : await waitForDecision(wiring.pool, found.action.id, deps.waitSeconds);
      if (!action) {
        report({ text: '', pendingActionId: found.action.id });
        return;
      }
    }
    resume = approvalResumeFrom(action);
  }

  function report(result: { text: string; pendingActionId?: string }, artifacts: Array<{ id: string; filename: string | null }> = []): void {
    if (deps.json) {
      console.log(
        JSON.stringify(
          {
            text: result.text,
            runId,
            conversationId,
            artifacts,
            ...(result.pendingActionId ? { pendingActionId: result.pendingActionId } : {}),
          },
          null,
          2,
        ),
      );
    } else if (result.text !== '') {
      console.log(result.text);
    }
    if (result.pendingActionId) {
      console.error(`\n${approvalStopText(result.pendingActionId, conversationId)}`);
      process.exitCode = 3;
    }
  }

  const run = (turn: { userMessage: string; attachments?: AttachmentRef[] } | { resume: ApprovalResume }) =>
    runAgent({
      agent: deps.agent.definition(wiring.now(), wiring.timezone),
      provider: deps.provider,
      registry: wiring.registry,
      ctx: wiring.ctx,
      pool: wiring.pool,
      // The provider's own web search leaves the same audit row `web.search`
      // does; see @buddi/tool-web's native.ts.
      onNativeSearch: nativeSearchRecorder(wiring.pool),
      conversationId,
      runId,
      ...turn,
      loadArtifact: (id: string) => store.load(id),
      surface: CLI_SURFACE,
      memoryPreamble: deps.memoryPreamble,
      onToolCall: (name, input) => {
        if (!deps.json) console.error(`⚙ ${name} ${JSON.stringify(input)}`);
      },
    });

  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await run(
      resume
        ? { resume }
        : { userMessage: question as string, ...(attachments.length > 0 ? { attachments } : {}) },
    );
    // `--wait`: the owner decides on another surface, and this run finishes.
    while (result.stopped === 'awaiting-approval' && result.pendingActionId && deps.waitSeconds !== undefined) {
      if (!deps.json) console.error(`waiting up to ${deps.waitSeconds}s for your decision on action ${result.pendingActionId}`);
      const decided = await waitForDecision(wiring.pool, result.pendingActionId, deps.waitSeconds);
      if (!decided) break;
      result = await run({ resume: approvalResumeFrom(decided) });
    }
  } catch (err) {
    // A script still deserves the human sentence: `fetch failed` on stderr and
    // an exit code is not a diagnosis. The cause chain goes with it, because
    // the person reading a script's stderr is the person who can act on it.
    const outcome = await failedTurnReply(wiring.pool, {
      error: err,
      profile: CLI_SURFACE,
      agentId: deps.agent.id,
      agentName: `@${deps.agent.handle}`,
      // No `prompt`, so still no offer — a script has nothing to tap. The
      // conversation is named so the dead turn is *closed*: `buddi ask --last`
      // resumes this conversation, and an unanswered question in it would come
      // back as the next run's opening paragraph.
      conversationId,
      now: wiring.now(),
      log: (line) => console.error(line),
    });
    console.error(outcome.rendered.text);
    process.exitCode = 1;
    return;
  }

  // What the run made: files an agent saved in this conversation since it began.
  const { rows } = await wiring.pool.query(
    `select id, filename from core.artifacts
      where conversation_id = $1 and created_at >= $2 and created_by <> $3 and deleted_at is null
      order by created_at`,
    [conversationId, startedAt, wiring.ctx.ownerId],
  );
  const made = (rows as Array<{ id: string; filename: string | null }>).map((r) => ({ id: String(r.id), filename: r.filename }));

  // Safety net, not the mechanism: tool names are internal and nothing asks the
  // model to print one. This catches the answer of a model that did anyway.
  report(
    {
      text: stripToolNames(result.text),
      ...(result.stopped === 'awaiting-approval' && result.pendingActionId ? { pendingActionId: result.pendingActionId } : {}),
    },
    made,
  );
}

/* ------------------------------------------------------------------ *
 * chat — the REPL
 * ------------------------------------------------------------------ */

async function chat(
  args: ParsedArgs,
  selected: CatalogAgent,
  conversationId: string,
  wiring: Wiring,
  style: TerminalStyle,
  memoryPreamble: (agentId: string) => Promise<string>,
): Promise<void> {
  const { pool, registry, catalog, ctx, now, timezone } = wiring;
  const file = historyFile(process.env);
  const history = loadHistory(file);
  const handles = catalog.list().map((a) => a.handle);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history,
    historySize: HISTORY_LIMIT,
    removeHistoryDuplicates: true,
    terminal: style.tty,
    completer: completerFor({
      handles,
      listDir: (dir) => {
        try {
          return readdirSync(dir).map((name) => {
            try {
              return statSync(path.join(dir, name)).isDirectory() ? `${name}/` : name;
            } catch {
              return name;
            }
          });
        } catch {
          return [];
        }
      },
      home: homedir(),
      cwd: process.cwd(),
    }),
  });

  const out = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  /** Bound below, once the line queue exists; the session only calls it later. */
  let askLine: (question: string) => Promise<string> = async () => '';

  // A spinner only where there is somebody to watch it. `NO_COLOR`, a pipe and
  // `--quiet` all mean the same thing here: write the answer, nothing else.
  const spinner =
    style.tty && !args.quiet
      ? new Spinner({ write: (chunk) => process.stderr.write(chunk), enabled: true })
      : silentSpinner();

  const approvals = new CliApprovals({
    pool,
    registry,
    ctx,
    timezone,
    ownerId: ctx.ownerId,
  });

  const artifacts = createCoreArtifactStore({ pool, env: process.env });

  // `/recap` runs the very executor the scheduler uses — in this process, on
  // this pool. The CLI is separate from `buddi serve`, so nothing is delivered
  // twice: the answer is handed straight back to this prompt.
  const runMission = createInlineMissionRunner({
    pool,
    registry,
    provider: wiring.provider,
    ctx,
    env: process.env,
    catalog,
    now,
  });

  const session = new ChatSession({
    pool,
    catalog,
    registry,
    ctx,
    now,
    timezone,
    providerFor: (a) => wiring.providerFor(a),
    agent: selected,
    conversationId,
    out,
    ask: (question) => askLine(question),
    style,
    spinner,
    memoryPreamble,
    artifacts,
    approvals,
    runMission,
    // `/quiet` and the unanswered counter. The same two verbs Telegram gets:
    // proactive messages are one arc, whichever surface the owner is on.
    engagement: createEngagementHooks({
      pool,
      now,
      timezone,
      unavailableText: QUIET_UNAVAILABLE_TEXT,
    }),
    // Which mission `/recap` runs is the installed plugins' suggestion for the
    // `recap` role, resolved here at the composition root, never in the surface.
    ...(recapMissionId() === undefined ? {} : { recapMissionId: recapMissionId() as string }),
    present: async (text) => {
      if (shouldPage(text, style, process.stdout.rows ?? 0)) {
        rl.pause();
        const paged = await page(text);
        rl.resume();
        if (paged) return;
      }
      out(text);
    },
    ...(args.quiet ? { quiet: true } : {}),
    clearScreen: () => process.stdout.write('\u001b[2J\u001b[3J\u001b[H'),
    home: homedir(),
    cwd: process.cwd(),
    fileExists: (candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
    readFile: (candidate) => readFile(candidate),
  });

  out(bold(`buddi — ${selected.name}`, style.color));
  out(dim(`conversation ${conversationId}`, style.color));
  out(
    dim(
      `${selected.provider.kind} · ${selected.model} · ${selected.provider.credential.kind}`,
      style.color,
    ),
  );
  out(dim('/help for commands, /quit to leave', style.color));

  /*
   * A brand-new installation introduces itself before the owner types anything.
   *
   * Only where somebody is watching: a piped `buddi chat` is a script, and a
   * script has no first run to have. The claim is core's and is atomic, so the
   * terminal and Telegram cannot both interview the same owner — whichever gets
   * here first is the one that does it.
   */
  if (style.tty && !args.quiet) {
    try {
      if (await shouldStartFirstRun(pool, CLI_SURFACE.id)) await session.firstRun();
    } catch (err) {
      out(dim(`first run unavailable: ${err instanceof Error ? err.message : String(err)}`, style.color));
    }
  }

  let leaving = false;

  /*
   * One line queue, two readers.
   *
   * `rl.question` would be shorter, but it drops every line that arrives while
   * a run is in flight — pipe a script of commands into `buddi chat` and all
   * but the first are silently lost. Lines are queued as readline emits them
   * instead, and both the prompt and the approval question take from the same
   * queue, so a piped session behaves exactly like a typed one.
   */
  const queued: string[] = [];
  let waiting: ((line: string | undefined) => void) | null = null;
  let closed = false;

  rl.on('line', (line) => {
    const resolve = waiting;
    waiting = null;
    if (resolve) resolve(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    const resolve = waiting;
    waiting = null;
    resolve?.(undefined);
  });

  const readLine = (prompt: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      const queuedLine = queued.shift();
      if (queuedLine !== undefined) {
        // Already read while something else was running: show what it answers.
        process.stdout.write(prompt);
        if (!style.tty) process.stdout.write(`${queuedLine}\n`);
        resolve(queuedLine);
        return;
      }
      if (closed) {
        resolve(undefined);
        return;
      }
      waiting = resolve;
      if (style.tty) {
        rl.setPrompt(prompt);
        rl.prompt();
      } else {
        process.stdout.write(prompt);
      }
    });

  askLine = async (question: string): Promise<string> => (await readLine(question)) ?? '';

  /*
   * Ctrl-C has three meanings, in the order a person expects them: stop what is
   * running, clear what is half-typed, leave. It never kills a run's durable
   * state — the turn is already written — so the worst it costs is the wait.
   */
  rl.on('SIGINT', () => {
    if (session.busy) {
      session.cancel();
      return;
    }
    if (rl.line !== '' || session.multiline.active) {
      session.multiline.reset();
      rl.write(null, { ctrl: true, name: 'u' });
      process.stdout.write('\n');
      rl.prompt();
      return;
    }
    leaving = true;
    rl.close();
  });

  for (;;) {
    if (leaving) break;
    // The blank line is written, not made part of the prompt: readline redraws
    // the prompt on every keystroke and a newline inside it breaks the editor.
    process.stdout.write('\n');
    const line = await readLine(session.prompt());
    if (line === undefined || leaving) break; // Ctrl-D, or the input ended
    try {
      if ((await session.feed(line)) === 'quit') break;
    } catch (err) {
      out(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // `history` is readline's own array, newest first; the typings do not expose
  // it, so it is read through one narrow cast rather than kept in parallel.
  saveHistory(file, (rl as unknown as { history?: string[] }).history ?? history);
  rl.close();
}

/** Importing this module (tests, tooling) must not start a session. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(describeDatabaseError(err, process.env.DATABASE_URL));
    process.exit(1);
  });
}
