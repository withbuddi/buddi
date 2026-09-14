#!/usr/bin/env node
/**
 * `buddi` — the CLI chat surface (roadmap step 1).
 *
 * A surface is a thin adapter: it maps owner input to a conversation, submits it
 * to the runtime, and renders the reply. It never executes a tool itself and
 * never handles a credential — `resolveProvider` does that once, and fails
 * closed with a typed problem.
 */
import { realpathSync } from 'node:fs';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  resolveProvider,
  UnknownAgentError,
  type CatalogAgent,
} from '@buddi/core';
import { createConversation, createProvider, runAgent } from '@buddi/runtime';
import type { Pool } from 'pg';
import {
  AGENTS_DIR,
  createToolRegistry,
  loadGatewayCatalog,
  memoryPreambleFor,
} from './agents/catalog.js';
import { bindDelegation } from './agents/delegation.js';
import { createWiringAsync, loadEnv, type Wiring } from './bootstrap.js';
import { describeDatabaseError } from './db-ready.js';
import { stripToolNames } from './telegram/surface.js';

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

const USAGE = `buddi — your personal agents

  buddi chat                 start a new conversation with the default agent
  buddi chat --agent <handle>  ... with a specific agent, by @handle or id
  buddi chat --resume <id>   continue a conversation
  buddi chat --last          continue the most recent conversation
  buddi ask "<question>"     one turn, then exit
  buddi ask "<question>" --agent <handle>
  buddi ask "<question>" --resume <id>
  buddi agents               every agent installed under agents/

In chat: /quit to exit, /tools to list tools, /id to print the conversation id.`;

export type ParsedArgs = {
  command: 'chat' | 'ask' | 'agents' | 'help';
  question?: string;
  resume?: string;
  /** Agent handle or id from --agent; undefined means the catalog default. */
  agent?: string;
  last: boolean;
};

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

/**
 * The chat surface's entry point. `argv` is the command and its options —
 * `buddi` (@buddi/cli) passes the slice it owns, so the single global binary
 * calls this function instead of re-implementing it.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return;
  }

  loadEnv();

  if (args.command === 'agents') {
    // Listing agents needs no database and no credential: build the catalog
    // alone rather than the whole wiring.
    const catalog = loadGatewayCatalog({ env: process.env, registry: createToolRegistry() });
    for (const a of catalog.list()) {
      console.log(
        `${bold(`@${a.handle}`)} ${dim(a.id)}${a.isDefault ? dim(' (default)') : ''} ` +
          `${dim(`[${a.providerKind}]`)} — ${a.name}: ${a.description}`,
      );
      // An agent whose credential this machine does not have is listed, not
      // hidden: the owner should see what they have installed and what it
      // would take to run it.
      if (!a.available) console.log(`  ${dim(`unavailable: ${a.unavailableReason}`)}`);
    }
    return;
  }

  if (args.command === 'ask' && !args.question) {
    console.error('buddi ask needs a question: buddi ask "can I afford a bike?"');
    process.exit(1);
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
    // what to do about it.
    console.error(describeDatabaseError(err, process.env.DATABASE_URL));
    process.exit(1);
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
      process.exit(1);
    }
    throw err;
  }
  const agent = selected.definition(now(), timezone);

  // The *selected* agent's provider, not the process's: an agent pinned to
  // another provider is run on that provider or not at all.
  const resolution = resolveProvider(agent.provider, process.env);
  if (!resolution.ok) {
    console.error(
      `@${selected.handle} cannot run [${resolution.problem.code}]: ${resolution.problem.message}`,
    );
    console.error(
      selected.provider.kind === 'openai'
        ? 'Set OPENAI_API_KEY in .env, or pick an agent on another provider (buddi agents).'
        : 'Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY in .env',
    );
    process.exit(1);
  }
  const provider = createProvider(resolution.provider);
  /** Delegation needs both halves; rebound here for the *selected* agent. */
  bindDelegation(registry, {
    catalog,
    provider,
    providerFor: ({ id }) => {
      const target = catalog.get(id);
      return target ? wiring.providerFor(target) : provider;
    },
  });

  /** Every run starts with what this agent remembers about the owner. */
  const memoryPreamble = memoryPreambleFor(pool);

  try {
    let conversationId = args.resume;
    if (!conversationId && args.last) {
      conversationId = await lastConversation(pool, agent.id);
      if (!conversationId) console.error('no previous conversation; starting a new one');
    }
    if (!conversationId) {
      conversationId = await createConversation(pool, agent.id);
    }
    const id: string = conversationId;

    /** One turn. The definition is rebuilt so `{{today}}` stays current. */
    const turn = async (message: string): Promise<void> => {
      const definition = selected.definition(now(), timezone);
      const result = await runAgent({
        agent: definition,
        provider,
        registry,
        ctx,
        pool,
        conversationId: id,
        userMessage: message,
        memoryPreamble,
        onToolCall: (name, input) => {
          console.error(dim(`⚙ ${name} ${JSON.stringify(input)}`));
        },
      });
      // Tool names are internal: the owner sees what happened, not which
      // function did it — the same rule the Telegram surface applies.
      console.log(stripToolNames(result.text));
    };

    if (args.command === 'ask') {
      console.error(`conversation: ${id}`);
      await turn(args.question as string);
      return;
    }

    console.log(bold(`buddi — ${agent.name}`));
    console.log(dim(`conversation: ${id}`));
    console.log(
      dim(
        `provider: ${resolution.provider.kind}, model: ${resolution.provider.model} ` +
          `(${resolution.provider.credentialKind})`,
      ),
    );
    console.log(dim('/quit to exit, /tools to list tools, /id for the conversation id'));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      let line: string;
      try {
        line = await rl.question('\nyou> ');
      } catch {
        break; // Ctrl-D closes the interface
      }
      const message = line.trim();
      if (message === '') continue;
      if (message === '/quit' || message === '/exit') break;
      if (message === '/id') {
        console.log(id);
        continue;
      }
      if (message === '/tools') {
        for (const spec of registry.list().filter((s) => agent.tools.includes(s.name))) {
          console.log(`${spec.name} [${spec.tier}] — ${spec.description}`);
        }
        continue;
      }
      try {
        await turn(message);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    rl.close();
  } finally {
    await pool.end();
  }
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
