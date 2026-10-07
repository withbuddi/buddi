import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ViewDescriptor } from '@buddi/core';
import { deliverLeadingMedia, holdsTextForMedia, leadingMediaOf, mediaFirstViews } from './leading-media.js';

const views = mediaFirstViews([
  { tool: 'demo.read', renderer: 'story', map: {}, messenger: { mediaFirst: true } },
  { tool: 'demo.saved', renderer: 'structured', map: {}, messenger: { mediaFirst: true, when: { path: 'play', equals: true } } },
  { tool: 'demo.plain', renderer: 'structured', map: {} },
] as ViewDescriptor[]);
const pluginOf = (tool: string) => tool.split('.')[0];

describe('media a tool result leads with on Telegram (host API 1.33)', () => {
  it('holds the text back only for tools whose view declares it, and only when its condition holds', () => {
    expect(holdsTextForMedia(views, 'demo.read', {})).toBe(true);
    expect(holdsTextForMedia(views, 'demo.saved', { play: true })).toBe(true);
    expect(holdsTextForMedia(views, 'demo.saved', { play: false })).toBe(false);
    expect(holdsTextForMedia(views, 'demo.plain', {})).toBe(false);
    expect(holdsTextForMedia(views, 'other.read', {})).toBe(false);
  });

  it('reads attachments only from declared tools, for the tool’s own plugin', () => {
    const output = { attachments: [{ kind: 'image', asset: 'pic' }, { kind: 'audio', report: '#/p/other/x' }] };
    expect(leadingMediaOf(views, pluginOf, 'demo.read', output)).toEqual({ plugin: 'demo', attachments: [{ kind: 'image', asset: 'pic' }] });
    expect(leadingMediaOf(views, pluginOf, 'demo.plain', output)).toBeNull();
    expect(leadingMediaOf(views, () => undefined, 'demo.read', output)).toBeNull();
    expect(leadingMediaOf(views, pluginOf, 'demo.read', { attachments: [] })).toBeNull();
  });

  it('sends the plugin’s own cached image with its caption, and never another plugin’s', async () => {
    const sendPhoto = vi.fn(async () => 42);
    const read = vi.fn(async () => Buffer.from('png'));
    const sent = await deliverLeadingMedia({ api: { sendPhoto }, pool: {} as Pool, env: {}, log: () => {}, read }, 'owner', { plugin: 'demo', attachments: [{ kind: 'image', asset: 'pic', caption: 'Headline\nCredit · Outlet' }] });
    expect(sent).toEqual({ photoSent: true, audio: [] });
    expect(read).toHaveBeenCalledWith('demo', 'pic', 768, {});
    expect(sendPhoto).toHaveBeenCalledWith('owner', Buffer.from('png'), expect.objectContaining({ contentType: 'image/png', caption: 'Headline\nCredit · Outlet' }));
  });

  it('skips a missing image and resolves a report’s recording', async () => {
    const sendPhoto = vi.fn(async () => 42);
    const query = vi.fn(async (sql: string, _params?: unknown[]) => sql.includes('owner_notifications')
      ? { rows: [{ audio: 'rec-1' }] }
      : { rows: [{ id: 'rec-1', kind: 'file', mime: 'audio/ogg', filename: 'r.ogg', size_bytes: 3, sha256: 'x', storage_path: 'a', caption: null, created_at: new Date() }] });
    const sent = await deliverLeadingMedia(
      { api: { sendPhoto }, pool: { query } as unknown as Pool, env: {}, log: () => {}, read: vi.fn(async () => null) },
      'owner',
      { plugin: 'demo', attachments: [{ kind: 'image', asset: 'gone' }, { kind: 'audio', report: '#/p/demo/digest?saved=d_1' }] },
    );
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sent.photoSent).toBe(false);
    expect(query.mock.calls[0]?.[1]).toEqual(['#/p/demo/digest?saved=d_1']);
    expect(sent.audio).toEqual(['rec-1']);
  });

  it('keeps going when one attachment fails', async () => {
    const log = vi.fn();
    const sent = await deliverLeadingMedia(
      { api: { sendPhoto: vi.fn(async () => { throw new Error('too big'); }) }, pool: { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool, env: {}, log, read: vi.fn(async () => Buffer.from('x')) },
      'owner',
      { plugin: 'demo', attachments: [{ kind: 'image', asset: 'pic' }, { kind: 'audio', report: '#/p/demo/x' }] },
    );
    expect(sent).toEqual({ photoSent: false, audio: [] });
    expect(log).toHaveBeenCalled();
  });
});
