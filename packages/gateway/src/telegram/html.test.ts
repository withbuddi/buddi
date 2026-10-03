import { describe, expect, it, vi } from 'vitest';
import { inlineHtml, markdownToTelegramHtml, ownerMessageHtml } from './html.js';
import { createTelegramChannel } from './channel.js';
import { notifyOwner } from './notify.js';
import { TelegramApiError } from './api.js';

const EDITION = `Seven stories. West African leaders meet in Lomé today; Congress kept the government open overnight.

### Togo & West Africa

**ECOWAS leaders open a two-day summit in Lomé**

Leaders from the fifteen member states open a two-day summit in Lomé today, with trade corridors & the regional currency on the agenda.

*RFI Afrique (fr) and 3 more* · [rfi.fr](https://www.rfi.fr/fr/afrique/20261003-cedeao?a=1&b=2)

**UPDATE · Ghana and Côte d'Ivoire raise the cocoa farm-gate price**

The higher farm-gate price you heard about last night takes effect on Monday.

*Reuters and 1 more* · [reuters.com](https://www.reuters.com/markets/cocoa)

— Anchor · next at 12:30`;

describe('a report’s Markdown as Telegram HTML', () => {
  it('turns a heading into a bold line, bold and italic into tags, and keeps the link on the outlet', () => {
    const [html, ...rest] = markdownToTelegramHtml(EDITION);
    expect(rest).toEqual([]);
    expect(html).toContain('<b>Togo &amp; West Africa</b>');
    expect(html).toContain('<b>ECOWAS leaders open a two-day summit in Lomé</b>');
    expect(html).toContain('<i>RFI Afrique (fr) and 3 more</i> · <a href="https://www.rfi.fr/fr/afrique/20261003-cedeao?a=1&amp;b=2">rfi.fr</a>');
    expect(html).toContain('<b>UPDATE · Ghana and Côte d\'Ivoire raise the cocoa farm-gate price</b>');
    expect(html).toContain('trade corridors &amp; the regional currency');
    expect(html).not.toMatch(/[*#]/);
    // Paragraphs stay apart, and nothing else is invented.
    expect(html.split('\n\n')).toHaveLength(9);
    expect(html.endsWith('— Anchor · next at 12:30')).toBe(true);
  });

  it('leaves a raw URL as it is, escapes markup, and leaves arithmetic and identifiers alone', () => {
    expect(inlineHtml('See https://example.com/a_b_c?x=1&y=2 now')).toBe('See https://example.com/a_b_c?x=1&amp;y=2 now');
    expect(inlineHtml('2 * 3 * 4 and snake_case_name <script>')).toBe('2 * 3 * 4 and snake_case_name &lt;script&gt;');
    expect(inlineHtml('`a <b>` and ~~old~~ and __bold__ and _it_')).toBe('<code>a &lt;b&gt;</code> and <s>old</s> and <b>bold</b> and <i>it</i>');
    // Only a web address becomes a link; anything else keeps its words.
    expect(inlineHtml('[open](javascript:alert(1))')).toBe('[open](javascript:alert(1))');
    expect(inlineHtml('[open](#/p/news)')).toBe('open');
    expect(inlineHtml('[a "quoted" one](https://x.org/"q")')).toBe('<a href="https://x.org/&quot;q&quot;">a "quoted" one</a>');
  });

  it('keeps single newlines as lines, draws bullets, tables and code', () => {
    const [html] = markdownToTelegramHtml('Today:\nfirst line\nsecond line\n\n- one\n- **two**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```');
    expect(html).toBe('Today:\nfirst line\nsecond line\n\n• one\n• <b>two</b>\n\na — b\n1 — 2\n\n<pre>x &lt; y</pre>');
  });

  it('splits under 4,096 at a paragraph, before a topic when one is in the second half, and never cuts a tag', () => {
    const story = (n: number): string =>
      `**Story ${n} headline that runs a little long**\n\n${'A sentence about it. '.repeat(8).trim()}\n\n*Outlet and 2 more* · [outlet.com](https://outlet.com/${n})`;
    const topics = Array.from({ length: 6 }, (_, t) => `### Topic ${t}\n\n${Array.from({ length: 5 }, (_, s) => story(t * 10 + s)).join('\n\n')}`);
    const parts = markdownToTelegramHtml(topics.join('\n\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      // Balanced: every tag that opens closes in the same message.
      for (const tag of ['b', 'i', 'a']) {
        expect((part.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length).toBe((part.match(new RegExp(`</${tag}>`, 'g')) ?? []).length);
      }
    }
    // Every message after the first starts at a topic.
    for (const part of parts.slice(1)) expect(part.startsWith('<b>Topic ')).toBe(true);
    // Nothing lost.
    expect(parts.join('\n\n').match(/Story \d+ headline/g)).toHaveLength(30);
  });

  it('cuts one block longer than a message between its lines', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} with **bold** words`).join('\n');
    const parts = markdownToTelegramHtml(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n').split('\n')).toHaveLength(400);
  });

  it('puts the title in bold above the text and the ask below it', () => {
    expect(ownerMessageHtml({ title: 'Morning edition · Sat 3 Oct', text: '### AI\n\n**A <b> title**', action: 'Look at it' })).toEqual([
      '<b>Morning edition · Sat 3 Oct</b>\n\n<b>AI</b>\n\n<b>A &lt;b&gt; title</b>\n\n→ Look at it',
    ]);
  });
});

describe('a report on Telegram, sent as HTML', () => {
  const pool = {
    async query(sql: string) {
      if (sql.includes('core.surface_identities')) {
        return { rows: [{ id: 'i1', owner_id: 'owner', surface: 'telegram', external_user_id: '7', external_chat_id: '42' }] };
      }
      return { rows: [] };
    },
  };

  it('hands the channel’s HTML to the sender for a report, and plain text only for an agent’s own message', async () => {
    const calls: Array<{ text: string; html?: readonly string[] }> = [];
    const channel = createTelegramChannel({ pool, env: {}, sendText: async (text, opts) => { calls.push({ text, ...(opts?.html ? { html: opts.html } : {}) }); return '42'; } });
    await channel.deliver({ id: 'r1', kind: 'recap', urgency: 'now', title: 'Morning edition · Sat 3 Oct', text: EDITION });
    await channel.deliver({ id: 'r2', kind: 'agent', urgency: 'now', title: '@anchor: **hi**' });
    expect(calls[0]!.text.startsWith('Morning edition · Sat 3 Oct\n\nSeven stories.')).toBe(true);
    expect(calls[0]!.html![0]).toMatch(/^<b>Morning edition · Sat 3 Oct<\/b>\n\nSeven stories\./);
    expect(calls[1]!.html).toBeUndefined();
  });

  it('sends each part with parse_mode HTML and the buttons under the last, and falls back to plain text when Telegram refuses the markup', async () => {
    const sent: Array<[string, Record<string, unknown>]> = [];
    const api = { sendMessage: vi.fn(async (_chat: string | number, text: string, opts: Record<string, unknown> = {}) => { sent.push([text, opts]); return 1; }) };
    const offers = [{ id: 'o1', label: 'Quiet news today', prompt: 'Quiet the news for today.', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] as never;
    await notifyOwner('Title\n\n**x**', { pool, api, html: ['<b>Title</b>', '<b>x</b>'], offers });
    expect(sent.map(([t, o]) => [t, o.parseMode, 'replyMarkup' in o])).toEqual([['<b>Title</b>', 'HTML', false], ['<b>x</b>', 'HTML', true]]);

    sent.length = 0;
    api.sendMessage.mockImplementationOnce(async () => { throw new TelegramApiError('sendMessage', 400, "Bad Request: can't parse entities"); });
    await notifyOwner('Title\n\n**x** and [site](https://a.org)', { pool, api, html: ['<b>Title</b>\n\n<b>x</b>'] });
    expect(sent).toEqual([['Title\n\nx and site (https://a.org)', {}]]);
  });
});
