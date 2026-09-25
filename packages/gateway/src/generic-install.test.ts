/**
 * The generic install: one agent, no roles, no plugins.
 *
 * This is the friend who clones buddi, deletes `agents/*` except their own, and
 * installs nothing. Everything here is a claim about *that* machine — the
 * catalog loads, the two capability commands decline politely and say how to
 * declare the capability, `add-defaults` registers nothing it cannot place, the
 * dashboard shows no money block, and no surface's help text mentions a domain.
 *
 * It is a boundary test, not a unit test: if any of it fails, buddi has grown a
 * dependency on this owner's agents (docs/architecture.md, principle 6).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ToolRegistry,
  loadAgentCatalog,
  roleProblemMessage,
  type AgentCatalog,
  type Queryable,
} from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { ROLE_OVERVIEW, ROLE_RECAP } from './agents/roles.js';
import { helpText } from './chat/commands.js';
import { ChatSession } from './chat/session.js';
import { Spinner } from './chat/spinner.js';
import { planDefaultMissions } from './missions/defaults.js';
import { recapMissionId } from './missions/recap.js';
import { HELP, NO_MAKER_TEXT, TelegramSurface } from './telegram/surface.js';
import { readHome } from './web/read.js';

/** One agent, no roles — the fixture is the whole installation. */
const AGENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'generic-agents',
);

/** Zero plugins registered: the valid, running state core promises. */
function genericCatalog(): AgentCatalog {
  return loadAgentCatalog({ dir: AGENTS_DIR, registry: new ToolRegistry(), env: {} });
}

/** Answers every query with no rows: no active agent, no owner, no history. */
const emptyDb: Queryable = { query: async () => ({ rows: [] }) } as unknown as Queryable;

/** A Telegram API that records what was said and nothing else. */
function recordingApi(): { api: any; said: string[] } {
  const said: string[] = [];
  const api = {
    sendMessage: async (_chatId: string, text: string) => {
      said.push(text);
      return 'msg-1';
    },
    editMessageText: async () => {},
    sendChatAction: async () => {},
    answerCallbackQuery: async () => {},
    getMe: async () => ({ username: 'buddi_bot' }),
  };
  return { api, said };
}

function genericSurface(catalog: AgentCatalog): { surface: TelegramSurface; said: string[] } {
  const { api, said } = recordingApi();
  const surface = new TelegramSurface({
    api,
    pool: emptyDb,
    catalog,
    run: async () => 'a reply nobody should see',
    // The runner exists: the command must decline on the *role*, not on wiring.
    runMission: async () => ({ ok: true, text: 'a recap nobody should see' }),
    log: () => {},
    typingIntervalMs: 60_000,
  });
  return { surface, said };
}

describe('a generic installation: one agent, no roles, no plugins', () => {
  it('loads the catalog and answers with the one agent it has', () => {
    const catalog = genericCatalog();
    expect(catalog.list().map((a) => a.id)).toEqual(['notetaker']);
    expect(catalog.defaultAgent().id).toBe('notetaker');
    expect(catalog.list()[0]?.roles).toEqual([]);
  });

  it('declines /status politely, naming the frontmatter key', async () => {
    const catalog = genericCatalog();
    const { surface, said } = genericSurface(catalog);
    await surface.handleText('42', '42', '/status');
    expect(said).toEqual([roleProblemMessage(ROLE_OVERVIEW)]);
    expect(said[0]).toContain('roles: [overview]');
    expect(said[0]).toContain('agent.md');
    expect(said[0]).not.toMatch(/error|failed|undefined/i);
  });

  it('declines /recap politely, naming the frontmatter key', async () => {
    const catalog = genericCatalog();
    const { surface, said } = genericSurface(catalog);
    await surface.handleText('42', '42', '/recap');
    expect(said).toEqual([roleProblemMessage(ROLE_RECAP)]);
    expect(said[0]).toContain('roles: [recap]');
  });

  it('declines /new politely, naming the maker buddi ships', async () => {
    const catalog = genericCatalog();
    const { surface, said } = genericSurface(catalog);
    await surface.handleText('42', '42', '/new');
    expect(said).toEqual([NO_MAKER_TEXT]);
    expect(said[0]?.split('\n')).toHaveLength(1);
    expect(said[0]).toContain('Agent Father');
    expect(said[0]).not.toMatch(/error|failed|undefined/i);
  });

  it('gives the CLI session the same two answers', async () => {
    const catalog = genericCatalog();
    const lines: string[] = [];
    const session = new ChatSession({
      pool: emptyDb,
      catalog,
      registry: new ToolRegistry(),
      ctx: {} as any,
      now: () => new Date('2026-09-14T12:00:00Z'),
      providerFor: () => ({}) as any,
      agent: catalog.defaultAgent(),
      conversationId: 'conv-1',
      out: (line) => lines.push(line),
      ask: async () => '',
      style: { color: false, width: 80, tty: false },
      spinner: new Spinner({ write: () => {}, enabled: false }),
      // Wired, so the refusal is about the role and nothing else.
      runMission: async () => ({ ok: true, text: 'a recap nobody should see' }),
      recapMissionId: 'whatever-recap',
    });

    await session.status();
    await session.recap();
    expect(lines).toEqual([
      roleProblemMessage(ROLE_OVERVIEW),
      roleProblemMessage(ROLE_RECAP),
    ]);
  });

  it('registers no suggested mission, and says why when a plugin suggests one', () => {
    const catalog = genericCatalog();

    // No plugins at all: nothing is suggested, and only the infrastructure
    // mission — which belongs to the gateway, not to a domain — is registered.
    // `getting-started` rides along with it: the first-run arc belongs to the
    // gateway too, and with no onboarding state read it is registered disabled.
    const bare = planDefaultMissions(catalog, []);
    expect(bare.entries.map((e) => e.mission.id)).toEqual(['getting-started', 'sentinel-wake']);
    expect(bare.skipped).toEqual([]);
    expect(recapMissionId([])).toBeUndefined();

    // A plugin *is* installed, but nobody claims its roles: every suggestion is
    // skipped with the sentence that says how to accept it.
    const withPlugin = planDefaultMissions(catalog, [
      {
        name: 'demo',
        version: '0.0.0',
        schema: 'demo',
        migrationsDir: '/dev/null',
        tools: [],
        missions: [
          {
            id: 'demo-recap',
            name: 'Demo recap',
            agentRole: ROLE_RECAP,
            cron: '0 8 * * FRI',
            prompt: 'recap the week',
          },
          {
            id: 'demo-ghost',
            name: 'Demo ghost',
            agentId: 'nobody-here',
            cron: '0 8 * * *',
            prompt: 'do a thing',
          },
        ],
      },
    ]);
    expect(withPlugin.entries.map((e) => e.mission.id)).toEqual([
      'getting-started',
      'sentinel-wake',
    ]);
    expect(withPlugin.skipped.map((s) => s.missionId)).toEqual(['demo-recap', 'demo-ghost']);
    expect(withPlugin.skipped[0]?.reason).toContain('roles: [recap]');
    expect(withPlugin.skipped[1]?.reason).toContain('nobody-here');
  });

  it('points the wake mission at the only agent there is', () => {
    const catalog = genericCatalog();
    const entries = planDefaultMissions(catalog, []).entries;
    const wake = entries.find((e) => e.mission.id === 'sentinel-wake');
    expect(wake?.mission.agentId).toBe('notetaker');
    expect(wake?.cron).toBeUndefined();
    // The arc names the same agent for the same reason: nobody claims a role.
    const arc = entries.find((e) => e.mission.id === 'getting-started');
    expect(arc?.mission.agentId).toBe('notetaker');
    expect(arc?.mission.enabled).toBe(false);
  });

  it('puts nothing on Home when no plugin contributes a block', async () => {
    const blocks = await readHome({ registry: new ToolRegistry(), ctx: {} as any });
    // Not a money block with zeros and no explanation: no block at all. A
    // generic install has no idea money is a thing a dashboard could show.
    expect(blocks).toEqual([]);
  });

  it('has no domain words in either surface’s help text', () => {
    // Words that only make sense if buddi were a finance app. `/recap` and
    // `/status` are capabilities; "cash", "debt" and "advisor" are a domain.
    const domain =
      /\b(finance|financial|money|cash|balances?|bank|debt|liabilit\w*|budget|spending|advisor|invoice|portfolio)\b/i;
    for (const text of [HELP, helpText()]) {
      const offending = text
        .split('\n')
        .filter((line) => domain.test(line));
      expect(offending).toEqual([]);
    }
  });
});
