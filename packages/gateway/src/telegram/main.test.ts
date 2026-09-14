/**
 * Startup wiring for the Telegram surface: the command menu.
 *
 * The menu is an authorization surface of its own — an unpaired stranger must
 * not even see what the bot can do — so the default scope is cleared and the
 * list is published once per paired chat. No network, no database.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Queryable, SurfaceIdentity } from '@buddi/core';
import type { TelegramApi } from './api.js';
import { OWNER_COMMANDS, applyCommandMenus, ownerCommandsFor, startTelegram } from './main.js';
import type { AgentCatalog, CatalogAgent } from './types.js';

/* ---------------- fakes ---------------- */

class FakeDb implements Queryable {
  identities: {
    id: string;
    owner_id: string;
    surface: string;
    external_user_id: string;
    external_chat_id: string | null;
  }[] = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('insert into core.owner')) return { rows: [{ id: 'owner' }] };
    if (text.startsWith('insert into core.surface_identities')) {
      const row = {
        id: `id-${this.identities.length}`,
        owner_id: params[0],
        surface: params[1],
        external_user_id: params[2],
        external_chat_id: params[3] ?? null,
      };
      const existing = this.identities.find(
        (i) => i.surface === row.surface && i.external_user_id === row.external_user_id,
      );
      if (existing) {
        if (row.external_chat_id) existing.external_chat_id = row.external_chat_id;
        return { rows: [existing] };
      }
      this.identities.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id')) {
      return {
        rows: this.identities.filter((i) =>
          params.length === 2
            ? i.surface === params[0] && i.external_user_id === params[1]
            : i.surface === params[0],
        ),
      };
    }
    if (text.startsWith('select cursor from core.surface_cursors')) return { rows: [] };
    if (text.startsWith('insert into core.surface_cursors')) return { rows: [] };
    return { rows: [] };
  }
}

function identity(userId: string, chatId: string | null): SurfaceIdentity {
  return {
    id: `id-${userId}`,
    ownerId: 'owner',
    surface: 'telegram',
    externalUserId: userId,
    externalChatId: chatId,
  };
}

const PROVIDER = {
  kind: 'anthropic' as const,
  credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
  model: 'claude-sonnet-5',
};

function catalogAgent(id: string, handle: string, name: string): CatalogAgent {
  return {
    id,
    handle,
    name,
    description: `${name}, for testing`,
    isDefault: id === 'finance-advisor',
    file: `${id}/agent.md`,
    model: 'claude-sonnet-5',
    tools: [],
    maxTurns: 4,
    language: 'mirror',
    provider: PROVIDER,
    systemPromptTemplate: `${name}. Today is {{today}}.`,
    definition: () => ({
      id,
      name,
      systemPrompt: name,
      tools: [],
      provider: PROVIDER,
      maxTurns: 4,
    }),
  };
}

function fakeCatalog(): AgentCatalog {
  const agents = [
    catalogAgent('finance-advisor', 'ledger', 'Finance Advisor'),
    catalogAgent('concierge', 'buddi', 'Concierge'),
  ];
  return {
    get: (id) => agents.find((a) => a.id === id),
    byHandle: (handle) =>
      agents.find((a) => a.handle === handle.replace(/^@/, '').toLowerCase()),
    list: () =>
      agents.map(({ id, handle, name, description, isDefault }) => ({
        id,
        handle,
        name,
        description,
        isDefault,
      })),
    defaultAgent: () => agents[0] as CatalogAgent,
    resolve: (id) => {
      const found =
        id === undefined
          ? agents[0]
          : agents.find((a) => a.id === id || a.handle === id.replace(/^@/, ''));
      if (!found) throw new Error(`unknown agent ${id}`);
      return found;
    },
  };
}

function fakeMenuApi(fail?: 'default' | 'chat') {
  const calls: { method: string; commands?: readonly unknown[]; scope?: any }[] = [];
  const api = {
    deleteMyCommands: vi.fn(async (scope: any) => {
      calls.push({ method: 'deleteMyCommands', scope });
      if (fail === 'default') throw new Error('bot api is grumpy');
    }),
    setMyCommands: vi.fn(async (commands: readonly unknown[], scope: any) => {
      calls.push({ method: 'setMyCommands', commands, scope });
      if (fail === 'chat') throw new Error('chat not found');
    }),
  };
  return { api, calls };
}

/* ---------------- tests ---------------- */

describe('applyCommandMenus', () => {
  it('clears the default scope and publishes the menu per paired chat', async () => {
    const { api, calls } = fakeMenuApi();
    const lines: string[] = [];
    await applyCommandMenus(
      api as unknown as TelegramApi,
      [identity('4242', '4242'), identity('77', '99')],
      (line) => lines.push(line),
    );

    expect(calls[0]).toEqual({ method: 'deleteMyCommands', scope: { type: 'default' } });
    expect(calls.slice(1).map((c) => c.scope)).toEqual([
      { type: 'chat', chat_id: '4242' },
      { type: 'chat', chat_id: '99' },
    ]);
    expect(calls[1]?.commands).toBe(OWNER_COMMANDS);
    expect(OWNER_COMMANDS.map((c) => c.command)).toEqual([
      'agents',
      'use',
      'status',
      'recap',
      'approvals',
      'files',
      'devices',
      'new',
      'id',
      'help',
    ]);
    expect(lines).toContain('telegram: menu set for chat 4242');
    expect(lines).toContain('telegram: menu set for chat 99');
  });

  it('skips an identity with no chat bound', async () => {
    const { api, calls } = fakeMenuApi();
    await applyCommandMenus(api as unknown as TelegramApi, [identity('4242', null)], () => {});
    expect(calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(0);
  });

  it('logs a menu failure and keeps going', async () => {
    const lines: string[] = [];
    const { api } = fakeMenuApi('chat');
    await applyCommandMenus(
      api as unknown as TelegramApi,
      [identity('4242', '4242')],
      (line) => lines.push(line),
    );
    expect(lines.join('\n')).toContain('chat not found');

    const second = fakeMenuApi('default');
    const more: string[] = [];
    await applyCommandMenus(
      second.api as unknown as TelegramApi,
      [identity('4242', '4242')],
      (line) => more.push(line),
    );
    expect(more.join('\n')).toContain('bot api is grumpy');
    // The default failing never stops the per-chat menus.
    expect(more).toContain('telegram: menu set for chat 4242');
  });
});

describe('startTelegram', () => {
  it('sets the menu for every paired chat and clears the default scope', async () => {
    const db = new FakeDb();
    const menu = fakeMenuApi();
    const api = {
      ...menu.api,
      getMe: async () => ({ id: 1, username: 'buddibot' }),
      getUpdates: (_offset: number | undefined, signal?: any) =>
        new Promise<[]>((resolve) => signal?.addEventListener('abort', () => resolve([]))),
    };
    const lines: string[] = [];

    const handle = await startTelegram({
      pool: db as any,
      registry: {} as any,
      catalog: fakeCatalog(),
      provider: {} as any,
      ctx: {} as any,
      env: { TELEGRAM_OWNER_USER_ID: '4242', TELEGRAM_OWNER_CHAT_ID: '9001' },
      now: () => new Date('2026-09-13T00:00:00Z'),
      api: api as unknown as TelegramApi,
      log: (line) => lines.push(line),
    });
    await handle.stop();

    expect(menu.api.deleteMyCommands).toHaveBeenCalledWith({ type: 'default' });
    // The menu a chat sees names the agent that chat is talking to.
    expect(menu.api.setMyCommands).toHaveBeenCalledWith(ownerCommandsFor('ledger'), {
      type: 'chat',
      chat_id: '9001',
    });
    expect(lines).toContain('telegram: menu set for chat 9001');
    expect(handle.paired.map((p) => p.externalChatId)).toEqual(['9001']);
  });
});

describe('ownerCommandsFor', () => {
  it('names the active agent by handle in the /use description', () => {
    const commands = ownerCommandsFor('ledger');
    expect(commands.find((c) => c.command === 'use')?.description).toBe(
      'Switch agent (active: Ledger)',
    );
    // Typed with or without the @, the menu reads the same.
    expect(ownerCommandsFor('@ledger')).toEqual(commands);
    // Everything else is the shared menu, unchanged.
    expect(commands.map((c) => c.command)).toEqual(OWNER_COMMANDS.map((c) => c.command));
    expect(commands.filter((c) => c.command !== 'use')).toEqual(
      OWNER_COMMANDS.filter((c) => c.command !== 'use'),
    );
  });

  it('falls back to the plain menu when no agent is named', () => {
    expect(ownerCommandsFor()).toBe(OWNER_COMMANDS);
    expect(ownerCommandsFor('  ')).toBe(OWNER_COMMANDS);
  });

  it('publishes a per-chat menu naming that chat active agent', async () => {
    const { api, calls } = fakeMenuApi();
    await applyCommandMenus(
      api as unknown as TelegramApi,
      [identity('4242', '4242')],
      () => {},
      async () => 'buddi',
    );
    expect(calls[1]?.commands).toEqual(ownerCommandsFor('buddi'));
  });
});
