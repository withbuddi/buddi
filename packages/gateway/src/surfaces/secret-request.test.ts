/**
 * `secret.request` (docs/owner-secrets.md §6): the site it may ask for, the
 * warning labels, and that nothing secret is ever in what it records or
 * answers. No database: a fake pool answers the owner's own words.
 */
import { ToolRegistry, type CoreToolContext } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import type { AskSink } from './pending-question.js';
import {
  buildRequestCard,
  createSecretRequestManifest,
  grantsSecretRequest,
  normalizeSite,
  outcomeStamp,
  outcomeTurnText,
  ownerNamedSite,
  requestOrigins,
  secretNameFor,
  sensitiveLabel,
  siteOfHost,
  telegramSignInReply,
  SECRET_REQUEST_TOOL,
} from './secret-request.js';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';

/** The owner's turns in the conversation, as `core.messages` holds them. */
function poolSaying(...texts: string[]) {
  return {
    query: async (_sql: string, _params?: unknown[]) => ({
      rows: texts.map((text) => ({ content: [{ type: 'text', text }] })),
    }),
  } as never;
}

/** The browser host, on one page. */
function onPage(url: string | undefined) {
  return { status: () => ({ state: 'running', enabled: true, busy: false, hasScreenshot: false, ...(url ? { page: { id: 'p1', url, title: 'Log in · Wikipedia' } } : {}) }) } as never;
}

const ctx = { agentId: 'scout', conversationId: CONVERSATION } as Pick<CoreToolContext, 'agentId' | 'conversationId'>;
const fields = [{ label: 'Username', kind: 'username' as const, ref: 'e3' }, { label: 'Password', kind: 'password' as const, ref: 'e4' }];

describe('the site a card may name', () => {
  it('reads a site the way the owner writes it', () => {
    expect(normalizeSite('https://www.Wikipedia.org/wiki/Lyon')).toBe('wikipedia.org');
    expect(normalizeSite('en.wikipedia.org')).toBe('en.wikipedia.org');
    expect(normalizeSite('localhost')).toBeUndefined();
    expect(normalizeSite('co.uk')).toBeUndefined();
    expect(normalizeSite('github.io')).toBeUndefined();
    expect(normalizeSite('10.0.0.1')).toBeUndefined();
  });

  it('defaults to the site of the page the agent is on', () => {
    expect(siteOfHost('en.wikipedia.org')).toBe('wikipedia.org');
    expect(siteOfHost('www.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('binds the page itself and the site with every host under it', () => {
    expect(requestOrigins('wikipedia.org', 'https://en.wikipedia.org')).toEqual(['https://en.wikipedia.org', 'https://wikipedia.org', 'https://*.wikipedia.org']);
    // A page on another site is never one of the places.
    expect(requestOrigins('wikipedia.org', 'https://evil.example')).toEqual(['https://wikipedia.org', 'https://*.wikipedia.org']);
  });

  it('defaults the site to the page and keeps the refs', async () => {
    const card = await buildRequestCard({ pool: poolSaying(), browser: onPage('https://en.wikipedia.org/w/index.php?title=Special:UserLogin') }, { fields }, ctx);
    expect(card.site).toBe('wikipedia.org');
    expect(card.origins[0]).toBe('https://en.wikipedia.org');
    expect(card.fields.map((field) => field.ref)).toEqual(['e3', 'e4']);
  });

  it('refuses a site that is neither the page nor one the owner named', async () => {
    const asking = buildRequestCard({ pool: poolSaying('Add the Lyon article to my watchlist'), browser: onPage('https://en.wikipedia.org/login') }, { site: 'paypal.com', fields }, ctx);
    await expect(asking).rejects.toThrow(/paypal\.com is not the page you have open \(en\.wikipedia\.org\), and the owner has not named it/);
  });

  it('accepts a site the owner named in the conversation, and fills nothing on another page', async () => {
    const card = await buildRequestCard({ pool: poolSaying('Add the Lyon article to my Wikipedia watchlist'), browser: onPage('https://auth.wikimedia.org/login') }, { site: 'wikipedia.org', fields }, ctx);
    expect(card.site).toBe('wikipedia.org');
    expect(card.origins).toEqual(['https://wikipedia.org', 'https://*.wikipedia.org']);
    // The refs belong to a page that is not the site's: buddi never fills there by itself.
    expect(card.fields.every((field) => field.ref === undefined)).toBe(true);
  });

  it('reads only text the owner typed for what they named', async () => {
    const pool = {
      query: async () => ({ rows: [{ content: [{ type: 'tool_result', content: 'paypal.com' }] }] }),
    } as never;
    expect(await ownerNamedSite(pool, CONVERSATION, 'paypal.com')).toBe(false);
    expect(await ownerNamedSite(poolSaying('log me into PayPal'), CONVERSATION, 'paypal.com')).toBe(true);
  });

  it('refuses with no page and no site the owner named', async () => {
    await expect(buildRequestCard({ pool: poolSaying(), browser: onPage(undefined) }, { fields }, ctx)).rejects.toThrow(/no page open/);
  });
});

describe('labels that look like something no sign-in should hold', () => {
  it('names a card number, a CVV, an SSN and a one-time code', () => {
    expect(sensitiveLabel('Card number', 'other')).toBe('a card number');
    expect(sensitiveLabel('CVV', 'other')).toBe('a card security code');
    expect(sensitiveLabel('Social Security Number', 'other')).toBe('a social security number');
    expect(sensitiveLabel('One-time code', 'other')).toBe('a one-time code');
    expect(sensitiveLabel('Password', 'password')).toBeUndefined();
    expect(sensitiveLabel('Username', 'username')).toBeUndefined();
    // An authenticator seed is asked for by kind.
    expect(sensitiveLabel('Authenticator code', 'totp')).toBeUndefined();
  });

  it('puts the warning line on the card and keeps the field from filling by itself', async () => {
    const card = await buildRequestCard(
      { pool: poolSaying(), browser: onPage('https://www.wikipedia.org/donate'), agentName: () => 'Scout' },
      { fields: [{ label: 'Card number', kind: 'other', ref: 'e9' }] },
      ctx,
    );
    expect(card.warnings).toEqual(['Scout asked for something that looks like a card number; buddi keeps it only on wikipedia.org']);
    expect(card.fields[0]?.warning).toBe(card.warnings![0]);
  });
});

describe('the tool', () => {
  it('is granted with secret.fill', () => {
    expect(grantsSecretRequest(['browser.act', 'secret.fill'])).toBe(true);
    expect(grantsSecretRequest(['secret.*'])).toBe(true);
    expect(grantsSecretRequest(['browser.act'])).toBe(false);
  });

  it('raises the card, parks the turn, and answers no value', async () => {
    const sink: AskSink = {};
    const manifest = createSecretRequestManifest(sink, { pool: poolSaying(), browser: onPage('https://en.wikipedia.org/login'), agentName: () => 'Scout' });
    const tool = manifest.tools!.find((t) => t.name === SECRET_REQUEST_TOOL)!;
    expect(tool.tier).toBe('auto');
    expect(tool.ownerOnly).not.toBe(true);
    expect(tool.waitsForOwner).toBe(true);
    // The input has nowhere to put a value: labels, kinds and refs only.
    expect(Object.keys((tool.input as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(['fields', 'reason', 'site']);
    const registry = new ToolRegistry();
    registry.register(manifest);
    const result = await registry.invoke(SECRET_REQUEST_TOOL, { fields }, { ...ctx, db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as CoreToolContext);
    expect(result.ok).toBe(true);
    expect(result.ok && result.output).toMatchObject({ pending: true });
    expect(sink.asked?.request?.site).toBe('wikipedia.org');
    expect(sink.asked?.question).toBe('No saved sign-in for wikipedia.org');
    expect(sink.asked?.options.map((option) => option.label)).toEqual(['Decline']);
    expect(sink.asked?.allowOther).toBe(false);
  });

  it('refuses a foreign site through the registry, recording nothing', async () => {
    const sink: AskSink = {};
    const registry = new ToolRegistry();
    registry.register(createSecretRequestManifest(sink, { pool: poolSaying(), browser: onPage('https://en.wikipedia.org/login') }));
    const result = await registry.invoke(SECRET_REQUEST_TOOL, { site: 'bank.example.com', fields }, { ...ctx, db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' } as CoreToolContext);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/bank\.example\.com is not the page you have open/);
    expect(sink.asked).toBeUndefined();
  });
});

describe('what comes back to the agent', () => {
  const SECRET = 'correct-horse-battery';

  it('is names and a flag, never a value', () => {
    const text = outcomeTurnText({ saved: ['Wikipedia username', 'Wikipedia password'], filled: true });
    expect(text).toContain('tool result (deferred) for secret.request: {"saved":["Wikipedia username","Wikipedia password"],"filled":true}');
    expect(text).not.toContain(SECRET);
    expect(outcomeTurnText({ declined: 'sign-in-myself' })).toContain('{"declined":"sign-in-myself"}');
  });

  it('stamps the thread with one quiet line', () => {
    expect(outcomeStamp({ saved: ['a', 'b'], filled: true }, 'wikipedia.org', ['Username', 'Password'])).toBe('Filled username and password on wikipedia.org');
    expect(outcomeStamp({ saved: ['a', 'b'], filled: false }, 'wikipedia.org', ['Username', 'Password'])).toBe('Saved username and password for wikipedia.org');
    expect(outcomeStamp({ declined: 'sign-in-myself' }, 'wikipedia.org', [])).toBe('You’re signing in on wikipedia.org yourself');
  });

  it('names each secret after the site and the field', () => {
    expect(secretNameFor('wikipedia.org', 'Password')).toBe('Wikipedia password');
    expect(secretNameFor('bbc.co.uk', 'Email')).toBe('Bbc email');
  });
});

describe('on Telegram', () => {
  it('says where to save it, never asks for it there', () => {
    const reply = telegramSignInReply('I need your Wikipedia sign-in.', { site: 'wikipedia.org' }, 'https://buddi.example/#/chat/scout/abc');
    expect(reply).toBe('I need your Wikipedia sign-in.\n\nOpen the dashboard to save the sign-in for wikipedia.org: https://buddi.example/#/chat/scout/abc');
    expect(telegramSignInReply('', { site: 'wikipedia.org' })).toBe('Open the dashboard to save the sign-in for wikipedia.org.');
  });
});
