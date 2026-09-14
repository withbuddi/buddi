/**
 * Telegram surface tests. No network, no database: a fake `fetch` answers the
 * Bot API and an in-memory `Queryable` stands in for core's tables.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnknownAgentError, roleProblemMessage, type Queryable } from '@buddi/core';
import { TelegramApi, splitMessage, type FetchLike, type TelegramUpdate } from './api.js';
import {
  HELP,
  NO_DEVICES_TEXT,
  PAIRING_MAX_ATTEMPTS,
  PLACEHOLDER_TEXT,
  UNKNOWN_AGENT_TEXT,
  agentCallbackData,
  agentsKeyboard,
  agentsText,
  alreadyActiveText,
  callbackKind,
  parseAgentCallback,
  switchedText,
  emptyMentionText,
  handleLabel,
  parseMention,
  placeholderText,
  stripBotMention,
  unknownHandleText,
  RECAP_NOT_REGISTERED_TEXT,
  RECAP_UNAVAILABLE_TEXT,
  APPROVALS_UNAVAILABLE_TEXT,
  SURFACE,
  TelegramSurface,
  type ApprovalHooks,
  devicesText,
  pairedText,
  parseStartCode,
  progressLine,
  readingText,
  senderLabel,
  stripToolNames,
  toPlainText,
  toolLabel,
  type RunMission,
  BURST_GAP_MS,
  MAX_BURST_MESSAGES,
  splitIntoMessages,
} from './surface.js';
import {
  classifyMime,
  filesText,
  formatBytes,
  largestPhoto,
  MAX_ATTACHMENT_BYTES,
  NO_FILES_TEXT,
  oversizeText,
  referencesAttachment,
  type ArtifactRow,
  type ArtifactStore,
  type SaveArtifactInput,
} from './attachments.js';
import type { AgentCatalog, CatalogAgent } from './types.js';
import { OwnerNotPairedError, notifyOwner, ownerChatId } from './notify.js';
import {
  createPairingCode,
  createPairingCodeFor,
  listDevices,
  pairingDeepLink,
  unpairDevice,
} from './pairing.js';

/* ---------------- in-memory core tables ---------------- */

class FakeDb implements Queryable {
  identities: {
    id?: string;
    owner_id: string;
    surface: string;
    external_user_id: string;
    external_chat_id: string | null;
    label?: string | null;
    paired_at?: Date;
    last_seen_at?: Date | null;
    paired_via?: string | null;
  }[] = [];
  /** core.pairing_codes, keyed by code. */
  pairingCodes = new Map<
    string,
    { surface: string; expiresAt: number; usedAt: number | null; usedBy: string | null }
  >();
  ownerDisplayName: string | null = 'Amen';
  updates: { surface: string; update_id: string }[] = [];
  cursors = new Map<string, string>();
  conversations: { id: string; agent_id: string }[] = [];
  /** keyed `${chatId}::${agentId}` — a conversation belongs to a (chat, agent). */
  chatConversations = new Map<string, string>();
  activeAgents = new Map<string, string>();
  events: { kind: string; payload: any }[] = [];
  /** core.surface_attachments, newest last. */
  attachments: {
    chat: string;
    artifact_id: string;
    filename: string | null;
    kind: string;
    mime: string;
    size_bytes: number;
    created_at: Date;
  }[] = [];
  /** core.surface_last_attachment, one row per chat. */
  lastAttachment = new Map<string, { artifact_id: string; created_at: Date }>();
  /** The clock rows are stamped with, so recency is a test input. */
  clock: () => number = () => Date.now();
  /**
   * core.onboarding. `done` by default: almost every test here is about an
   * installation that has been talking for weeks, and a pending row would put
   * the first-run interview in front of all of them. `pendingOnboarding(db)`
   * is how a test asks for a brand-new machine.
   */
  onboarding: {
    state: string;
    started_at: Date | null;
    completed_at: Date | null;
    surface: string | null;
    steps_done: string[];
    nudges_sent: number;
    last_nudge_at: Date | null;
    unanswered: number;
    quiet_until: Date | null;
    updated_at: Date | null;
  } | null = {
    state: 'done',
    started_at: new Date(0),
    completed_at: new Date(0),
    surface: 'pre-existing',
    steps_done: [],
    nudges_sent: 0,
    last_nudge_at: null,
    unanswered: 0,
    quiet_until: null,
    updated_at: new Date(0),
  };

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();

    // The detailed listing must be matched before the narrow one: it starts
    // with the same column list.
    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id, label')) {
      return {
        rows: this.identities.map((r, n) => ({
          id: r.id ?? `id-${n}`,
          ...r,
          label: r.label ?? null,
          paired_at: r.paired_at ?? new Date(this.clock()),
          last_seen_at: r.last_seen_at ?? null,
          paired_via: r.paired_via ?? null,
        })),
      };
    }
    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id')) {
      const rows = this.identities.filter((i) =>
        params.length === 2
          ? i.surface === params[0] && i.external_user_id === params[1]
          : i.surface === params[0],
      );
      return { rows: rows.map((r, n) => ({ ...r, id: r.id ?? `id-${n}` })) };
    }
    if (text.startsWith('insert into core.owner')) return { rows: [{ id: 'owner' }] };
    if (text.startsWith('select display_name from core.owner')) {
      return { rows: [{ display_name: this.ownerDisplayName }] };
    }
    if (text.startsWith('insert into core.surface_identities')) {
      const [, surface, userId, chatId, label, via] = params;
      const existing = this.identities.find(
        (i) => i.surface === surface && i.external_user_id === userId,
      );
      if (existing) {
        if (chatId) existing.external_chat_id = chatId;
        if (label) existing.label = label;
        existing.paired_via = existing.paired_via ?? via ?? null;
        return { rows: [{ ...existing, id: existing.id }] };
      }
      const row = {
        id: `00000000-0000-4000-8000-${String(this.identities.length).padStart(12, '0')}`,
        owner_id: params[0],
        surface,
        external_user_id: userId,
        external_chat_id: chatId ?? null,
        label: label ?? null,
        paired_at: new Date(this.clock()),
        last_seen_at: null,
        paired_via: via ?? null,
      };
      this.identities.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('update core.surface_identities set last_seen_at')) {
      const row = this.identities.find(
        (i) => i.surface === params[0] && i.external_user_id === params[1],
      );
      if (row) {
        row.last_seen_at = new Date(this.clock());
        // `label = coalesce(label, $3)`: filled when missing, never replaced.
        if ((row.label ?? null) === null && params[2]) row.label = params[2];
      }
      return { rows: [] };
    }
    if (text.startsWith('delete from core.surface_identities')) {
      const before = this.identities.length;
      this.identities = this.identities.filter((i) => i.id !== params[0]);
      return { rows: before === this.identities.length ? [] : [{ id: params[0] }] };
    }
    if (text.startsWith('insert into core.pairing_codes')) {
      const [code, surface, ttl] = params;
      if (this.pairingCodes.has(code)) return { rows: [] };
      const expiresAt = this.clock() + Number(ttl) * 60_000;
      this.pairingCodes.set(code, { surface, expiresAt, usedAt: null, usedBy: null });
      return { rows: [{ code, expires_at: new Date(expiresAt) }] };
    }
    // The atomic claim: one statement, and only an unused, unexpired code
    // belonging to this surface comes back.
    if (text.startsWith('update core.pairing_codes set used_at')) {
      const [code, surface] = params;
      const row = this.pairingCodes.get(code);
      if (!row || row.surface !== surface || row.usedAt !== null || row.expiresAt <= this.clock()) {
        return { rows: [] };
      }
      row.usedAt = this.clock();
      return { rows: [{ code }] };
    }
    if (text.startsWith('select used_at, expires_at from core.pairing_codes')) {
      const row = this.pairingCodes.get(params[0]);
      if (!row || row.surface !== params[1]) return { rows: [] };
      return {
        rows: [
          {
            used_at: row.usedAt === null ? null : new Date(row.usedAt),
            expires_at: new Date(row.expiresAt),
          },
        ],
      };
    }
    if (text.startsWith('update core.pairing_codes set used_by_identity')) {
      const row = this.pairingCodes.get(params[0]);
      if (row) row.usedBy = params[1];
      return { rows: [] };
    }
    if (text.startsWith('insert into core.surface_updates')) {
      const seen = this.updates.some((u) => u.surface === params[0] && u.update_id === params[1]);
      if (seen) return { rows: [] };
      this.updates.push({ surface: params[0], update_id: params[1] });
      return { rows: [{ update_id: params[1] }] };
    }
    if (text.startsWith('insert into core.surface_cursors')) {
      this.cursors.set(params[0], params[1]);
      return { rows: [] };
    }
    if (text.startsWith('select cursor from core.surface_cursors')) {
      const cursor = this.cursors.get(params[0]);
      return { rows: cursor === undefined ? [] : [{ cursor }] };
    }
    // "has this chat ever been answered?" — any agent, hence the two params.
    if (text.startsWith('select 1 from core.surface_conversations')) {
      const seen = [...this.chatConversations.keys()].some((k) => k.startsWith(`${params[1]}::`));
      return { rows: seen ? [{ '?column?': 1 }] : [] };
    }
    if (text.startsWith('select conversation_id from core.surface_conversations')) {
      const id = this.chatConversations.get(`${params[1]}::${params[2]}`);
      return { rows: id ? [{ conversation_id: id }] : [] };
    }
    if (text.startsWith('insert into core.surface_conversations')) {
      this.chatConversations.set(`${params[1]}::${params[2]}`, params[3]);
      return { rows: [] };
    }
    if (text.startsWith('select agent_id from core.surface_active_agent')) {
      const agentId = this.activeAgents.get(params[1]);
      return { rows: agentId === undefined ? [] : [{ agent_id: agentId }] };
    }
    if (text.startsWith('insert into core.surface_active_agent')) {
      this.activeAgents.set(params[1], params[2]);
      return { rows: [] };
    }
    if (text.startsWith('insert into core.surface_attachments')) {
      const [, chat, artifactId, , filename, kind, mime, size] = params;
      if (!this.attachments.some((a) => a.chat === chat && a.artifact_id === artifactId)) {
        this.attachments.push({
          chat,
          artifact_id: artifactId,
          filename: filename ?? null,
          kind,
          mime,
          size_bytes: Number(size),
          created_at: new Date(this.clock()),
        });
      }
      return { rows: [] };
    }
    if (text.startsWith('insert into core.surface_last_attachment')) {
      this.lastAttachment.set(params[1], {
        artifact_id: params[2],
        created_at: new Date(this.clock()),
      });
      return { rows: [] };
    }
    if (text.startsWith('select l.artifact_id')) {
      const last = this.lastAttachment.get(params[1]);
      if (!last) return { rows: [] };
      const row = this.attachments.find(
        (a) => a.chat === params[1] && a.artifact_id === last.artifact_id,
      );
      return {
        rows: [
          {
            artifact_id: last.artifact_id,
            created_at: last.created_at,
            kind: row?.kind,
            mime: row?.mime,
            filename: row?.filename ?? null,
            size_bytes: row?.size_bytes ?? 0,
          },
        ],
      };
    }
    if (text.startsWith('select artifact_id, filename, kind, mime, size_bytes')) {
      const rows = this.attachments
        .filter((a) => a.chat === params[1])
        .slice()
        .reverse()
        .slice(0, Number(params[2]));
      return { rows };
    }
    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
    }
    if (text.startsWith('select owner_id, state, started_at')) {
      return {
        rows: this.onboarding
          ? [{ owner_id: 'owner', ...this.onboarding }]
          : [],
      };
    }
    if (text.startsWith('insert into core.onboarding')) {
      // The only write this surface makes: the claim. `where state = 'pending'`
      // is the whole of it, so a second caller gets no row back.
      if (this.onboarding !== null && this.onboarding.state !== 'pending') return { rows: [] };
      this.onboarding = {
        state: 'in-progress',
        started_at: new Date(this.clock()),
        completed_at: null,
        surface: String(params[1] ?? 'telegram'),
        steps_done: [],
        nudges_sent: 0,
        last_nudge_at: null,
        unanswered: 0,
        quiet_until: null,
        updated_at: new Date(this.clock()),
      };
      return { rows: [{ owner_id: 'owner', ...this.onboarding }] };
    }
    if (text.startsWith('insert into core.events')) {
      this.events.push({ kind: params[0], payload: JSON.parse(params[1]) });
      return { rows: [] };
    }
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

/* ---------------- fake Bot API ---------------- */

type Sent = { method: string; body: any };

/** What `getFile` should answer for a file id, and what the bytes are. */
type FakeFile = { size?: number; bytes?: string; path?: string };

function fakeApi(
  failOn?: (method: string) => boolean,
  files: Record<string, FakeFile> = {},
): {
  api: TelegramApi;
  sent: Sent[];
  updateQueue: TelegramUpdate[][];
} {
  const sent: Sent[] = [];
  const updateQueue: TelegramUpdate[][] = [];
  let nextMessageId = 100;
  /** What `getFile` will hand out, and what those paths serve. */
  const pathOf = (fileId: string): string => files[fileId]?.path ?? `documents/${fileId}`;
  const bytesByPath = new Map(
    Object.entries(files).map(([id, f]) => [pathOf(id), f.bytes ?? 'PDF-BYTES']),
  );
  const fetchLike: FetchLike = async (url, init) => {
    // The file endpoint is a different host path and answers bytes, not JSON.
    if (url.includes('/file/bot')) {
      const filePath = url.split('/file/bot')[1]?.split('/').slice(1).join('/') as string;
      sent.push({ method: 'downloadFile', body: { file_path: filePath } });
      const bytes = Buffer.from(bytesByPath.get(filePath) ?? 'PDF-BYTES', 'latin1');
      return {
        ok: true,
        status: 200,
        text: async () => bytes.toString('latin1'),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer,
      };
    }
    const method = url.split('/').pop() as string;
    const body = JSON.parse(init?.body ?? '{}');
    sent.push({ method, body });
    if (failOn?.(method)) {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ ok: false, description: 'message to edit not found' }),
      };
    }
    const file = method === 'getFile' ? (files[body.file_id] ?? {}) : undefined;
    const result =
      method === 'getUpdates'
        ? (updateQueue.shift() ?? [])
        : method === 'sendMessage'
          ? { message_id: nextMessageId++ }
          : method === 'getFile'
            ? {
                file_id: body.file_id,
                file_path: pathOf(body.file_id),
                file_size: file?.size ?? (file?.bytes ?? 'PDF-BYTES').length,
              }
            : true;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result }),
    };
  };
  return { api: new TelegramApi({ token: 'test-token', fetch: fetchLike }), sent, updateQueue };
}

function message(updateId: number, userId: number, chatId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, username: 'someone' },
      chat: { id: chatId, type: 'private' },
      text,
    },
  };
}

/* ---------------- fake agent catalog ---------------- */

const MODEL = 'claude-sonnet-5';
const PROVIDER = {
  kind: 'anthropic' as const,
  credential: { kind: 'api-key' as const, env: 'ANTHROPIC_API_KEY' },
  model: MODEL,
};

function catalogAgent(
  id: string,
  handle: string,
  name: string,
  isDefault: boolean,
  roles: string[] = [],
): CatalogAgent {
  return {
    id,
    handle,
    name,
    description: `${name}, for testing`,
    isDefault,
    roles,
    file: `${id}/agent.md`,
    model: MODEL,
    tools: [],
    maxTurns: 4,
    language: 'mirror',
    provider: PROVIDER,
    systemPromptTemplate: `${name}. Today is {{today}}.`,
    definition: (now: Date) => ({
      id,
      name,
      systemPrompt: `${name}. Today is ${now.toISOString().slice(0, 10)}.`,
      tools: [],
      provider: PROVIDER,
      maxTurns: 4,
    }),
  };
}

const FINANCE = catalogAgent('finance-advisor', 'ledger', 'Finance Advisor', true, [
  'overview',
  'recap',
]);
const CONCIERGE = catalogAgent('concierge', 'buddi', 'Concierge', false);

/** The mission `/recap` runs here, as the composition root would hand it over. */
const RECAP_MISSION_ID = 'friday-recap';

/** Two agents, one of them the default — the smallest catalog that can switch. */
function fakeCatalog(agents: CatalogAgent[] = [FINANCE, CONCIERGE]): AgentCatalog {
  const first = agents[0] as CatalogAgent;
  const byDefault = agents.find((a) => a.isDefault) ?? first;
  const handleOf = (raw: string): string => raw.trim().replace(/^@/, '').toLowerCase();
  return {
    get: (id) => agents.find((a) => a.id === id),
    agentsWithRole: (role) => agents.filter((a) => a.roles.includes(role)),
    agentForRole: (role) => {
      const found = agents.find((a) => a.roles.includes(role));
      return found
        ? { ok: true as const, agent: found }
        : {
            ok: false as const,
            problem: {
              code: 'no-agent-for-role' as const,
              role,
              message: roleProblemMessage(role),
            },
          };
    },
    byHandle: (handle) => agents.find((a) => a.handle === handleOf(handle)),
    list: () =>
      agents.map(({ id, handle, name, description, isDefault, roles }) => ({
        id,
        handle,
        name,
        description,
        isDefault,
        roles,
      })),
    defaultAgent: () => byDefault,
    resolve: (id) => {
      if (id === undefined) return byDefault;
      const found =
        agents.find((a) => a.id === id) ?? agents.find((a) => a.handle === handleOf(id));
      if (!found) throw new UnknownAgentError(id, agents.map((a) => a.id));
      return found;
    },
  };
}

/** The placeholder as each agent renders it. */
const FINANCE_PLACEHOLDER = placeholderText(handleLabel(FINANCE.handle));
const CONCIERGE_PLACEHOLDER = placeholderText(handleLabel(CONCIERGE.handle));

function surfaceWith(
  db: FakeDb,
  run = vi.fn(async () => 'reply'),
  extra: {
    failOn?: (method: string) => boolean;
    now?: () => number;
    runMission?: RunMission;
    catalog?: AgentCatalog;
    botUsername?: string;
    setChatMenu?: (chatId: string, agent: CatalogAgent) => Promise<void>;
    files?: Record<string, FakeFile>;
    artifacts?: ArtifactStore | null;
    approvals?: ApprovalHooks;
    recapMissionId?: string | null;
    burstGapMs?: number;
  } = {},
) {
  const { api, sent } = fakeApi(extra.failOn, extra.files ?? {});
  const store = extra.artifacts === null ? undefined : (extra.artifacts ?? fakeStore().store);
  const surface = new TelegramSurface({
    api,
    pool: db,
    catalog: extra.catalog ?? fakeCatalog(),
    ...(extra.botUsername ? { botUsername: extra.botUsername } : {}),
    ...(store ? { artifacts: store } : {}),
    run,
    ...(extra.recapMissionId === null
      ? {}
      : { recapMissionId: extra.recapMissionId ?? RECAP_MISSION_ID }),
    log: () => {},
    typingIntervalMs: 60_000,
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.runMission ? { runMission: extra.runMission } : {}),
    ...(extra.setChatMenu ? { setChatMenu: extra.setChatMenu } : {}),
    ...(extra.approvals ? { approvals: extra.approvals } : {}),
    ...(extra.burstGapMs === undefined ? {} : { burstGapMs: extra.burstGapMs }),
  });
  return { surface, sent, run, api, store };
}

/* ---------------- fake artifact store ---------------- */

/** Core's store, in memory: enough to prove what the surface handed over. */
function fakeStore(): { store: ArtifactStore; saved: SaveArtifactInput[]; rows: ArtifactRow[] } {
  const saved: SaveArtifactInput[] = [];
  const rows: ArtifactRow[] = [];
  return {
    saved,
    rows,
    store: {
      async save(input) {
        saved.push(input);
        const row: ArtifactRow = {
          id: `art-${rows.length + 1}`,
          kind: classifyMime(input.mime),
          mime: input.mime,
          filename: input.filename ?? null,
          sizeBytes: input.bytes.length,
          sha256: `sha-${rows.length + 1}`,
          storagePath: `artifacts/art-${rows.length + 1}`,
          caption: input.caption ?? null,
          createdAt: new Date().toISOString(),
        };
        rows.push(row);
        return row;
      },
      async load(id) {
        const row = rows.find((r) => r.id === id);
        return row ? { mime: row.mime, data: 'AAAA' } : null;
      },
    },
  };
}

/* ---------------- attachment updates ---------------- */

function documentUpdate(
  updateId: number,
  file: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  caption?: string,
  userId = OWNER,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false },
      chat: { id: userId === OWNER ? OWNER : userId, type: 'private' },
      document: file,
      ...(caption ? { caption } : {}),
    },
  };
}

function photoUpdate(
  updateId: number,
  sizes: { file_id: string; file_size?: number; width?: number }[],
  caption?: string,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: OWNER, is_bot: false },
      chat: { id: OWNER, type: 'private' },
      photo: sizes,
      ...(caption ? { caption } : {}),
    },
  };
}

const OWNER = 4242;

/** Let queued microtasks (placeholder send, run start) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A chat that has been answered before, so the one-time first-run orientation
 * is already behind it. Most tests here are about an established conversation;
 * the greeting has its own describe block.
 */
function alreadyGreeted(db: FakeDb, chatId = OWNER, agentId = 'finance-advisor'): FakeDb {
  db.conversations.push({ id: 'conv-prior', agent_id: agentId });
  db.chatConversations.set(`${chatId}::${agentId}`, 'conv-prior');
  return db;
}

/** A machine that has never been talked to: the first run is still ahead of it. */
function pendingOnboarding(db: FakeDb): FakeDb {
  db.onboarding = null;
  return db;
}

function withOwner(db: FakeDb, chatId = OWNER): FakeDb {
  db.identities.push({
    owner_id: 'owner',
    surface: SURFACE,
    external_user_id: String(OWNER),
    external_chat_id: String(chatId),
  });
  return db;
}

/* ---------------- tests ---------------- */

describe('toPlainText', () => {
  it('strips bold markers without touching the date inside', () => {
    expect(toPlainText('**Status — 2026-09-13**')).toBe('Status — 2026-09-13');
  });

  it('leaves a plain paragraph exactly as it is', () => {
    const plain = 'You have 1 240,50 € left after rent, and nothing is due before Friday.';
    expect(toPlainText(plain)).toBe(plain);
  });

  it('keeps a lone asterisk in arithmetic and underscores inside words', () => {
    expect(toPlainText('2 * 3 = 6 and my_own_note stayed')).toBe(
      '2 * 3 = 6 and my_own_note stayed',
    );
  });

  it('removes a tool name the model let slip into the answer', () => {
    expect(toPlainText('Stored it (finance.set_liability). All set.')).toBe(
      'Stored it. All set.',
    );
  });

  it('turns a pipe table into em-dash lines and drops the rule row', () => {
    const table = [
      '| Account | Balance |',
      '| --- | ---: |',
      '| Checking | 1 240,50 € |',
      '| Savings | 8 000,00 € |',
    ].join('\n');
    expect(toPlainText(table)).toBe(
      ['Account — Balance', 'Checking — 1 240,50 €', 'Savings — 8 000,00 €'].join('\n'),
    );
  });

  it('drops code fences and keeps their content verbatim', () => {
    const fenced = ['Here:', '```sql', 'select * from core.events', '```', 'done'].join('\n');
    expect(toPlainText(fenced)).toBe(
      ['Here:', 'select * from core.events', 'done'].join('\n'),
    );
  });

  it('removes headings, inline code and italics, and rewrites links', () => {
    expect(toPlainText('## Next steps')).toBe('Next steps');
    expect(toPlainText('run `pnpm serve` now')).toBe('run pnpm serve now');
    expect(toPlainText('this is *important* and __also this__')).toBe(
      'this is important and also this',
    );
    expect(toPlainText('see [the docs](https://example.com/x)')).toBe(
      'see the docs (https://example.com/x)',
    );
  });

  it('collapses three or more blank lines to two', () => {
    expect(toPlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('is a no-op on an empty string', () => {
    expect(toPlainText('')).toBe('');
  });
});

describe('stripToolNames', () => {
  const BUG =
    'Every card and loan due date is already stored (finance.set_liability), and ' +
    'every recurring payment is on the calendar (finance.add_recurring).';

  it('renders the sentence from the bug report clean and still readable', () => {
    expect(stripToolNames(BUG)).toBe(
      'Every card and loan due date is already stored, and every recurring payment ' +
        'is on the calendar.',
    );
  });

  it('drops the whole parenthetical, with or without a connector', () => {
    expect(stripToolNames('I saved it (via finance.set_liability) last night.')).toBe(
      'I saved it last night.',
    );
    expect(stripToolNames('Noted (memory.remember, artifacts.store_file) for you.')).toBe(
      'Noted for you.',
    );
  });

  it('drops a backticked or quoted mention together with its quotes', () => {
    expect(stripToolNames('I called `finance.add_recurring` for you.')).toBe(
      'I called for you.',
    );
    expect(stripToolNames('I used "email.list_messages" there.')).toBe('I used there.');
    expect(stripToolNames("I used 'agent.delegate' there.")).toBe('I used there.');
  });

  it('drops a bare mention mid-sentence and tidies the spacing', () => {
    expect(stripToolNames('The reminder.create_reminder tool holds it.')).toBe(
      'The tool holds it.',
    );
    expect(stripToolNames('Filed it via schedule.add_event yesterday.')).toBe(
      'Filed it yesterday.',
    );
  });

  it('matches case-insensitively', () => {
    expect(stripToolNames('Done (Finance.Set_Liability).')).toBe('Done.');
  });

  it('leaves everything that merely has a dot byte-identical', () => {
    const survivors = [
      'Your balance is 1 240,50 € and 3.5% went to fees.',
      'The renewal is 2026-09-14, not 2026.09.14.',
      'shotcrisp.app and americanexpress.com both billed you.',
      'Write to amouzou@gmail.com or check gmail.com.',
      'I read Statement.pdf and finance.csv this morning.',
      'See https://example.com/finance.set_liability for the docs.',
      'We are on v1.2.3 and node 22.11.0.',
      'The e-mail came from no-reply@finance.americanexpress.com.',
    ];
    for (const line of survivors) expect(stripToolNames(line)).toBe(line);
  });

  it('leaves a paragraph with no tool names exactly as it is', () => {
    const text = [
      'You have 1 240,50 € left after rent.',
      '',
      'Nothing is due before Friday, and the card statement closes on the 20th.',
    ].join('\n');
    expect(stripToolNames(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = stripToolNames(BUG);
    expect(stripToolNames(once)).toBe(once);
    expect(stripToolNames(stripToolNames('Saved (memory.write_fact). Done.'))).toBe(
      stripToolNames('Saved (memory.write_fact). Done.'),
    );
  });

  it('keeps the rest of the text when one line was nothing but the mention', () => {
    const text = ['Here is where you stand.', 'finance.list_accounts.', 'Nothing is due.'].join(
      '\n',
    );
    expect(stripToolNames(text)).toBe(['Here is where you stand.', '', 'Nothing is due.'].join('\n'));
  });

  it('is a no-op on an empty string', () => {
    expect(stripToolNames('')).toBe('');
  });
});

describe('splitMessage', () => {
  it('leaves a short message alone', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits at 4000 characters, on a line boundary when there is one', () => {
    const line = `${'x'.repeat(99)}\n`;
    const text = line.repeat(60); // 6000 chars
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('\n').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('hard-cuts a single over-long line', () => {
    const chunks = splitMessage('y'.repeat(9000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4000);
  });

  it('sends every chunk as its own plain-text message', async () => {
    const { api, sent } = fakeApi();
    await api.sendMessage(1, 'z'.repeat(9000));
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(3);
    expect(sent[0]?.body.parse_mode).toBeUndefined();
  });
});

describe('TelegramSurface authorization', () => {
  it('ignores a non-owner message and records surface.rejected', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(1, 9999, 9999, 'hello?')]);
    await surface.drain();

    expect(run).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(db.events).toHaveLength(1);
    expect(db.events[0]?.kind).toBe('surface.rejected');
    expect(db.events[0]?.payload).toMatchObject({
      reason: 'unpaired',
      externalUserId: '9999',
      updateId: '1',
    });
  });

  it('rejects the owner id speaking from another chat', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(2, OWNER, -100777, 'hi')]);
    await surface.drain();
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(db.events[0]?.payload).toMatchObject({ reason: 'chat-mismatch' });
  });

  it('rejects a group chat even from the owner', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    const update = message(3, OWNER, OWNER, 'hi');
    (update.message as any).chat.type = 'supergroup';
    await surface.processUpdates([update]);
    await surface.drain();
    expect(run).not.toHaveBeenCalled();
    expect(db.events[0]?.payload).toMatchObject({ reason: 'non-private-chat' });
  });
});

describe('TelegramSurface offline contract', () => {
  it('persists the update before advancing the offset', async () => {
    const db = withOwner(new FakeDb());
    const order: string[] = [];
    const spy = vi.spyOn(db, 'query');
    spy.mockImplementation(async function (this: any, sql: string, params?: any[]) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('insert into core.surface_updates')) order.push('persist');
      if (text.startsWith('insert into core.surface_cursors')) order.push('advance');
      return FakeDb.prototype.query.call(db, sql, params);
    } as any);

    const { surface } = surfaceWith(db);
    await surface.processUpdates([message(10, OWNER, OWNER, 'hi')]);
    await surface.drain();

    expect(order).toEqual(['persist', 'advance']);
    expect(db.cursors.get(SURFACE)).toBe('11');
    expect(surface.offset).toBe(11);
  });

  it('does not advance the offset when persistence fails', async () => {
    const db = withOwner(new FakeDb());
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.replace(/\s+/g, ' ').trim().startsWith('insert into core.surface_updates')) {
        throw new Error('db down');
      }
      return FakeDb.prototype.query.call(db, sql, params);
    });
    const { surface } = surfaceWith(db);
    await expect(surface.processUpdates([message(20, OWNER, OWNER, 'hi')])).rejects.toThrow('db down');
    expect(db.cursors.get(SURFACE)).toBeUndefined();
    expect(surface.offset).toBeUndefined();
  });

  it('processes an update id exactly once', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    const update = message(30, OWNER, OWNER, 'what is my balance?');
    await surface.processUpdates([update]);
    await surface.drain();
    await surface.processUpdates([update, message(31, OWNER, OWNER, 'again')]);
    await surface.drain();

    expect(run).toHaveBeenCalledTimes(2);
    expect(db.updates.map((u) => u.update_id)).toEqual(['30', '31']);
    expect(surface.offset).toBe(32);
  });
});

describe('TelegramSurface conversation handling', () => {
  it('replies to /id with the numeric user and chat ids, without a run', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(40, OWNER, OWNER, '/id')]);
    await surface.drain();

    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.body.text).toBe(`Your Telegram user id: ${OWNER}\nThis chat id: ${OWNER}`);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps one conversation per chat and starts a new one on /new', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([
      message(50, OWNER, OWNER, 'first'),
      message(51, OWNER, OWNER, 'second'),
    ]);
    await surface.drain();
    expect(run.mock.calls.map((c: any) => c[0].conversationId)).toEqual(['conv-1', 'conv-1']);

    await surface.processUpdates([message(52, OWNER, OWNER, '/new'), message(53, OWNER, OWNER, 'third')]);
    await surface.drain();
    expect(run.mock.calls.at(-1)?.[0].conversationId).toBe('conv-2');
  });

  it('sends the final answer as plain text, markdown markers removed', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    const run = vi.fn(async () => '**Status — 2026-09-13**\n\nYou have 1 240,50 € left.');
    const { surface, sent } = surfaceWith(db, run as any);
    await surface.processUpdates([message(65, OWNER, OWNER, 'where do I stand?')]);
    await surface.drain();

    const final = sent.filter((s) => s.method === 'editMessageText').at(-1);
    expect(final?.body.text).toBe('Status — 2026-09-13\n\nYou have 1 240,50 € left.');
  });

  it('maps /status onto the advisor status overview', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([message(60, OWNER, OWNER, '/status')]);
    await surface.drain();
    expect(run.mock.calls[0]?.[0].text).toBe('Status');
  });

  it('serializes runs per chat', async () => {
    const db = withOwner(new FakeDb());
    const order: string[] = [];
    let release: (() => void) | undefined;
    const run = vi.fn(async ({ text }: any) => {
      order.push(`start:${text}`);
      if (text === 'one') await new Promise<void>((r) => (release = r));
      order.push(`end:${text}`);
      return 'ok';
    });
    const { surface } = surfaceWith(db, run as any);
    const work = surface.processUpdates([
      message(70, OWNER, OWNER, 'one'),
      message(71, OWNER, OWNER, 'two'),
    ]);
    await work;
    await tick(); // the placeholder is posted before the run starts
    expect(order).toEqual(['start:one']);
    release?.();
    await surface.drain();
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it('sends a typing action while the run is in progress', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(80, OWNER, OWNER, 'hello')]);
    await surface.drain();
    expect(sent.some((s) => s.method === 'sendChatAction' && s.body.action === 'typing')).toBe(true);
  });

  it('reports a failed run to the owner and logs surface.error', async () => {
    const db = withOwner(new FakeDb());
    const run = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const { surface, sent } = surfaceWith(db, run as any);
    await surface.processUpdates([message(90, OWNER, OWNER, 'hello')]);
    await surface.drain();
    const edit = sent.find((s) => s.method === 'editMessageText');
    expect(edit?.body.text).toContain('provider exploded');
    expect(db.events.map((e) => e.kind)).toContain('surface.error');
  });
});

describe('TelegramSurface progress bubble', () => {
  it('maps tool names to labels and falls back to the bare name', () => {
    expect(toolLabel('finance.list_accounts')).toBe('checking accounts');
    expect(toolLabel('finance.project_cashflow')).toBe('projecting cash flow');
    expect(toolLabel('finance.summary')).toBe('summarizing spending');
    expect(toolLabel('finance.list_liabilities')).toBe('checking debts');
    expect(toolLabel('finance.spending_baseline')).toBe('measuring typical spending');
    expect(toolLabel('finance.list_txns')).toBe('list txns');
    expect(toolLabel('other.thing_here')).toBe('thing here');
  });

  it('keeps the progress line under 200 characters', () => {
    const line = progressLine(Array.from({ length: 40 }, (_, n) => `label ${n}`));
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('sends the placeholder before the run starts', async () => {
    const db = withOwner(new FakeDb());
    let sentAtRun: Sent[] = [];
    let captured: Sent[] = [];
    const run = vi.fn(async () => {
      sentAtRun = [...captured];
      return 'reply';
    });
    const made = surfaceWith(db, run as any);
    captured = made.sent;
    await made.surface.processUpdates([message(100, OWNER, OWNER, 'hello')]);
    await made.surface.drain();

    expect(sentAtRun.filter((s) => s.method === 'sendMessage')).toHaveLength(1);
    expect(sentAtRun.find((s) => s.method === 'sendMessage')?.body.text).toBe(FINANCE_PLACEHOLDER);
  });

  it('edits the placeholder with a progress line on a tool call', async () => {
    const db = withOwner(new FakeDb());
    const run = vi.fn(async ({ onToolCall }: any) => {
      onToolCall?.('finance.list_accounts', {});
      return 'reply';
    });
    const { surface, sent } = surfaceWith(db, run as any);
    await surface.processUpdates([message(101, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText');
    expect(edits[0]?.body.text).toBe('⏳ Working… (checking accounts)');
    expect(edits[0]?.body.message_id).toBe(100);
  });

  it('throttles edits to one per 1.5s', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    let clock = 1_000;
    const run = vi.fn(async ({ onToolCall }: any) => {
      onToolCall?.('finance.list_accounts', {});
      clock += 100;
      onToolCall?.('finance.project_cashflow', {});
      return 'reply';
    });
    const { surface, sent } = surfaceWith(db, run as any, { now: () => clock });
    await surface.processUpdates([message(102, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText');
    // one progress edit (the second tool call is inside the throttle window),
    // plus the final answer edit.
    expect(edits).toHaveLength(2);
    expect(edits[0]?.body.text).toBe('⏳ Working… (checking accounts)');
    expect(edits[1]?.body.text).toBe('reply');
  });

  it('edits a progress line again once the throttle window has passed', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    let clock = 1_000;
    const run = vi.fn(async ({ onToolCall }: any) => {
      onToolCall?.('finance.list_accounts', {});
      clock += 2_000;
      onToolCall?.('finance.project_cashflow', {});
      return 'reply';
    });
    const { surface, sent } = surfaceWith(db, run as any, { now: () => clock });
    await surface.processUpdates([message(103, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText').map((s) => s.body.text);
    expect(edits).toEqual([
      '⏳ Working… (checking accounts)',
      '⏳ Working… (checking accounts, projecting cash flow)',
      'reply',
    ]);
  });

  it('edits the placeholder into a short final answer', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'you have $12 left'));
    await surface.processUpdates([message(104, OWNER, OWNER, 'hello')]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(1); // placeholder only
    const edits = sent.filter((s) => s.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body.text).toBe('you have $12 left');
    expect(sent.some((s) => s.method === 'deleteMessage')).toBe(false);
  });

  it('deletes the placeholder and sends chunks for a long answer', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    const long = 'w'.repeat(9000);
    const { surface, sent } = surfaceWith(db, vi.fn(async () => long));
    await surface.processUpdates([message(105, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const deletes = sent.filter((s) => s.method === 'deleteMessage');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.body.message_id).toBe(100);
    expect(sent.filter((s) => s.method === 'editMessageText')).toHaveLength(0);
    // placeholder + three chunks
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(4);
  });

  it('falls back to sendMessage when the final edit fails', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'the answer'), {
      failOn: (method) => method === 'editMessageText',
    });
    await surface.processUpdates([message(106, OWNER, OWNER, 'hello')]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'editMessageText')).toHaveLength(1);
    const sends = sent.filter((s) => s.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body.text).toBe('the answer');
  });

  it('does not post a placeholder for commands that do not run the agent', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(107, OWNER, OWNER, '/id'),
      message(108, OWNER, OWNER, '/new'),
      message(109, OWNER, OWNER, '/start'),
    ]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(3);
    expect(sent.some((s) => s.body.text === FINANCE_PLACEHOLDER)).toBe(false);
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false);
  });
});

describe('TelegramSurface /recap', () => {
  it('runs the mission through the injected runMission and lands it in the bubble', async () => {
    const db = withOwner(new FakeDb());
    const runMission = vi.fn(async (_id: string, _chat: string, onToolCall?: any) => {
      onToolCall?.('finance.list_accounts', {});
      return { ok: true as const, text: 'cash is fine' };
    });
    const run = vi.fn(async () => 'reply');
    const { surface, sent } = surfaceWith(db, run, { runMission: runMission as any });
    await surface.processUpdates([message(120, OWNER, OWNER, '/recap')]);
    await surface.drain();

    expect(runMission).toHaveBeenCalledTimes(1);
    expect(runMission.mock.calls[0]?.[0]).toBe(RECAP_MISSION_ID);
    expect(runMission.mock.calls[0]?.[1]).toBe(String(OWNER));
    expect(run).not.toHaveBeenCalled();

    // placeholder -> progress line -> final answer, one bubble throughout
    const sends = sent.filter((s) => s.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.text).toBe(FINANCE_PLACEHOLDER);
    const edits = sent.filter((s) => s.method === 'editMessageText').map((s) => s.body.text);
    expect(edits).toEqual(['⏳ Working… (checking accounts)', 'cash is fine']);
  });

  it('says /recap needs buddi serve when no runner is wired', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(121, OWNER, OWNER, '/recap')]);
    await surface.drain();

    const sends = sent.filter((s) => s.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.text).toBe(RECAP_UNAVAILABLE_TEXT);
    expect(sends[0]?.body.text).toContain('buddi serve');
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false);
  });

  it('explains how to register the mission when it is unknown', async () => {
    const db = withOwner(new FakeDb());
    const runMission = vi.fn(async () => ({ ok: false as const, reason: 'unknown-mission' as const }));
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'reply'), {
      runMission: runMission as any,
    });
    await surface.processUpdates([message(122, OWNER, OWNER, '/recap')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body.text).toBe(RECAP_NOT_REGISTERED_TEXT);
    expect(edits[0]?.body.text).toContain('buddi missions add-defaults');
  });

  it('reports a failing mission in the bubble', async () => {
    const db = withOwner(new FakeDb());
    const runMission = vi.fn(async () => {
      throw new Error('no provider');
    });
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'reply'), {
      runMission: runMission as any,
    });
    await surface.processUpdates([message(123, OWNER, OWNER, '/recap')]);
    await surface.drain();

    expect(sent.find((s) => s.method === 'editMessageText')?.body.text).toContain('no provider');
    expect(db.events.map((e) => e.kind)).toContain('surface.error');
  });

  it('answers /help with the same welcome text as /start', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(124, OWNER, OWNER, '/start'),
      message(125, OWNER, OWNER, '/help'),
    ]);
    await surface.drain();

    const sends = sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);
    expect(sends).toEqual([HELP, HELP]);
    expect(HELP).toContain('/recap');
  });
});

describe('notifyOwner', () => {
  it('sends to the paired owner chat', async () => {
    const db = withOwner(new FakeDb(), 777);
    const { api, sent } = fakeApi();
    expect(await ownerChatId(db)).toBe('777');
    const chat = await notifyOwner('recap ready', { pool: db, api });
    expect(chat).toBe('777');
    expect(sent[0]).toMatchObject({ method: 'sendMessage', body: { chat_id: '777', text: 'recap ready' } });
  });

  it('fails with a typed error when nothing is paired', async () => {
    const db = new FakeDb();
    const { api } = fakeApi();
    await expect(notifyOwner('recap', { pool: db, api })).rejects.toBeInstanceOf(OwnerNotPairedError);
  });
});


describe('TelegramSurface agents', () => {
  it('runs the default agent when the chat has never switched', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([message(200, OWNER, OWNER, 'how much is left?')]);
    await surface.drain();

    expect(run.mock.calls[0]?.[0].agent.id).toBe('finance-advisor');
    expect(db.activeAgents.size).toBe(0);
    expect(db.conversations[0]?.agent_id).toBe('finance-advisor');
  });

  it('lists the agents, marking the active one', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(201, OWNER, OWNER, '/agents')]);
    await surface.drain();

    const text = sent.find((s) => s.method === 'sendMessage')?.body.text as string;
    expect(text.split('\n').slice(1, 3)).toEqual([
      '• ledger — Finance Advisor (active)',
      '• buddi — Concierge',
    ]);
    expect(text).toBe(agentsText(fakeCatalog().list(), 'finance-advisor'));
  });

  it('/use persists the switch and later messages run that agent', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([
      message(202, OWNER, OWNER, 'hello advisor'),
      message(203, OWNER, OWNER, '/use concierge'),
      message(204, OWNER, OWNER, 'hello concierge'),
    ]);
    await surface.drain();

    expect(db.activeAgents.get(String(OWNER))).toBe('concierge');
    expect(
      sent.some((s) => s.body.text === 'You are now talking to Concierge.'),
    ).toBe(true);
    expect(run.mock.calls.map((c: any) => c[0].agent.id)).toEqual([
      'finance-advisor',
      'concierge',
    ]);
    // Each agent keeps its own conversation for this chat.
    expect(run.mock.calls.map((c: any) => c[0].conversationId)).toEqual(['conv-1', 'conv-2']);
    expect(db.conversations.map((c) => c.agent_id)).toEqual(['finance-advisor', 'concierge']);
  });

  it('resumes an agent conversation when switching back', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([
      message(205, OWNER, OWNER, 'one'),
      message(206, OWNER, OWNER, '/use concierge'),
      message(207, OWNER, OWNER, 'two'),
      message(208, OWNER, OWNER, '/use finance-advisor'),
      message(209, OWNER, OWNER, 'three'),
    ]);
    await surface.drain();

    expect(run.mock.calls.map((c: any) => c[0].conversationId)).toEqual([
      'conv-1',
      'conv-2',
      'conv-1',
    ]);
    expect(db.conversations).toHaveLength(2);
  });

  it('/new resets only the active agent conversation', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(210, OWNER, OWNER, 'advisor one'),
      message(211, OWNER, OWNER, '/use concierge'),
      message(212, OWNER, OWNER, 'concierge one'),
      message(213, OWNER, OWNER, '/new'),
      message(214, OWNER, OWNER, 'concierge two'),
      message(215, OWNER, OWNER, '/use finance-advisor'),
      message(216, OWNER, OWNER, 'advisor two'),
    ]);
    await surface.drain();

    expect(sent.some((s) => s.body.text === 'New conversation started with Concierge.')).toBe(true);
    expect(run.mock.calls.map((c: any) => c[0].conversationId)).toEqual([
      'conv-1', // finance advisor
      'conv-2', // concierge
      'conv-3', // concierge, after /new
      'conv-1', // the finance advisor thread is untouched
    ]);
  });

  it('refuses an unknown agent id without switching', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([
      message(217, OWNER, OWNER, '/use nope'),
      message(218, OWNER, OWNER, 'hello'),
    ]);
    await surface.drain();

    expect(sent.find((s) => s.method === 'sendMessage')?.body.text).toBe(UNKNOWN_AGENT_TEXT);
    expect(db.activeAgents.size).toBe(0);
    expect(run.mock.calls[0]?.[0].agent.id).toBe('finance-advisor');
  });

  it('re-publishes the chat menu after a switch', async () => {
    const db = withOwner(new FakeDb());
    const menus: { chatId: string; name: string }[] = [];
    const { surface } = surfaceWith(db, vi.fn(async () => 'reply'), {
      setChatMenu: async (chatId, agent) => {
        menus.push({ chatId, name: agent.name });
      },
    });
    await surface.processUpdates([message(219, OWNER, OWNER, '/use concierge')]);
    await surface.drain();
    expect(menus).toEqual([{ chatId: String(OWNER), name: 'Concierge' }]);
  });

  it('names the working agent in the placeholder', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(220, OWNER, OWNER, 'hello'),
      message(221, OWNER, OWNER, '/use concierge'),
      message(222, OWNER, OWNER, 'hello again'),
    ]);
    await surface.drain();

    const placeholders = sent
      .filter((s) => s.method === 'sendMessage' && String(s.body.text).startsWith('⏳'))
      .map((s) => s.body.text);
    expect(placeholders).toEqual([FINANCE_PLACEHOLDER, CONCIERGE_PLACEHOLDER]);
    // The bubble names the agent by its handle, capitalized.
    expect(FINANCE_PLACEHOLDER).toBe('⏳ Ledger is working…');
    expect(CONCIERGE_PLACEHOLDER).toBe('⏳ Buddi is working…');
    expect(placeholderText()).toBe(PLACEHOLDER_TEXT);
  });

  it('/whoami names the active agent', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(223, OWNER, OWNER, '/use concierge'),
      message(224, OWNER, OWNER, '/whoami'),
    ]);
    await surface.drain();
    expect(sent.at(-1)?.body.text).toBe('You are talking to Concierge. Send /agents to switch.');
  });

  it('falls back to the default when the pinned agent is gone', async () => {
    const db = withOwner(new FakeDb());
    db.activeAgents.set(String(OWNER), 'retired-agent');
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([message(225, OWNER, OWNER, 'hello')]);
    await surface.drain();
    expect(run.mock.calls[0]?.[0].agent.id).toBe('finance-advisor');
  });
});

describe('TelegramSurface agent buttons', () => {
  /** A tap on the agent list, from whoever. */
  const useTap = (agentId: string, fromId = OWNER, updateId = 300): TelegramUpdate => ({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: fromId },
      data: `use:${agentId}`,
      message: { message_id: 42, chat: { id: OWNER, type: 'private' } },
    },
  });

  it('parses and routes callback data by prefix', () => {
    expect(callbackKind('use:concierge')).toBe('agent');
    expect(callbackKind('apr:1111:approve')).toBe('approval');
    expect(callbackKind(undefined)).toBe('approval');
    expect(agentCallbackData('finance-advisor')).toBe('use:finance-advisor');
    expect(parseAgentCallback('use:finance-advisor')).toBe('finance-advisor');
    // Bounded and validated: no spaces, no colons, nothing unbounded.
    expect(parseAgentCallback('use:')).toBeUndefined();
    expect(parseAgentCallback('use:a b')).toBeUndefined();
    expect(parseAgentCallback(`use:${'a'.repeat(80)}`)).toBeUndefined();
    expect(parseAgentCallback('apr:x:approve')).toBeUndefined();
    expect(() => agentCallbackData('a'.repeat(80))).toThrow(/too long/);
  });

  it('answers /agents with one button per agent and no @handle in the text', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(299, OWNER, OWNER, '/agents')]);
    await surface.drain();

    const msg = sent.find((s) => s.method === 'sendMessage');
    const text = msg?.body.text as string;
    const keyboard = msg?.body.reply_markup?.inline_keyboard as { text: string; callback_data: string }[][];
    expect(keyboard).toHaveLength(2);
    expect(keyboard.map((row) => row[0])).toEqual([
      { text: '✓ Ledger (active)', callback_data: 'use:finance-advisor' },
      { text: 'Switch to Buddi', callback_data: 'use:concierge' },
    ]);
    // The list itself never spells a handle with an `@`: Telegram would link it.
    for (const line of text.split('\n').filter((l) => l.startsWith('•'))) {
      expect(line).not.toContain('@');
    }
    expect(agentsKeyboard(fakeCatalog().list(), 'concierge').inline_keyboard[1]?.[0]?.text).toBe(
      '✓ Buddi (active)',
    );
  });

  it('switches on a tap, refreshes the list, answers and re-publishes the menu', async () => {
    const db = withOwner(new FakeDb());
    const menus: { chatId: string; name: string }[] = [];
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'reply'), {
      setChatMenu: async (chatId, agent) => {
        menus.push({ chatId, name: agent.name });
      },
    });
    await surface.processUpdates([
      useTap('concierge'),
      message(301, OWNER, OWNER, 'hello'),
    ]);
    await surface.drain();

    expect(db.activeAgents.get(String(OWNER))).toBe('concierge');
    const edit = sent.find((s) => s.method === 'editMessageText');
    expect(edit?.body.message_id).toBe(42);
    expect(edit?.body.text).toBe(agentsText(fakeCatalog().list(), 'concierge'));
    expect(edit?.body.reply_markup?.inline_keyboard).toHaveLength(2);
    expect(edit?.body.reply_markup.inline_keyboard[1][0].text).toBe('✓ Buddi (active)');
    const answer = sent.find((s) => s.method === 'answerCallbackQuery');
    expect(answer?.body.text).toBe(switchedText('Buddi'));
    expect(menus).toEqual([{ chatId: String(OWNER), name: 'Concierge' }]);
    // The switch is durable: the next message runs the agent that was tapped.
    expect(run.mock.calls[0]?.[0].agent.id).toBe('concierge');
  });

  it('answers a tap on the active agent without changing anything', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([useTap('finance-advisor', OWNER, 302)]);
    await surface.drain();

    expect(db.activeAgents.size).toBe(0);
    expect(sent.filter((s) => s.method === 'editMessageText')).toEqual([]);
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBe(
      alreadyActiveText('Ledger'),
    );
  });

  it('records a stranger tap as rejected and tells them nothing', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([useTap('concierge', 999, 303)]);
    await surface.drain();

    expect(db.activeAgents.size).toBe(0);
    expect(sent.filter((s) => s.method === 'editMessageText')).toEqual([]);
    expect(sent.filter((s) => s.method === 'sendMessage')).toEqual([]);
    const answer = sent.find((s) => s.method === 'answerCallbackQuery');
    expect(answer?.body).toEqual({ callback_query_id: 'cb-303' });
    const rejected = db.events.filter((e) => e.kind === 'surface.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload).toMatchObject({
      surface: SURFACE,
      kind: 'callback',
      agentId: 'concierge',
      externalUserId: '999',
    });
  });

  it('answers an unknown agent id with an error and switches nothing', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([useTap('retired-agent', OWNER, 304)]);
    await surface.drain();

    expect(db.activeAgents.size).toBe(0);
    expect(sent.filter((s) => s.method === 'editMessageText')).toEqual([]);
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBe(
      UNKNOWN_AGENT_TEXT,
    );
  });

  it('never hands a use: tap to the approval machinery', async () => {
    const db = withOwner(new FakeDb());
    const handleCallback = vi.fn(async () => {});
    const approvals: ApprovalHooks = { handleCallback, pending: async () => 'none' };
    const { surface } = surfaceWith(db, vi.fn(async () => 'reply'), { approvals });
    await surface.processUpdates([useTap('concierge', OWNER, 305)]);
    await surface.drain();

    expect(handleCallback).not.toHaveBeenCalled();
    expect(db.activeAgents.get(String(OWNER))).toBe('concierge');
  });

  it('handles a use: tap even when no approval machinery is wired', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([useTap('concierge', OWNER, 306)]);
    await surface.drain();
    expect(db.activeAgents.get(String(OWNER))).toBe('concierge');
    expect(sent.some((s) => s.method === 'answerCallbackQuery')).toBe(true);
  });
});

describe('TelegramSurface /status under another agent', () => {
  it('runs the finance advisor for that one message without switching', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'you have $12 left'));
    await surface.processUpdates([
      message(230, OWNER, OWNER, '/use concierge'),
      message(231, OWNER, OWNER, 'hello'),
      message(232, OWNER, OWNER, '/status'),
      message(233, OWNER, OWNER, 'and again'),
    ]);
    await surface.drain();

    const calls = run.mock.calls.map((c: any) => c[0]);
    expect(calls.map((c: any) => c.agent.id)).toEqual([
      'concierge',
      'finance-advisor',
      'concierge',
    ]);
    // The status run uses the advisor's own conversation, and the chat stays
    // pointed at the concierge.
    expect(calls.map((c: any) => c.conversationId)).toEqual(['conv-1', 'conv-2', 'conv-1']);
    expect(calls[1]?.text).toBe('Status');
    expect(db.activeAgents.get(String(OWNER))).toBe('concierge');

    const statusPlaceholder = sent.filter(
      (s) => s.method === 'sendMessage' && s.body.text === FINANCE_PLACEHOLDER,
    );
    expect(statusPlaceholder).toHaveLength(1);
    const noted = sent
      .filter((s) => s.method === 'editMessageText')
      .map((s) => s.body.text as string)
      .filter((t) => t.startsWith('('));
    expect(noted).toEqual([
      '(Finance Advisor answered this one; you are still talking to Concierge.)\n\nyou have $12 left',
    ]);
  });

  it('adds no note when the finance advisor is already active', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'you have $12 left'));
    await surface.processUpdates([message(234, OWNER, OWNER, '/status')]);
    await surface.drain();
    expect(sent.find((s) => s.method === 'editMessageText')?.body.text).toBe('you have $12 left');
  });
});

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

describe('attachment helpers', () => {
  it('picks the largest photo size Telegram offered', () => {
    const sizes = [
      { file_id: 'thumb', file_size: 1_200, width: 90 },
      { file_id: 'full', file_size: 480_000, width: 1280 },
      { file_id: 'mid', file_size: 40_000, width: 320 },
    ];
    expect(largestPhoto(sizes)?.file_id).toBe('full');
    expect(largestPhoto([])).toBeUndefined();
    expect(largestPhoto(undefined)).toBeUndefined();
  });

  it('classifies the mimes the surface actually receives', () => {
    expect(classifyMime('image/jpeg')).toBe('image');
    expect(classifyMime('application/pdf')).toBe('document');
    expect(classifyMime('audio/ogg')).toBe('audio');
    expect(classifyMime('text/csv')).toBe('other');
  });

  it('says sizes the way a person would', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(120_000)).toBe('117 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
  });

  it('recognizes a sentence that points at the last file, and one that does not', () => {
    expect(referencesAttachment('import this statement into PNC Spend')).toBe(true);
    expect(referencesAttachment('what is that receipt?')).toBe(true);
    expect(referencesAttachment('file it under groceries')).toBe(true); // "it"
    expect(referencesAttachment('how much did I spend on groceries?')).toBe(false);
  });
});

describe('TelegramSurface attachment ingest', () => {
  it('downloads a captioned document, saves it, and runs with it attached', async () => {
    const db = alreadyGreeted(withOwner(new FakeDb()));
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'imported 42 rows'), {
      artifacts: store.store,
      files: { 'file-1': { path: 'documents/statement.pdf', bytes: '%PDF-1.7 rows' } },
    });

    await surface.processUpdates([
      documentUpdate(
        400,
        { file_id: 'file-1', file_name: 'sept.pdf', mime_type: 'application/pdf', file_size: 13 },
        'import this into PNC Spend',
      ),
    ]);
    await surface.drain();

    const methods = sent.map((s) => s.method);
    expect(methods).toContain('getFile');
    expect(methods).toContain('downloadFile');
    expect(sent.find((s) => s.method === 'getFile')?.body.file_id).toBe('file-1');

    // Saved with the surface provenance and the caption, by the owner.
    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0] as SaveArtifactInput;
    expect(saved.mime).toBe('application/pdf');
    expect(saved.filename).toBe('sept.pdf');
    expect(saved.createdBy).toBe('owner');
    expect(saved.caption).toBe('import this into PNC Spend');
    expect(saved.source).toEqual({ surface: SURFACE, chatId: String(OWNER), messageId: '400' });
    expect(saved.bytes.toString('latin1')).toBe('%PDF-1.7 rows');

    // The run gets the caption as the message, the artifact as an attachment,
    // and a note naming the id so the agent can reach the bytes by tool.
    expect(run).toHaveBeenCalledTimes(1);
    const req = run.mock.calls[0]?.[0] as any;
    expect(req.text.startsWith('import this into PNC Spend')).toBe(true);
    expect(req.text).toContain('artifact id art-1');
    expect(req.attachments).toEqual([
      { artifactId: 'art-1', mime: 'application/pdf', kind: 'document' },
    ]);

    // And the bubble says what it is doing.
    expect(sent.find((s) => s.method === 'sendMessage')?.body.text).toBe(
      readingText(handleLabel(FINANCE.handle)),
    );
    expect(sent.at(-1)?.body.text).toBe('imported 42 rows');
  });

  it('takes the largest size of a photo and attaches it as an image', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'that is a receipt'), {
      artifacts: store.store,
      files: { full: { path: 'photos/full.jpg', bytes: 'JPEGBYTES' } },
    });

    await surface.processUpdates([
      photoUpdate(
        401,
        [
          { file_id: 'thumb', file_size: 900, width: 90 },
          { file_id: 'full', file_size: 9, width: 1280 },
        ],
        'what is this?',
      ),
    ]);
    await surface.drain();

    expect(sent.find((s) => s.method === 'getFile')?.body.file_id).toBe('full');
    expect((store.saved[0] as SaveArtifactInput).mime).toBe('image/jpeg');
    expect((run.mock.calls[0]?.[0] as any).attachments).toEqual([
      { artifactId: 'art-1', mime: 'image/jpeg', kind: 'image' },
    ]);
  });

  it('answers a file with no caption directly, starts no run, and remembers it', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'never'), {
      artifacts: store.store,
      files: { 'file-2': { bytes: '%PDF' } },
    });

    await surface.processUpdates([
      documentUpdate(402, {
        file_id: 'file-2',
        file_name: 'chase.pdf',
        mime_type: 'application/pdf',
      }),
    ]);
    await surface.drain();

    expect(run).not.toHaveBeenCalled();
    const texts = sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text as string);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Got chase.pdf (document, 4 B)');
    expect(texts[0]).toContain("import this statement into PNC Spend");

    expect(db.lastAttachment.get(String(OWNER))?.artifact_id).toBe('art-1');
    expect(db.attachments.map((a) => a.filename)).toEqual(['chase.pdf']);
  });

  it('attaches the remembered file to a follow-up that points at it', async () => {
    const db = withOwner(new FakeDb());
    let clock = 1_700_000_000_000;
    db.clock = () => clock;
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'imported'), {
      artifacts: store.store,
      files: { 'file-3': { bytes: '%PDF' } },
      now: () => clock,
    });

    await surface.processUpdates([
      documentUpdate(403, {
        file_id: 'file-3',
        file_name: 'sept.pdf',
        mime_type: 'application/pdf',
      }),
    ]);
    await surface.drain();

    clock += 5 * 60_000; // five minutes later
    await surface.processUpdates([message(404, OWNER, OWNER, 'import this statement into PNC Spend')]);
    await surface.drain();

    expect(run).toHaveBeenCalledTimes(1);
    const req = run.mock.calls[0]?.[0] as any;
    expect(req.text.startsWith('import this statement into PNC Spend')).toBe(true);
    expect(req.text).toContain('artifact id art-1');
    expect(req.attachments).toEqual([
      { artifactId: 'art-1', mime: 'application/pdf', kind: 'document' },
    ]);
    expect(sent.filter((s) => s.body.text === readingText(handleLabel(FINANCE.handle)))).toHaveLength(1);
  });

  it('lets the file go once the window has passed, and ignores unrelated questions', async () => {
    const db = withOwner(new FakeDb());
    let clock = 1_700_000_000_000;
    db.clock = () => clock;
    const { surface, run } = surfaceWith(db, vi.fn(async () => 'ok'), {
      files: { 'file-4': { bytes: '%PDF' } },
      now: () => clock,
    });

    await surface.processUpdates([
      documentUpdate(405, { file_id: 'file-4', file_name: 'old.pdf', mime_type: 'application/pdf' }),
    ]);
    await surface.drain();

    // An unrelated question five minutes later carries nothing…
    clock += 5 * 60_000;
    await surface.processUpdates([message(406, OWNER, OWNER, 'how much rent is due?')]);
    await surface.drain();
    expect((run.mock.calls[0]?.[0] as any).attachments).toBeUndefined();

    // …and neither does a pointing one, forty minutes on.
    clock += 40 * 60_000;
    await surface.processUpdates([message(407, OWNER, OWNER, 'import this statement')]);
    await surface.drain();
    expect((run.mock.calls[1]?.[0] as any).attachments).toBeUndefined();
  });

  it('saves a CSV without attaching it, naming the artifact id instead', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, run } = surfaceWith(db, vi.fn(async () => 'imported'), {
      artifacts: store.store,
      files: { 'file-5': { bytes: 'date,amount\n' } },
    });

    await surface.processUpdates([
      documentUpdate(
        408,
        { file_id: 'file-5', file_name: 'txns.csv', mime_type: 'text/csv' },
        'import this',
      ),
    ]);
    await surface.drain();

    const req = run.mock.calls[0]?.[0] as any;
    expect(req.attachments).toBeUndefined();
    expect(req.text).toContain('artifact id art-1');
    expect(req.text).toContain('artifacts tools');
  });

  it('stores a voice note, says it cannot listen, and runs nothing', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'never'), {
      artifacts: store.store,
      files: { 'voice-1': { bytes: 'OGG' } },
    });

    await surface.processUpdates([
      {
        update_id: 409,
        message: {
          message_id: 409,
          from: { id: OWNER, is_bot: false },
          chat: { id: OWNER, type: 'private' },
          voice: { file_id: 'voice-1', file_unique_id: 'u1', mime_type: 'audio/ogg' },
          caption: 'listen to this',
        },
      },
    ]);
    await surface.drain();

    expect(run).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(1);
    const text = sent.filter((s) => s.method === 'sendMessage').at(-1)?.body.text as string;
    expect(text).toContain("I can't listen to audio yet");
    expect(db.attachments[0]?.kind).toBe('audio');
  });

  it('ignores a stranger’s file entirely and records surface.rejected', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'never'), {
      artifacts: store.store,
      files: { 'file-x': { bytes: '%PDF' } },
    });

    await surface.processUpdates([
      documentUpdate(
        410,
        { file_id: 'file-x', file_name: 'payload.pdf', mime_type: 'application/pdf' },
        'read this',
        9999,
      ),
    ]);
    await surface.drain();

    expect(run).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(sent.filter((s) => s.method === 'getFile')).toHaveLength(0);
    expect(db.events[0]?.kind).toBe('surface.rejected');
    expect(db.events[0]?.payload).toMatchObject({ reason: 'unpaired', updateId: '410' });
  });

  it('refuses a file over Telegram’s limit before downloading it', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'never'), {
      artifacts: store.store,
    });

    const huge = MAX_ATTACHMENT_BYTES + 1;
    await surface.processUpdates([
      documentUpdate(411, {
        file_id: 'file-big',
        file_name: 'year.pdf',
        mime_type: 'application/pdf',
        file_size: huge,
      }),
    ]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'getFile')).toHaveLength(0);
    expect(sent.filter((s) => s.method === 'downloadFile')).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    expect(sent.at(-1)?.body.text).toBe(oversizeText('year.pdf', huge));
  });

  it('refuses a file Telegram only admits is oversize at getFile', async () => {
    const db = withOwner(new FakeDb());
    const store = fakeStore();
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'never'), {
      artifacts: store.store,
      files: { 'file-6': { size: MAX_ATTACHMENT_BYTES + 10, bytes: '%PDF' } },
    });

    await surface.processUpdates([
      documentUpdate(412, { file_id: 'file-6', file_name: 'big.pdf', mime_type: 'application/pdf' }),
    ]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'downloadFile')).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
    expect(sent.at(-1)?.body.text).toContain('big.pdf is');
  });
});

describe('TelegramSurface /files', () => {
  it('says so plainly when the chat has sent nothing', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(420, OWNER, OWNER, '/files')]);
    await surface.drain();
    expect(run).not.toHaveBeenCalled();
    expect(sent.at(-1)?.body.text).toBe(NO_FILES_TEXT);
  });

  it('lists the last ten files, newest first, with kind, date and id', async () => {
    const db = withOwner(new FakeDb());
    let clock = Date.parse('2026-09-13T10:00:00Z');
    db.clock = () => clock;
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'ok'), {
      files: Object.fromEntries(
        Array.from({ length: 12 }, (_, n) => [`f-${n}`, { bytes: '%PDF' }]),
      ),
    });

    for (let n = 0; n < 12; n += 1) {
      clock += 60_000;
      await surface.processUpdates([
        documentUpdate(430 + n, {
          file_id: `f-${n}`,
          file_name: `statement-${n}.pdf`,
          mime_type: 'application/pdf',
        }),
      ]);
      await surface.drain();
    }

    await surface.processUpdates([message(500, OWNER, OWNER, '/files')]);
    await surface.drain();

    const text = sent.at(-1)?.body.text as string;
    expect(text.startsWith('Files in this chat:')).toBe(true);
    // Ten of twelve, newest first.
    expect(text.split('•')).toHaveLength(11);
    expect(text).toContain('statement-11.pdf — document, 4 B, 2026-09-13');
    expect(text).toContain('art-12');
    expect(text).not.toContain('statement-1.pdf —');
  });

  it('renders one row per file from the rows alone', () => {
    const rows = [
      {
        artifactId: 'art-9',
        filename: 'receipt.jpg',
        kind: 'image',
        mime: 'image/jpeg',
        sizeBytes: 120_000,
        createdAt: new Date('2026-09-12T08:00:00Z'),
      },
    ];
    expect(filesText(rows, 'UTC')).toBe(
      ['Files in this chat:', '• receipt.jpg — image, 117 KB, 2026-09-12', '  art-9'].join('\n'),
    );
    expect(filesText([], 'UTC')).toBe(NO_FILES_TEXT);
  });

  it('dates a file by the owner day, not the UTC day', () => {
    const rows = [
      {
        artifactId: 'art-10',
        filename: 'statement.pdf',
        kind: 'document',
        mime: 'application/pdf',
        sizeBytes: 1_000,
        // 00:30 UTC on the 13th: still the evening of the 12th in New York.
        createdAt: new Date('2026-09-13T00:30:00Z'),
      },
    ];
    expect(filesText(rows, 'America/New_York')).toContain('2026-09-12');
    expect(filesText(rows, 'UTC')).toContain('2026-09-13');
  });
});

/* ------------------------------------------------------------------ *
 * @mention routing
 * ------------------------------------------------------------------ */

describe('parseMention', () => {
  it('reads a leading handle, with or without a separator', () => {
    expect(parseMention('@ledger can I afford a bike?')).toEqual({
      handle: 'ledger',
      rest: 'can I afford a bike?',
    });
    expect(parseMention('@ledger: can I afford a bike?')?.rest).toBe('can I afford a bike?');
    expect(parseMention('@ledger, can I afford a bike?')?.rest).toBe('can I afford a bike?');
    expect(parseMention('  @credo what now')).toEqual({ handle: 'credo', rest: 'what now' });
    expect(parseMention('@ledger')).toEqual({ handle: 'ledger', rest: '' });
  });

  it('is a prefix, never a word in the middle of a sentence', () => {
    expect(parseMention('ask @ledger about it')).toBeUndefined();
    expect(parseMention('mail me at a@b.com')).toBeUndefined();
    expect(parseMention('@ 1ledger hello')).toBeUndefined();
    expect(parseMention('no handle here')).toBeUndefined();
  });

  it('strips the bot own username first, wherever Telegram put it', () => {
    expect(stripBotMention('@buddi_agent_bot hello', 'buddi_agent_bot')).toBe('hello');
    expect(stripBotMention('@BUDDI_AGENT_BOT: hello', '@buddi_agent_bot')).toBe('hello');
    expect(stripBotMention('hello @buddi_agent_bot', 'buddi_agent_bot')).toBe(
      'hello @buddi_agent_bot',
    );
    expect(parseMention('@buddi_agent_bot @credo how is my score?', 'buddi_agent_bot')).toEqual({
      handle: 'credo',
      rest: 'how is my score?',
    });
  });
});

describe('handleLabel', () => {
  it('capitalizes the handle and drops a leading @', () => {
    expect(handleLabel('ledger')).toBe('Ledger');
    expect(handleLabel('@credo')).toBe('Credo');
    expect(handleLabel()).toBe('');
  });
});

describe('TelegramSurface @mention', () => {
  it('routes one message to the named agent without switching the chat', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([
      message(300, OWNER, OWNER, 'hello advisor'),
      message(301, OWNER, OWNER, '@buddi what can you do?'),
      message(302, OWNER, OWNER, 'and again'),
    ]);
    await surface.drain();

    const calls = run.mock.calls.map((c: any) => c[0]);
    expect(calls.map((c: any) => c.agent.id)).toEqual([
      'finance-advisor',
      'concierge',
      'finance-advisor',
    ]);
    // The address is not part of the question.
    expect(calls[1]?.text).toBe('what can you do?');
    // Each agent answered in its own conversation for this chat…
    expect(calls.map((c: any) => c.conversationId)).toEqual(['conv-1', 'conv-2', 'conv-1']);
    // …and the chat is still talking to whoever it was talking to.
    expect(db.activeAgents.get(String(OWNER))).toBeUndefined();
    expect(
      sent.some((s) => s.method === 'sendMessage' && s.body.text === CONCIERGE_PLACEHOLDER),
    ).toBe(true);
  });

  it('answers an unknown handle without running anything', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(303, OWNER, OWNER, '@nobody are you there?')]);
    await surface.drain();

    expect(run).not.toHaveBeenCalled();
    expect(sent.map((s) => s.body.text)).toContain(unknownHandleText('nobody'));
    expect(unknownHandleText('nobody')).toBe('No agent called "nobody". Send /agents.');
  });

  it('asks for the question when the message is only an address', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(304, OWNER, OWNER, '@buddi')]);
    await surface.drain();
    expect(run).not.toHaveBeenCalled();
    expect(sent.map((s) => s.body.text)).toContain(emptyMentionText('buddi'));
  });

  it('sees the handle through Telegram own mention of the bot', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db, undefined, { botUsername: 'buddi_agent_bot' });
    await surface.processUpdates([
      message(305, OWNER, OWNER, '@buddi_agent_bot @buddi what can you do?'),
      message(306, OWNER, OWNER, '@buddi_agent_bot how much is left?'),
    ]);
    await surface.drain();

    const calls = run.mock.calls.map((c: any) => c[0]);
    expect(calls.map((c: any) => c.agent.id)).toEqual(['concierge', 'finance-advisor']);
    expect(calls[0]?.text).toBe('what can you do?');
    // With no handle after it, the bot mention is simply removed.
    expect(calls[1]?.text).toBe('how much is left?');
  });

  it('/use takes a handle, with or without the @', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(307, OWNER, OWNER, '/use @buddi')]);
    await surface.drain();
    expect(db.activeAgents.get(String(OWNER))).toBe('concierge');

    await surface.processUpdates([message(308, OWNER, OWNER, '/use ledger')]);
    await surface.drain();
    expect(db.activeAgents.get(String(OWNER))).toBe('finance-advisor');
    expect(sent.at(-1)?.body.text).toBe('You are now talking to Finance Advisor.');
  });
});


/* ------------------------------------------------------------------ *
 * Pairing by one-time code
 * ------------------------------------------------------------------ */

describe('parseStartCode', () => {
  it('reads the code out of /start and nothing else', () => {
    expect(parseStartCode('/start ABCD2345')).toBe('ABCD2345');
    // Telegram addresses the bot by name in some clients.
    expect(parseStartCode('/start@buddibot ABCD2345')).toBe('ABCD2345');
    expect(parseStartCode('  /start abcd2345  ')).toBe('abcd2345');
  });

  it('is nothing for a plain /start, another command or prose', () => {
    expect(parseStartCode('/start')).toBeUndefined();
    expect(parseStartCode('/help')).toBeUndefined();
    expect(parseStartCode('start ABCD2345')).toBeUndefined();
    // Two arguments is not a code; it is someone poking at the parser.
    expect(parseStartCode('/start ABCD2345 EFGH')).toBeUndefined();
  });
});

describe('pairing codes (gateway)', () => {
  it('mints a code with the deep link that sends it back as /start', async () => {
    const db = new FakeDb();
    const invite = await createPairingCodeFor(db, 'buddibot', { ttlMinutes: 10 });
    expect(invite.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(invite.deepLink).toBe(`https://t.me/buddibot?start=${invite.code}`);
    expect(parseStartCode(`/start ${invite.code}`)).toBe(invite.code);
    expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The @ is how the owner writes a username, not part of the URL.
    expect(pairingDeepLink('@buddibot', 'X')).toBe('https://t.me/buddibot?start=X');
  });

  it('asks Telegram who the bot is when no username is given', async () => {
    const db = new FakeDb();
    const getMe = vi.fn(async () => ({ id: 1, username: 'buddibot' }));
    const invite = await createPairingCode(db, { api: { getMe } });
    expect(getMe).toHaveBeenCalled();
    expect(invite.deepLink).toBe(`https://t.me/buddibot?start=${invite.code}`);
  });
});

describe('TelegramSurface pairing', () => {
  /** A stranger: any user id that is not the paired owner. */
  const STRANGER = 5150;

  it('pairs an unpaired user who sends /start with a good code', async () => {
    const db = new FakeDb();
    const menu = vi.fn(async () => {});
    const { surface, sent, run } = surfaceWith(db, vi.fn(async () => 'reply'), {
      setChatMenu: menu,
    });
    const { code } = await createPairingCodeFor(db, 'buddibot');

    await surface.processUpdates([message(200, STRANGER, STRANGER, `/start ${code}`)]);
    await surface.drain();

    const replies = sent.filter((s) => s.method === 'sendMessage');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body.text).toBe(pairedText('Amen'));
    expect(db.events).toHaveLength(0);
    // The chat had no menu — a paired device must get one.
    expect(menu).toHaveBeenCalledWith(String(STRANGER), expect.objectContaining({ id: 'finance-advisor' }));

    const paired = db.identities.find((i) => i.external_user_id === String(STRANGER));
    expect(paired).toMatchObject({
      external_chat_id: String(STRANGER),
      label: '@someone',
      paired_via: 'code',
    });

    // And the device is now the owner for every message after it.
    await surface.processUpdates([message(201, STRANGER, STRANGER, 'hello')]);
    await surface.drain();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('says nothing at all to a bad code, and records why', async () => {
    const db = new FakeDb();
    const { surface, sent, run } = surfaceWith(db);

    await surface.processUpdates([message(210, STRANGER, STRANGER, '/start ZZZZZZZZ')]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    expect(db.identities).toHaveLength(0);
    expect(db.events[0]).toMatchObject({
      kind: 'surface.rejected',
      payload: { reason: 'bad-pairing-code', pairing: 'invalid', externalUserId: String(STRANGER) },
    });
  });

  it('spends a code once: the second device gets silence', async () => {
    const db = new FakeDb();
    const { surface, sent } = surfaceWith(db);
    const { code } = await createPairingCodeFor(db, 'buddibot');

    await surface.processUpdates([
      message(220, STRANGER, STRANGER, `/start ${code}`),
      message(221, 6161, 6161, `/start ${code}`),
    ]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(1);
    expect(db.identities.map((i) => i.external_user_id)).toEqual([String(STRANGER)]);
    expect(db.events[0]?.payload).toMatchObject({ reason: 'bad-pairing-code', pairing: 'used' });
  });

  it('refuses a code that has expired', async () => {
    const db = new FakeDb();
    let at = Date.parse('2026-09-13T12:00:00Z');
    db.clock = () => at;
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'reply'), { now: () => at });
    const { code } = await createPairingCodeFor(db, 'buddibot', { ttlMinutes: 10 });

    at += 11 * 60_000;
    await surface.processUpdates([message(230, STRANGER, STRANGER, `/start ${code}`)]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(db.events[0]?.payload).toMatchObject({ pairing: 'expired' });
  });

  it('allows five attempts an hour per user id, then stops trying', async () => {
    const db = new FakeDb();
    let at = Date.parse('2026-09-13T12:00:00Z');
    db.clock = () => at;
    const { surface } = surfaceWith(db, vi.fn(async () => 'reply'), { now: () => at });

    for (let i = 0; i < PAIRING_MAX_ATTEMPTS + 1; i += 1) {
      await surface.processUpdates([message(300 + i, STRANGER, STRANGER, '/start WRONGONE')]);
      at += 1000;
    }
    await surface.drain();

    const reasons = db.events.map((e) => e.payload.reason);
    expect(reasons).toEqual([
      ...Array(PAIRING_MAX_ATTEMPTS).fill('bad-pairing-code'),
      'pairing-rate-limited',
    ]);

    // A real code presented while limited is not even read — and so not spent.
    const blocked = await createPairingCodeFor(db, 'buddibot');
    await surface.processUpdates([message(400, STRANGER, STRANGER, `/start ${blocked.code}`)]);
    await surface.drain();
    expect(db.identities).toHaveLength(0);
    expect(db.pairingCodes.get(blocked.code)?.usedAt).toBeNull();

    // …and an hour later the budget is back.
    at += 60 * 60 * 1000;
    const fresh = await createPairingCodeFor(db, 'buddibot');
    await surface.processUpdates([message(401, STRANGER, STRANGER, `/start ${fresh.code}`)]);
    await surface.drain();
    expect(db.identities.map((i) => i.external_user_id)).toEqual([String(STRANGER)]);
  });

  it('leaves a paired user the plain welcome for /start with a code', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    const { code } = await createPairingCodeFor(db, 'buddibot');

    await surface.processUpdates([message(240, OWNER, OWNER, `/start ${code}`)]);
    await surface.drain();

    expect(sent.find((s) => s.method === 'sendMessage')?.body.text).toBe(HELP);
    // The code was not spent by someone who did not need it.
    expect(db.pairingCodes.get(code)?.usedAt).toBeNull();
  });
});

describe('TelegramSurface last seen', () => {
  it('writes last_seen_at once, then again only after five minutes', async () => {
    const db = withOwner(new FakeDb());
    let at = Date.parse('2026-09-13T12:00:00Z');
    db.clock = () => at;
    const { surface } = surfaceWith(db, vi.fn(async () => 'reply'), { now: () => at });
    const device = () => db.identities[0]?.last_seen_at ?? null;

    await surface.processUpdates([message(500, OWNER, OWNER, 'hello')]);
    await surface.drain();
    expect(device()).toEqual(new Date(at));

    // A minute later: still the same write, not a new one per message.
    const first = device();
    at += 60_000;
    await surface.processUpdates([message(501, OWNER, OWNER, 'again')]);
    await surface.drain();
    expect(device()).toEqual(first);

    at += 5 * 60_000;
    await surface.processUpdates([message(502, OWNER, OWNER, 'and again')]);
    await surface.drain();
    expect(device()).toEqual(new Date(at));
  });

  it('names a device paired without a label, and never renames one that has a name', async () => {
    const db = withOwner(new FakeDb());
    const { surface } = surfaceWith(db);

    // Paired from the environment allowlist: an id and nothing else. The first
    // message it sends is where its name honestly comes from.
    expect(db.identities[0]?.label ?? null).toBeNull();
    await surface.processUpdates([message(520, OWNER, OWNER, 'hello')]);
    await surface.drain();
    expect(db.identities[0]?.label).toBe('@someone');

    // A name the owner chose stays theirs, whatever Telegram now reports.
    (db.identities[0] as { label?: string | null }).label = "Amen's phone";
    const later = new FakeDb();
    later.identities = db.identities;
    const second = surfaceWith(later).surface;
    await second.processUpdates([message(521, OWNER, OWNER, 'again')]);
    await second.drain();
    expect(db.identities[0]?.label).toBe("Amen's phone");
  });

  it('takes the @username, else the first name, else no label at all', () => {
    expect(senderLabel({ username: 'TheRealAmenophis', first_name: 'Amen' })).toBe(
      '@TheRealAmenophis',
    );
    expect(senderLabel({ username: '@already' })).toBe('@already');
    expect(senderLabel({ first_name: 'Amen' })).toBe('Amen');
    expect(senderLabel({ username: '  ', first_name: '  ' })).toBeNull();
    expect(senderLabel(undefined)).toBeNull();
  });

  it('answers the owner even when last_seen_at cannot be written', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    const real = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.replace(/\s+/g, ' ').trim().startsWith('update core.surface_identities set last_seen_at')) {
        throw new Error('db hiccup');
      }
      return real(sql, params);
    });

    await surface.processUpdates([message(510, OWNER, OWNER, 'hello')]);
    await surface.drain();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('devices', () => {
  it('lists a device with its label, pairing date and last seen', () => {
    const text = devicesText(
      [
        {
          id: 'dev-1',
          surface: 'telegram',
          externalUserId: '4242',
          label: '@amen',
          pairedAt: new Date('2026-09-10T15:00:00Z'),
          lastSeenAt: new Date('2026-09-13T15:00:00Z'),
        },
        {
          id: 'dev-2',
          surface: 'telegram',
          externalUserId: '99',
          label: null,
          pairedAt: new Date('2026-09-12T15:00:00Z'),
          lastSeenAt: null,
        },
      ],
      'America/New_York',
    );
    expect(text).toContain('• @amen (telegram) — paired 2026-09-10, last seen 2026-09-13');
    // No label: the numeric id is the honest name.
    expect(text).toContain('• 99 (telegram) — paired 2026-09-12, last seen never');
    expect(text).toContain('dev-1');
    // Unpairing stays on the machine that hosts buddi, and the text says so.
    expect(text).toContain('buddi telegram unpair <id>');
  });

  it('says so plainly when nothing is paired', () => {
    expect(devicesText([], 'America/New_York')).toBe(NO_DEVICES_TEXT);
  });

  it('answers /devices from the chat, and names every surface', async () => {
    const db = new FakeDb();
    db.identities.push({
      id: 'dev-9',
      owner_id: 'owner',
      surface: SURFACE,
      external_user_id: String(OWNER),
      external_chat_id: String(OWNER),
      label: 'Phone',
      paired_at: new Date('2026-09-01T12:00:00Z'),
      last_seen_at: null,
      paired_via: 'env',
    });
    const { surface, sent } = surfaceWith(db);

    await surface.processUpdates([message(600, OWNER, OWNER, '/devices')]);
    await surface.drain();

    const text = sent.find((s) => s.method === 'sendMessage')?.body.text as string;
    expect(text).toContain('Paired devices:');
    expect(text).toContain('Phone (telegram)');
    expect(text).toContain('dev-9');
    expect(HELP).toContain('/devices');
  });

  it('lists devices and unpairs one, after which its messages are ignored', async () => {
    const db = new FakeDb();
    const { surface, sent, run } = surfaceWith(db);
    const { code } = await createPairingCodeFor(db, 'buddibot');
    await surface.processUpdates([message(700, OWNER, OWNER, `/start ${code}`)]);
    await surface.drain();

    const devices = await listDevices(db);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      surface: SURFACE,
      externalUserId: String(OWNER),
      externalChatId: String(OWNER),
      label: '@someone',
      lastSeenAt: null,
    });
    expect(devices[0]?.pairedAt).toBeInstanceOf(Date);

    expect(await unpairDevice(db, devices[0]?.id as string)).toBe(true);
    // Revocation needs no restart: authorization is read per message.
    const before = sent.length;
    await surface.processUpdates([message(701, OWNER, OWNER, 'still there?')]);
    await surface.drain();
    expect(sent.slice(before).filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    expect(db.events.at(-1)?.payload).toMatchObject({ reason: 'unpaired' });

    // An id that never existed is a fact, not an exception.
    expect(await unpairDevice(db, '00000000-0000-4000-8000-000000009999')).toBe(false);
    expect(await unpairDevice(db, 'nonsense')).toBe(false);
  });
});

/* ---------------- approvals routing ---------------- */

describe('approvals on the surface', () => {
  const pairedDb = (): FakeDb => {
    const db = new FakeDb();
    db.identities.push({
      owner_id: 'owner',
      surface: SURFACE,
      external_user_id: String(OWNER),
      external_chat_id: String(OWNER),
    });
    return db;
  };

  const callbackUpdate = (data: string, fromId = OWNER): TelegramUpdate => ({
    update_id: 700,
    callback_query: {
      id: 'cb-1',
      from: { id: fromId },
      data,
      message: { message_id: 42, chat: { id: OWNER, type: 'private' } },
    },
  });

  it('hands a callback_query to the approval machinery, unchanged', async () => {
    const db = pairedDb();
    const handleCallback = vi.fn(async () => {});
    const approvals: ApprovalHooks = { handleCallback, pending: async () => 'none' };
    const { surface } = surfaceWith(db, vi.fn(async () => 'reply'), { approvals });

    const update = callbackUpdate('apr:33333333-3333-3333-3333-333333333333:approve');
    await surface.processUpdates([update]);
    await surface.drain();

    expect(handleCallback).toHaveBeenCalledTimes(1);
    expect(handleCallback.mock.calls[0]?.[0]).toEqual(update.callback_query);
  });

  it('ignores a callback when no approval machinery is wired', async () => {
    const db = pairedDb();
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([callbackUpdate('apr:x:approve')]);
    await surface.drain();
    expect(sent.filter((c) => c.method === 'sendMessage')).toEqual([]);
  });

  it('answers /approvals from the machinery, and says so plainly without it', async () => {
    const db = pairedDb();
    const approvals: ApprovalHooks = {
      handleCallback: async () => {},
      pending: async () => 'Waiting for you:\n• mail.send',
    };
    const withHooks = surfaceWith(db, vi.fn(async () => 'reply'), { approvals });
    await withHooks.surface.dispatch(message(701, OWNER, OWNER, '/approvals'));
    await withHooks.surface.drain();
    expect(withHooks.sent.at(-1)?.body.text).toContain('mail.send');

    const without = surfaceWith(pairedDb());
    await without.surface.dispatch(message(702, OWNER, OWNER, '/approvals'));
    await without.surface.drain();
    expect(without.sent.at(-1)?.body.text).toBe(APPROVALS_UNAVAILABLE_TEXT);
  });
});

/* ---------------- the first run ---------------- */

/** The last thing the owner actually read, however it reached the chat. */
function lastText(sent: { method: string; body: any }[]): string {
  const said = sent.filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText');
  return String(said.at(-1)?.body?.text ?? '');
}

/** Every message the owner read, in order. */
function allTexts(sent: { method: string; body: any }[]): string[] {
  return sent
    .filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText')
    .map((s) => String(s.body?.text ?? ''));
}

describe('splitIntoMessages', () => {
  it('sends one paragraph as one message', () => {
    expect(splitIntoMessages('just the one line')).toEqual(['just the one line']);
  });

  it('sends two and three paragraphs as that many messages', () => {
    expect(splitIntoMessages('one\n\ntwo')).toEqual(['one', 'two']);
    expect(splitIntoMessages('one\n\ntwo\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('sends four or more as a single message rather than a burst plus a blob', () => {
    const four = 'one\n\ntwo\n\nthree\n\nfour';
    expect(splitIntoMessages(four)).toEqual([four]);
    expect(MAX_BURST_MESSAGES).toBe(3);
  });

  it('never breaks a long single paragraph, however long it is', () => {
    const long = 'word '.repeat(400).trim();
    expect(splitIntoMessages(long)).toEqual([long]);
  });

  it('is empty for an empty answer, and trims what it keeps', () => {
    expect(splitIntoMessages('   \n\n  ')).toEqual([]);
    expect(splitIntoMessages('  one  \n\n  two  ')).toEqual(['one', 'two']);
  });
});

describe('first contact', () => {
  const burst = { burstGapMs: 0 };

  it('runs the default agent with the first-run instruction, not a canned script', async () => {
    const db = pendingOnboarding(withOwner(new FakeDb()));
    const run = vi.fn(async () => 'Hi — I am the agent that runs on this machine.');
    const { surface, sent } = surfaceWith(db, run, burst);

    await surface.processUpdates([message(1, OWNER, OWNER, '/start')]);
    await surface.drain();

    expect(run).toHaveBeenCalledTimes(1);
    const req = run.mock.calls[0]?.[0] as any;
    expect(req.agent.id).toBe(fakeCatalog().defaultAgent().id);
    expect(req.systemSuffix).toContain('first run');
    // Every word the owner reads came from the agent.
    expect(allTexts(sent)).toEqual(['Hi — I am the agent that runs on this machine.']);
  });

  it('answers the owner\'s own first question instead of a hello', async () => {
    const db = pendingOnboarding(withOwner(new FakeDb()));
    const run = vi.fn(async () => 'reply');
    const { surface } = surfaceWith(db, run, burst);

    await surface.processUpdates([message(1, OWNER, OWNER, 'what is this?')]);
    await surface.drain();

    expect((run.mock.calls[0]?.[0] as any).text).toBe('what is this?');
  });

  it('breaks the answer into messages with the typing indicator between them', async () => {
    const db = pendingOnboarding(withOwner(new FakeDb()));
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'one\n\ntwo\n\nthree'), burst);

    await surface.processUpdates([message(1, OWNER, OWNER, '/start')]);
    await surface.drain();

    expect(allTexts(sent)).toEqual(['one', 'two', 'three']);
    // No progress bubble: the machine is speaking first, not working on a question.
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false);
    const typing = sent.filter((s) => s.method === 'sendChatAction').length;
    expect(typing).toBeGreaterThanOrEqual(3);
    expect(BURST_GAP_MS).toBeGreaterThan(0);
  });

  it('happens once and never again', async () => {
    const db = pendingOnboarding(withOwner(new FakeDb()));
    const run = vi.fn(async () => 'hello');
    const { surface } = surfaceWith(db, run, burst);

    await surface.processUpdates([message(1, OWNER, OWNER, '/start')]);
    await surface.drain();
    await surface.processUpdates([message(2, OWNER, OWNER, 'and now a question')]);
    await surface.drain();

    expect(run).toHaveBeenCalledTimes(2);
    // The second turn is an ordinary one: no instruction, and the bubble is back.
    expect((run.mock.calls[1]?.[0] as any).systemSuffix).toBeUndefined();
  });

  it('never starts once another surface has claimed it', async () => {
    const db = pendingOnboarding(withOwner(new FakeDb()));
    // `buddi chat` got there first: the row is already in-progress.
    db.onboarding = {
      state: 'in-progress',
      started_at: new Date(0),
      completed_at: null,
      surface: 'cli',
      steps_done: [],
      nudges_sent: 0,
      last_nudge_at: null,
      unanswered: 0,
      quiet_until: null,
      updated_at: new Date(0),
    };
    const run = vi.fn(async () => 'reply');
    const { surface } = surfaceWith(db, run, burst);

    await surface.processUpdates([message(1, OWNER, OWNER, 'hi')]);
    await surface.drain();

    expect((run.mock.calls[0]?.[0] as any).systemSuffix).toBeUndefined();
    expect(db.onboarding?.surface).toBe('cli');
  });

  it('leaves an installation that was already talking completely alone', async () => {
    const db = withOwner(new FakeDb()); // onboarding: done
    const run = vi.fn(async () => 'reply');
    const { surface, sent } = surfaceWith(db, run, burst);

    await surface.processUpdates([message(1, OWNER, OWNER, 'hi')]);
    await surface.drain();

    expect((run.mock.calls[0]?.[0] as any).systemSuffix).toBeUndefined();
    expect(lastText(sent)).toBe('reply');
  });

  it('does not spend it on a command the owner deliberately typed', async () => {
    const db = pendingOnboarding(withOwner(new FakeDb()));
    const run = vi.fn(async () => 'hello');
    const { surface, sent } = surfaceWith(db, run, burst);

    await surface.processUpdates([message(1, OWNER, OWNER, '/help')]);
    await surface.drain();
    expect(lastText(sent)).toBe(HELP);
    expect(run).not.toHaveBeenCalled();

    await surface.processUpdates([message(2, OWNER, OWNER, 'now a real question')]);
    await surface.drain();
    expect((run.mock.calls[0]?.[0] as any).systemSuffix).toContain('first run');
  });
});
