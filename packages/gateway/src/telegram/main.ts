#!/usr/bin/env node
/**
 * `buddi-telegram` — the Telegram surface process (roadmap step 2).
 *
 * Wiring only: resolve the provider once, register the finance plugin, pair the
 * allowlisted owner id if the environment names one, then long-poll. Every
 * authorization decision belongs to core; every tool call belongs to the
 * registry. This file decides nothing.
 *
 * `startTelegram` is the reusable half: `buddi serve` starts the same surface
 * next to the scheduler in one process, sharing one pool and one provider.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureOwner,
  getSurfaceCursor,
  listSurfaceIdentities,
  pairSurfaceIdentity,
  type SurfaceIdentity,
  type ToolContext,
  type ToolRegistry,
} from '@buddi/core';
import { runAgent, type RuntimeProvider } from '@buddi/runtime';
import type { Pool } from 'pg';
import { createWiring, loadEnv } from '../bootstrap.js';
import { TelegramApi, type TelegramBotCommand } from './api.js';
import { SURFACE, SURFACE_HINT, TelegramSurface, type RunMission } from './surface.js';
import type { AgentCatalog } from './types.js';

/**
 * The command menu, shown only to paired owner chats.
 *
 * Telegram resolves a menu from the narrowest scope outward. buddi clears the
 * *default* scope and publishes this list per paired chat, so a stranger who
 * opens the bot sees no menu at all — the same fail-closed posture the surface
 * takes with messages.
 */
export const OWNER_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'agents', description: 'List the agents you can talk to' },
  { command: 'use', description: 'Switch agent' },
  { command: 'status', description: 'Where you stand right now' },
  { command: 'recap', description: 'Run the weekly recap now' },
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'id', description: 'Show my Telegram ids' },
  { command: 'help', description: 'What buddi can do' },
];

/**
 * The menu as one chat sees it: `use` names the agent that chat is talking to,
 * so the active agent is visible without asking. Everything else is identical.
 */
export function ownerCommandsFor(activeAgentName?: string): readonly TelegramBotCommand[] {
  const name = (activeAgentName ?? '').trim();
  if (name === '') return OWNER_COMMANDS;
  return OWNER_COMMANDS.map((c) =>
    c.command === 'use' ? { ...c, description: `Switch agent (active: ${name})` } : c,
  );
}

/**
 * Publish the owner menu for every paired chat and clear the default scope.
 * Cosmetic: a Bot API failure is logged and never stops the surface starting.
 */
export async function applyCommandMenus(
  api: Pick<TelegramApi, 'setMyCommands' | 'deleteMyCommands'>,
  paired: readonly SurfaceIdentity[],
  log: (line: string) => void,
  activeAgentName?: (chatId: string) => Promise<string | undefined>,
): Promise<void> {
  try {
    await api.deleteMyCommands({ type: 'default' });
  } catch (err) {
    log(`telegram: clearing the default command menu failed: ${errorText(err)}`);
  }
  for (const identity of paired) {
    const chatId = identity.externalChatId;
    if (!chatId) continue;
    let name: string | undefined;
    if (activeAgentName) {
      name = await activeAgentName(chatId).catch((err) => {
        log(`telegram: active agent for chat ${chatId} unknown: ${errorText(err)}`);
        return undefined;
      });
    }
    try {
      await api.setMyCommands(ownerCommandsFor(name), { type: 'chat', chat_id: chatId });
      log(`telegram: menu set for chat ${chatId}`);
    } catch (err) {
      log(`telegram: menu for chat ${chatId} failed: ${errorText(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Numeric ids only: a username is not an identity. */
export function numericId(value: string | undefined, label: string): string | undefined {
  const raw = (value ?? '').trim();
  if (raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} must be a numeric id, got: ${raw}`);
  }
  return raw;
}

export interface TelegramDeps {
  pool: Pool;
  registry: ToolRegistry;
  /** Every installed agent. One bot, many agents; the chat picks with /use. */
  catalog: AgentCatalog;
  provider: RuntimeProvider;
  ctx: ToolContext;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Injected in tests; built from `TELEGRAM_BOT_TOKEN` otherwise. */
  api?: TelegramApi;
  log?: (line: string) => void;
  /**
   * Runs a mission inline for `/recap`. `buddi serve` owns the executor and
   * passes it; the standalone surface has no scheduler and leaves it out.
   */
  runMission?: RunMission;
}

export interface TelegramHandle {
  botUsername: string | undefined;
  botId: number;
  /** Owner identities paired for this surface at startup. */
  paired: SurfaceIdentity[];
  /** The persisted polling offset as it stood at startup. */
  cursor: string | undefined;
  /** Resolves when polling has stopped and every queued run has drained. */
  done: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start the Telegram surface. Returns once the bot identity is known and
 * polling has begun; the caller owns the pool and decides when to stop.
 */
export async function startTelegram(deps: TelegramDeps): Promise<TelegramHandle> {
  const { pool, env, now } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!deps.api && token === '') throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const api = deps.api ?? new TelegramApi({ token });

  await ensureOwner(pool, 'owner');

  const ownerUserId = numericId(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID');
  const ownerChatId = numericId(env.TELEGRAM_OWNER_CHAT_ID, 'TELEGRAM_OWNER_CHAT_ID');
  if (ownerUserId) {
    await pairSurfaceIdentity(pool, {
      surface: SURFACE,
      externalUserId: ownerUserId,
      externalChatId: ownerChatId ?? ownerUserId,
    });
  }

  const paired = await listSurfaceIdentities(pool, SURFACE);
  const cursor = await getSurfaceCursor(pool, SURFACE);
  const me = await api.getMe();

  const setChatMenu = async (chatId: string, agent: { name: string }): Promise<void> => {
    await api.setMyCommands(ownerCommandsFor(agent.name), { type: 'chat', chat_id: chatId });
  };

  const surface = new TelegramSurface({
    api,
    pool,
    catalog: deps.catalog,
    log,
    setChatMenu,
    ...(deps.runMission ? { runMission: deps.runMission } : {}),
    // The surface decided *which* agent this turn belongs to; resolving the id
    // again here is what makes the definition current (`{{today}}`, a reloaded
    // file) without letting the wiring choose a different agent.
    run: async ({ conversationId, text, agent, onToolCall }) => {
      const result = await runAgent({
        agent: deps.catalog.resolve(agent.id).definition(now()),
        provider: deps.provider,
        registry: deps.registry,
        ctx: deps.ctx,
        pool,
        conversationId,
        userMessage: text,
        systemSuffix: SURFACE_HINT,
        onToolCall: (name, input) => {
          log(`⚙ ${name} ${JSON.stringify(input)}`);
          onToolCall?.(name, input);
        },
      });
      return result.text;
    },
  });

  // Only paired chats get a menu; strangers see none. Each chat's menu names
  // the agent that chat is talking to.
  await applyCommandMenus(api, paired, log, async (chatId) =>
    (await surface.activeAgent(chatId)).name,
  );

  surface.offset = cursor === undefined ? undefined : Number(cursor);

  const done = surface.start();

  return {
    botUsername: me.username ?? undefined,
    botId: me.id,
    paired,
    cursor,
    done,
    async stop(): Promise<void> {
      surface.stop();
      await done;
    },
  };
}

/** How the startup banner renders a paired identity list. */
export function describePaired(paired: readonly SurfaceIdentity[]): string {
  if (paired.length === 0) {
    return 'none — messages will be ignored until TELEGRAM_OWNER_USER_ID is set';
  }
  return paired
    .map((p) => `${p.externalUserId}${p.externalChatId ? `@chat:${p.externalChatId}` : ''}`)
    .join(', ');
}

export async function main(): Promise<void> {
  loadEnv();

  let wiring;
  try {
    wiring = createWiring(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    const handle = await startTelegram({
      pool: wiring.pool,
      registry: wiring.registry,
      catalog: wiring.catalog,
      provider: wiring.provider,
      ctx: wiring.ctx,
      env: process.env,
      now: wiring.now,
    });

    console.log(`buddi telegram surface`);
    console.log(`  bot: @${handle.botUsername ?? '(unknown)'} (id ${handle.botId})`);
    console.log(`  paired owner ids: ${describePaired(handle.paired)}`);
    console.log(`  last cursor: ${handle.cursor ?? '(none)'}`);
    console.log(`  model: ${wiring.model} (${wiring.credentialKind})`);

    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping telegram surface…`);
      void handle.stop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await handle.done;
    console.log('telegram surface stopped cleanly');
  } finally {
    await wiring.pool.end();
  }
}

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
