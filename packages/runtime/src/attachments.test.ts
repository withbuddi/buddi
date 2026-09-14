/**
 * Attachments through the loop: what is stored, what is sent, and what happens
 * when the file behind a reference is gone.
 */
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@buddi/core';
import type { AgentDefinition, PluginManifest, ToolContext } from '@buddi/core';
import { ATTACHMENT_UNAVAILABLE, type CompletionRequest, type CompletionResponse, type RuntimeProvider } from './anthropic.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  base64Bytes,
  hydrateContent,
  type LoadArtifact,
} from './attachments.js';
import { createConversation, runAgent, type Queryable } from './loop.js';

/* ---------------- in-memory fake DB (only `query`) ---------------- */

class FakeDb implements Queryable {
  conversations: { id: string; agent_id: string }[] = [];
  messages: { id: number; conversation_id: string; role: string; content: any }[] = [];
  events: { kind: string }[] = [];
  #seq = 0;

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
    }
    if (text.startsWith('insert into core.messages')) {
      this.messages.push({
        id: ++this.#seq,
        conversation_id: params[0],
        role: params[1],
        content: JSON.parse(params[2]),
      });
      return { rows: [] };
    }
    if (text.startsWith('select role, content from core.messages')) {
      return {
        rows: this.messages
          .filter((m) => m.conversation_id === params[0])
          .map((m) => ({ role: m.role, content: m.content })),
      };
    }
    if (text.startsWith('insert into core.events')) {
      this.events.push({ kind: params[0] });
      return { rows: [] };
    }
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

/* ---------------- fixtures ---------------- */

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  ownerId: 'owner-1',
  now: () => new Date('2026-09-13T00:00:00Z'),
  timezone: 'UTC',
};

const agent: AgentDefinition = {
  id: 'finance',
  name: 'Finance',
  systemPrompt: 'You advise on money.',
  tools: [],
  provider: {
    kind: 'anthropic',
    credential: { kind: 'api-key', env: 'ANTHROPIC_API_KEY' },
    model: 'claude-sonnet-5',
  },
  maxTurns: 3,
};

const emptyRegistry = (): ToolRegistry => {
  const r = new ToolRegistry();
  const manifest: PluginManifest = {
    name: 'none',
    version: '0.0.1',
    schema: 'none',
    migrationsDir: '',
    tools: [],
  };
  r.register(manifest);
  return r;
};

function scriptedProvider(): RuntimeProvider & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  const response: CompletionResponse = {
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'end_turn',
    usage: { input: 1, output: 1 },
    model: 'claude-sonnet-5',
  };
  return {
    calls,
    async complete(req) {
      calls.push(structuredClone(req));
      return response;
    },
  };
}

const PDF_B64 = Buffer.from('%PDF-1.4 fake').toString('base64');
const PNG_B64 = Buffer.from('fake png bytes').toString('base64');

const loader: LoadArtifact = async (id) => {
  if (id === 'pdf-1') return { mime: 'application/pdf', data: PDF_B64 };
  if (id === 'img-1') return { mime: 'image/png', data: PNG_B64 };
  return null;
};

/* ---------------- tests ---------------- */

describe('base64Bytes', () => {
  it('reports the decoded size without decoding', () => {
    for (const size of [1, 2, 3, 10, 1024]) {
      const data = Buffer.alloc(size, 7).toString('base64');
      expect(base64Bytes(data)).toBe(size);
    }
    expect(base64Bytes('')).toBe(0);
  });
});

describe('runAgent with attachments', () => {
  it('persists an artifact_ref and sends the hydrated bytes', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider();

    await runAgent({
      agent,
      provider,
      registry: emptyRegistry(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'what does this say?',
      attachments: [{ artifactId: 'pdf-1', mime: 'application/pdf', kind: 'document' }],
      loadArtifact: loader,
    });

    // Stored: the reference. No base64 anywhere in core.messages.
    const stored = db.messages.find((m) => m.role === 'user');
    expect(stored?.content).toEqual([
      { type: 'text', text: 'what does this say?' },
      { type: 'artifact_ref', artifactId: 'pdf-1', mime: 'application/pdf', kind: 'document' },
    ]);
    expect(JSON.stringify(db.messages)).not.toContain(PDF_B64);

    // Sent: the document block, with the bytes.
    expect(provider.calls[0]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'what does this say?' },
      { type: 'document', mime: 'application/pdf', data: PDF_B64 },
    ]);
  });

  it('rehydrates references when replaying history', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');

    await runAgent({
      agent,
      provider: scriptedProvider(),
      registry: emptyRegistry(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'here is a photo',
      attachments: [{ artifactId: 'img-1', mime: 'image/png', kind: 'image' }],
      loadArtifact: loader,
    });

    const provider = scriptedProvider();
    await runAgent({
      agent,
      provider,
      registry: emptyRegistry(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'and what about the colour?',
      loadArtifact: loader,
    });

    const replayed = provider.calls[0]?.messages[0];
    expect(replayed?.content).toEqual([
      { type: 'text', text: 'here is a photo' },
      { type: 'image', mime: 'image/png', data: PNG_B64 },
    ]);
  });

  it('shows a placeholder when the artifact is gone, and keeps going', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider();

    await runAgent({
      agent,
      provider,
      registry: emptyRegistry(),
      ctx,
      pool: db,
      conversationId,
      userMessage: 'read this',
      attachments: [{ artifactId: 'deleted', mime: 'application/pdf', kind: 'document' }],
      loadArtifact: loader,
    });

    const sent = provider.calls[0]?.messages.at(-1)?.content ?? [];
    expect(sent).toHaveLength(2);
    const placeholder = sent[1] as { type: string; text: string };
    expect(placeholder.type).toBe('text');
    expect(placeholder.text).toContain(ATTACHMENT_UNAVAILABLE);
    // The reference is still what was persisted — history stays honest.
    expect(db.messages[0]?.content[1].type).toBe('artifact_ref');
  });

  it('refuses more than the per-message attachment cap, before persisting anything', async () => {
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');
    const provider = scriptedProvider();
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => ({
      artifactId: 'pdf-1',
      mime: 'application/pdf',
      kind: 'document',
    }));

    await expect(
      runAgent({
        agent,
        provider,
        registry: emptyRegistry(),
        ctx,
        pool: db,
        conversationId,
        userMessage: 'all of these',
        attachments,
        loadArtifact: loader,
      }),
    ).rejects.toThrow(/too many attachments/);

    expect(db.messages).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses an oversized image rather than resizing it', async () => {
    const big = 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 1024) * 4) / 3));
    const bigLoader: LoadArtifact = async () => ({ mime: 'image/png', data: big });
    const db = new FakeDb();
    const conversationId = await createConversation(db, 'finance');

    await expect(
      runAgent({
        agent,
        provider: scriptedProvider(),
        registry: emptyRegistry(),
        ctx,
        pool: db,
        conversationId,
        userMessage: 'look',
        attachments: [{ artifactId: 'img-1', mime: 'image/png', kind: 'image' }],
        loadArtifact: bigLoader,
      }),
    ).rejects.toThrow(/over the 5.0 MiB limit/);
    expect(db.messages).toHaveLength(0);
  });
});

describe('hydrateContent', () => {
  it('leaves content without references untouched', async () => {
    const load = vi.fn();
    const content = [{ type: 'text' as const, text: 'hello' }];
    expect(await hydrateContent(content, load as unknown as LoadArtifact)).toEqual(content);
    expect(load).not.toHaveBeenCalled();
  });

  it('describes what it cannot send inline instead of pretending it did', async () => {
    const [block] = await hydrateContent(
      [{ type: 'artifact_ref', artifactId: 'a-1', mime: 'audio/ogg', kind: 'audio' }],
      loader,
    );
    expect(block).toMatchObject({ type: 'text' });
    expect((block as { text: string }).text).toContain(ATTACHMENT_UNAVAILABLE);
  });

  it('degrades on replay instead of throwing on an over-cap image', async () => {
    const big = 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 1024) * 4) / 3));
    const [block] = await hydrateContent(
      [{ type: 'artifact_ref', artifactId: 'img-1', mime: 'image/png', kind: 'image' }],
      async () => ({ mime: 'image/png', data: big }),
    );
    expect((block as { text: string }).text).toContain('too large');
  });
});
