/**
 * Telegram sees what the dashboard sees.
 *
 * Two things, and the rules that keep them honest:
 *
 *  - **A photo per browser step**, with a caption that says where the agent
 *    is, what it did, how far through the step budget it is and why it failed
 *    when it did — once per step, never twice for a page that did not change,
 *    and *never at all* for a screen the owner's own allow lists would not let
 *    the agent be on.
 *  - **A "Take over" button** under it, whose URL is the conversation's
 *    Browser tab on the dashboard: the configured public origin, or loopback
 *    with the sentence that says whose computer to open it on.
 *
 * And the four commands, which are the dashboard's own controls reachable from
 * the phone. No network and no database: a fake Bot API, a fake host
 * controller and an in-memory `Queryable`.
 */
import { roleProblemMessage, UnknownAgentError, type Queryable } from '@buddi/core';
import type { BrowserStatus } from '@buddi/tool-browser';
import { describe, expect, it, vi } from 'vitest';
import { TelegramApi, type FetchLike, type TelegramUpdate } from './api.js';
import {
  actionWords,
  BrowserPhotos,
  browserStatusText,
  LOOPBACK_CAPTION,
  parseBrowserCommand,
  runBrowserCommand,
  screenshotAllowed,
  stepCall,
  stepCaption,
  TAKE_OVER_LABEL,
} from './browser-view.js';
import { SURFACE, TelegramSurface } from './surface.js';
import { browserTabUrl } from '../web/config.js';
import type { AgentCatalog, CatalogAgent } from './types.js';

const OWNER_USER = '4242';
const OWNER_CHAT = '4242';
const AGENT = 'concierge';
const CONVERSATION = 'c-1';

/* ---------------- fakes ---------------- */

class FakeDb implements Queryable {
  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id')) {
      if (params[1] !== OWNER_USER) return { rows: [] };
      return { rows: [{ id: 'sid-1', owner_id: 'owner', surface: SURFACE, external_user_id: OWNER_USER, external_chat_id: OWNER_CHAT }] };
    }
    if (text.startsWith('insert into core.events')) return { rows: [] };
    if (text.startsWith('update core.surface_identities')) return { rows: [] };
    return { rows: [] };
  }
}

type Sent = { method: string; body: any; photo?: Buffer };

/**
 * The Bot API, including the one call that is multipart. `sendPhoto` is parsed
 * back out of the body so a test can assert the caption, the keyboard and the
 * bytes that were actually uploaded.
 */
function fakeApi(): { api: TelegramApi; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    if (method === 'sendPhoto') {
      const raw = init?.body as Buffer;
      const text = raw.toString('latin1');
      const body: Record<string, string> = {};
      for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) {
        body[match[1]!] = Buffer.from(match[2]!, 'latin1').toString('utf8');
      }
      const start = text.indexOf('\r\n\r\n', text.indexOf('name="photo"')) + 4;
      const end = text.lastIndexOf('\r\n--');
      sent.push({ method, body, photo: Buffer.from(text.slice(start, end), 'latin1') });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 7 } }) };
    }
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    const result = method === 'sendMessage' ? { message_id: 1 } : method === 'getUpdates' ? [] : true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
  return { api: new TelegramApi({ token: 't', fetch: fetchLike }), sent };
}

function status(over: Partial<BrowserStatus> = {}): BrowserStatus {
  return {
    state: 'running', enabled: true, busy: false, hasScreenshot: true, mode: 'playwright',
    session: { id: 's-1', agentId: AGENT, conversationId: CONVERSATION, requestId: 'r', task: 'Book the fixture', expiresAt: '2026-09-21T12:00:00.000Z', steps: 3, maxSteps: 80 },
    page: { id: 'p-1', url: 'https://example.com/book', title: 'Book a fixture', tabs: [], capturedAt: '2026-09-21T11:00:00.000Z' },
    ...over,
  } as BrowserStatus;
}

function photosOn(current: { value: BrowserStatus }, over: { allowedHosts?: string[]; publicOrigin?: string } = {}) {
  const { api, sent } = fakeApi();
  const photos = new BrowserPhotos({
    api,
    browser: { status: () => current.value, screenshot: () => Buffer.from('JPEGBYTES') },
    link: (agentId, conversationId) => browserTabUrl(
      { host: '127.0.0.1', port: 4317, ...(over.publicOrigin ? { publicOrigin: over.publicOrigin } : {}) },
      agentId, conversationId,
    ),
    ...(over.allowedHosts ? { allowedHosts: over.allowedHosts } : {}),
    log: () => {},
  });
  return { photos, sent };
}

const step = { chatId: OWNER_CHAT, agentId: AGENT, conversationId: CONVERSATION };

/* ---------------- the photo ---------------- */

describe('a photo per browser step', () => {
  it('sends the observation once, with the page, the action and the step count', async () => {
    const current = { value: status() };
    const { photos, sent } = photosOn(current);
    photos.noteCall(CONVERSATION, { action: 'click', target: { name: 'Book now' } });
    await photos.step(step);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('sendPhoto');
    expect(sent[0]!.photo!.toString()).toBe('JPEGBYTES');
    expect(sent[0]!.body.caption).toBe(`Book a fixture\nClicked “Book now”\n${LOOPBACK_CAPTION}`);
    expect(JSON.parse(sent[0]!.body.reply_markup)).toEqual({
      inline_keyboard: [[{ text: TAKE_OVER_LABEL, url: `http://127.0.0.1:4317/#/chat/${AGENT}/${CONVERSATION}?tab=browser` }]],
    });
  });

  it('says why a step failed', async () => {
    const current = { value: status({ page: { id: 'p-2', url: 'https://example.com/book', title: 'Book a fixture', tabs: [], capturedAt: 'x' } as any }) };
    const { photos, sent } = photosOn(current);
    photos.noteCall(CONVERSATION, { action: 'click', target: { name: 'Book now' } });
    await photos.step({ ...step, error: 'Target is missing, ambiguous, disabled or secure.' });
    expect(sent[0]!.body.caption).toContain('It failed: Target is missing, ambiguous, disabled or secure.');
  });

  it('skips a page it has already shown — an observe of the same screen is not a step worth a picture', async () => {
    const current = { value: status() };
    const { photos, sent } = photosOn(current);
    await photos.step(step);
    await photos.step(step);
    expect(sent).toHaveLength(1);
    // A new observation is a new photo.
    current.value = status({ page: { ...current.value.page!, id: 'p-2' } as any });
    await photos.step(step);
    expect(sent).toHaveLength(2);
  });

  it('never leaves this conversation: another conversation’s session is not photographed here', async () => {
    const current = { value: status({ session: { ...status().session!, conversationId: 'other' } }) };
    const { photos, sent } = photosOn(current);
    await photos.step(step);
    expect(sent).toHaveLength(0);
  });

  it('withholds a page outside the owner’s allowed hosts, and an app outside allowedApps', async () => {
    const outside = { value: status({ page: { id: 'p-9', url: 'https://tracker.example.net/x', title: 'Elsewhere', tabs: [], capturedAt: 'x' } as any }) };
    const { photos, sent } = photosOn(outside, { allowedHosts: ['example.com'] });
    await photos.step(step);
    expect(sent).toHaveLength(0);

    // Computer mode: the screenshot is a whole application window, so the
    // bundle ID is what has to be on the owner's list.
    const app = { value: status({
      mode: 'computer',
      settings: { mode: 'computer', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] },
      page: { id: 'p-a', url: 'app://com.apple.Notes', title: 'Notes', appId: 'com.apple.Notes', tabs: [], capturedAt: 'x' } as any,
    }) };
    const second = photosOn(app);
    await second.photos.step(step);
    expect(second.sent).toHaveLength(0);

    const allowed = { value: status({
      mode: 'computer',
      settings: { mode: 'computer', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] },
      page: { id: 'p-b', url: 'app://com.google.Chrome', title: 'Chrome', appId: 'com.google.Chrome', tabs: [], capturedAt: 'x' } as any,
    }) };
    const third = photosOn(allowed);
    await third.photos.step(step);
    expect(third.sent).toHaveLength(1);
  });

  it('fails closed on an address it cannot read, and on computer settings it did not get', () => {
    expect(screenshotAllowed(status({ page: { id: 'p', url: 'not a url', title: '', tabs: [], capturedAt: 'x' } as any }), ['example.com'])).toBe(false);
    expect(screenshotAllowed(status({ page: { id: 'p', url: 'app://com.apple.Notes', title: '', appId: 'com.apple.Notes', tabs: [], capturedAt: 'x' } as any }))).toBe(false);
    expect(screenshotAllowed(status({ hasScreenshot: false }), [])).toBe(false);
  });

  it('reads the action out of the call without ever quoting a typed value', () => {
    expect(stepCall({ action: 'fill', target: { ref: 'e3' }, value: 'hunter2' })).toEqual({ action: 'fill', target: 'e3' });
    expect(actionWords(stepCall({ action: 'navigate', url: 'https://example.com/a?token=secret' }))).toBe('Opened example.com');
    expect(actionWords(stepCall({ action: 'observe' }))).toBe('Looked at the page');
    expect(JSON.stringify(stepCall({ action: 'fill', target: { ref: 'e3' }, value: 'hunter2' }))).not.toContain('hunter2');
  });
});

/* ---------------- the button ---------------- */

describe('the Take over button', () => {
  it('is the public origin when one is configured, and loopback with a sentence otherwise', () => {
    expect(browserTabUrl({ host: '127.0.0.1', port: 4317, publicOrigin: 'https://buddi.tail1234.ts.net:8443' }, AGENT, CONVERSATION))
      .toEqual({ url: `https://buddi.tail1234.ts.net:8443/#/chat/${AGENT}/${CONVERSATION}?tab=browser`, loopback: false });
    expect(browserTabUrl({ host: '0.0.0.0', port: 4317 }, AGENT, CONVERSATION))
      .toEqual({ url: `http://127.0.0.1:4317/#/chat/${AGENT}/${CONVERSATION}?tab=browser`, loopback: true });
  });

  it('adds the loopback line to the caption only when the link is loopback', async () => {
    const current = { value: status() };
    const loopback = photosOn(current);
    await loopback.photos.step(step);
    expect(loopback.sent[0]!.body.caption).toContain(LOOPBACK_CAPTION);

    const current2 = { value: status() };
    const tailnet = photosOn(current2, { publicOrigin: 'https://buddi.tail1234.ts.net:8443' });
    await tailnet.photos.step(step);
    expect(tailnet.sent[0]!.body.caption).not.toContain(LOOPBACK_CAPTION);
    expect(JSON.parse(tailnet.sent[0]!.body.reply_markup).inline_keyboard[0][0].url)
      .toBe(`https://buddi.tail1234.ts.net:8443/#/chat/${AGENT}/${CONVERSATION}?tab=browser`);
  });

  it('keeps the caption inside Telegram’s cap even for a page with a long title', () => {
    const caption = stepCaption({ title: 'x'.repeat(500), url: 'https://example.com', call: { action: 'observe' }, steps: 1, maxSteps: 80, loopback: true });
    expect(caption.length).toBeLessThan(1024);
  });
});

/* ---------------- the commands ---------------- */

describe('/browser', () => {
  it('reads the word, and only its own', () => {
    expect(parseBrowserCommand('/browser')).toBe('status');
    expect(parseBrowserCommand('/browser@buddi_bot')).toBe('status');
    expect(parseBrowserCommand('/browser stop')).toBe('stop');
    expect(parseBrowserCommand('/browser RESUME')).toBe('resume');
    expect(parseBrowserCommand('/browser release')).toBe('release');
    expect(parseBrowserCommand('/browser takeover')).toBe('unknown');
    expect(parseBrowserCommand('/browsers')).toBeUndefined();
    expect(parseBrowserCommand('what is /browser')).toBeUndefined();
  });

  it('says the mode, who is driving and whether access is stopped', () => {
    expect(browserStatusText(status())).toContain('Browser control — running');
    expect(browserStatusText(status())).toContain('concierge is driving, 3 of 80 steps');
    const stopped = browserStatusText(status({ state: 'stopped', session: undefined, page: undefined }));
    expect(stopped).toContain('Access is stopped');
    expect(stopped).toContain('/browser resume');
    expect(stopped).toContain('No agent is driving');
    expect(browserStatusText(status({ mode: 'computer', session: undefined }))).toContain('Computer control');
    expect(browserStatusText({ state: 'unavailable', enabled: false, busy: false, hasScreenshot: false }))
      .toContain('Start buddi serve');
  });

  it('runs stop, resume and release through the same controller the dashboard uses', async () => {
    const calls: string[] = [];
    const browser = {
      status: () => status(),
      control: vi.fn(async (action: string) => { calls.push(action); return status({ state: action === 'stop' ? 'stopped' : 'running', message: 'Ready. Send a new message to the agent to continue.' }); }),
    };
    expect(await runBrowserCommand(browser as any, 'stop')).toContain('All browsers stopped');
    expect(await runBrowserCommand(browser as any, 'resume')).toContain('Access resumed');
    expect(await runBrowserCommand(browser as any, 'release')).toContain('Released');
    expect(calls).toEqual(['stop', 'resume', 'release']);
    // Status never touches the controls.
    await runBrowserCommand(browser as any, 'status');
    expect(calls).toEqual(['stop', 'resume', 'release']);
  });

  it('reports a refusal from the controller rather than throwing at the owner', async () => {
    const browser = { status: () => status(), control: async () => { throw new Error('Wait for the interrupted action to settle before resuming.'); } };
    expect(await runBrowserCommand(browser as any, 'resume')).toBe('Wait for the interrupted action to settle before resuming.');
  });

  it('is answered in the owner’s chat and nowhere else', async () => {
    const { api, sent } = fakeApi();
    const browserControl = vi.fn(async () => 'Access resumed.');
    const surface = new TelegramSurface({
      api, pool: new FakeDb(), catalog: fakeCatalog(), timezone: 'UTC',
      run: vi.fn(async () => 'reply'), log: () => {}, typingIntervalMs: 60_000, browserControl,
    } as any);

    await surface.dispatch(message(OWNER_CHAT, '/browser stop', Number(OWNER_USER)));
    expect(browserControl).toHaveBeenCalledWith('stop');
    expect(sent.at(-1)).toMatchObject({ method: 'sendMessage', body: { text: 'Access resumed.' } });

    // A stranger's command never reaches the controller and is never answered.
    sent.length = 0;
    await surface.dispatch(message('9999', '/browser stop', 9999));
    expect(browserControl).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });
});

function message(chatId: string, text: string, fromId: number): TelegramUpdate {
  return {
    update_id: 1,
    message: { message_id: 10, date: 0, chat: { id: Number(chatId), type: 'private' }, from: { id: fromId, is_bot: false, first_name: 'Owner' }, text },
  } as unknown as TelegramUpdate;
}

function fakeCatalog(): AgentCatalog {
  const agents = [{ id: AGENT, handle: 'concierge', name: 'Concierge', description: 't', isDefault: true, roles: [] }]
    .map((a) => a as unknown as CatalogAgent);
  const byDefault = agents[0] as CatalogAgent;
  return {
    get: (id) => agents.find((a) => a.id === id),
    byHandle: (handle) => agents.find((a) => a.handle === handle.replace(/^@/, '')),
    list: () => agents.map((a) => ({ ...a })) as any,
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({ ok: false, problem: { code: 'no-agent-for-role', role, message: roleProblemMessage(role) } }) as const,
    defaultAgent: () => byDefault,
    resolve: (id) => {
      if (id === undefined) return byDefault;
      const found = agents.find((a) => a.id === id);
      if (!found) throw new UnknownAgentError(id, agents.map((a) => a.id));
      return found;
    },
  };
}

describe('the step budget in a caption', () => {
  it('is said only when five or fewer steps are left', () => {
    const early = stepCaption({ title: 'A page', call: { action: 'observe' }, steps: 1, maxSteps: 80, loopback: false });
    expect(early).not.toContain('Step');
    const late = stepCaption({ title: 'A page', call: { action: 'observe' }, steps: 76, maxSteps: 80, loopback: false });
    expect(late).toContain('Step 76 of 80');
  });
});
