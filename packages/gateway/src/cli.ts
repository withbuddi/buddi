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
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  resolveProvider,
  UnknownAgentError,
  type CatalogAgent,
  type ToolContext,
} from '@buddi/core';
import { createAnthropicProvider, createConversation, runAgent } from '@buddi/runtime';
import { config as loadDotenv } from 'dotenv';
import type { Pool } from 'pg';
import {
  AGENTS_DIR,
  createToolRegistry,
  loadGatewayCatalog,
  REPO_ROOT,
} from './agents/catalog.js';

const OWNER_ID = 'owner';

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

const USAGE = `buddi — your personal agents

  buddi chat                 start a new conversation with the default agent
  buddi chat --agent <id>    ... with a specific agent (buddi agents to list them)
  buddi chat --resume <id>   continue a conversation
  buddi chat --last          continue the most recent conversation
  buddi ask "<question>"     one turn, then exit
  buddi ask "<question>" --agent <id>
  buddi ask "<question>" --resume <id>
  buddi agents               every agent installed under agents/

In chat: /quit to exit, /tools to list tools, /id to print the conversation id.`;

export type ParsedArgs = {
  command: 'chat' | 'ask' | 'agents' | 'help';
  question?: string;
  resume?: string;
  /** Agent id from --agent; undefined means the catalog default. */
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
      if (!value) throw new Error('--agent needs an agent id');
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

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return;
  }

  loadDotenv({ path: path.join(REPO_ROOT, '.env') });

  const registry = createToolRegistry();
  const catalog = loadGatewayCatalog({ env: process.env, registry });

  if (args.command === 'agents') {
    for (const a of catalog.list()) {
      console.log(
        `${bold(a.id)}${a.isDefault ? dim(' (default)') : ''} — ${a.name}: ${a.description}`,
      );
    }
    return;
  }

  if (args.command === 'ask' && !args.question) {
    console.error('buddi ask needs a question: buddi ask "can I afford a bike?"');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set (cp .env.example .env, then pnpm db:up)');
    process.exit(1);
  }

  const now = (): Date => new Date();

  // Fails closed: an unknown --agent is never coerced into the default.
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
  const agent = selected.definition(now());

  const resolution = resolveProvider(agent.provider, process.env);
  if (!resolution.ok) {
    console.error(
      `provider not usable [${resolution.problem.code}]: ${resolution.problem.message}`,
    );
    console.error(
      'Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY in .env',
    );
    process.exit(1);
  }
  const provider = createAnthropicProvider(resolution.provider);

  const pool = createPool(databaseUrl);
  const ctx: ToolContext = { db: pool, ownerId: OWNER_ID, now };

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
      const definition = selected.definition(now());
      const result = await runAgent({
        agent: definition,
        provider,
        registry,
        ctx,
        pool,
        conversationId: id,
        userMessage: message,
        onToolCall: (name, input) => {
          console.error(dim(`⚙ ${name} ${JSON.stringify(input)}`));
        },
      });
      console.log(result.text);
    };

    if (args.command === 'ask') {
      console.error(`conversation: ${id}`);
      await turn(args.question as string);
      return;
    }

    console.log(bold(`buddi — ${agent.name}`));
    console.log(dim(`conversation: ${id}`));
    console.log(
      dim(`model: ${resolution.provider.model} (${resolution.provider.credentialKind})`),
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
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
