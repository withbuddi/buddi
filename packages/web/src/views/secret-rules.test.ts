/**
 * The pure rules the Keys and secrets page stands on: which rules a binding
 * may pick, what one target input builds for each kind, how a stored target
 * reads back, and what the save's look reports. No server, no React.
 */
import { describe, expect, it } from 'vitest';
import {
  UNBOUND_LINE,
  allowedRules,
  foundSentence,
  isAccountKind,
  parseTargetInput,
  placeCounts,
  placesSentence,
  renderTarget,
  scrubbedSentence,
  targetInputText,
  targetPlaceholder,
  defaultRule,
  deleteStops,
  groupHeading,
  groupOrder,
  historyWords,
  managedHref,
  refusalWords,
  secretGroup,
  secretProblem,
  secretTag,
  secretTitle,
  unusedLine,
  whereLine,
} from './secret-rules';
import type { SecretListingView } from '../api';

describe('the rule a binding may pick', () => {
  it("offers the kind's loosest, or any stricter one — never a looser one", () => {
    expect(allowedRules('pre-approved')).toEqual(['every-time', 'first-time', 'pre-approved']);
    expect(allowedRules('first-time')).toEqual(['every-time', 'first-time']);
    expect(allowedRules('every-time')).toEqual(['every-time']);
  });
});

describe('the account kinds', () => {
  it('are exactly the kinds that end in .account', () => {
    expect(isAccountKind('mail.account')).toBe(true);
    expect(isAccountKind('imap.account')).toBe(true);
    // A provider kind is not an account kind, whatever its plugin's name.
    expect(isAccountKind('accounts.provider')).toBe(false);
    expect(isAccountKind('browser.field')).toBe(false);
    expect(isAccountKind('http.header')).toBe(false);
  });
});

describe('the target input per kind', () => {
  it('asks for the shape the kind binds with', () => {
    expect(targetPlaceholder('browser.field')).toContain('origin');
    expect(targetPlaceholder('browser.form.data')).toContain('origin');
    expect(targetPlaceholder('browser.form.data')).toContain('field name');
    expect(targetPlaceholder('http.header')).toContain('host');
    expect(targetPlaceholder('http.header')).toContain('header name');
    expect(targetPlaceholder('developer.env')).toContain('workspace');
    expect(targetPlaceholder('developer.env')).toContain('variable name');
    expect(targetPlaceholder('browser.native.type')).toContain('bundle id');
    expect(targetPlaceholder('mail.account')).toContain('account id');
  });

  it("takes a string where the kind's target is one", () => {
    expect(parseTargetInput('browser.field', ' https://localhost:8443 ')).toEqual({ ok: true, target: 'https://localhost:8443' });
    expect(parseTargetInput('browser.native.type', 'com.bank.app')).toEqual({ ok: true, target: 'com.bank.app' });
    expect(parseTargetInput('mail.account', 'acct-1')).toEqual({ ok: true, target: 'acct-1' });
  });

  it('splits a two-part kind at its last space, so a workspace may hold spaces', () => {
    expect(parseTargetInput('http.header', 'localhost:9200 Authorization')).toEqual({
      ok: true,
      target: { host: 'localhost:9200', header: 'Authorization' },
    });
    expect(parseTargetInput('browser.form.data', 'https://localhost:8443 card-number')).toEqual({
      ok: true,
      target: { origin: 'https://localhost:8443', field: 'card-number' },
    });
    expect(parseTargetInput('developer.env', 'cour des comptes ADMIN_PASSWORD')).toEqual({
      ok: true,
      target: { workspace: 'cour des comptes', variable: 'ADMIN_PASSWORD' },
    });
  });

  it('refuses a two-part kind with only one part, and an empty input', () => {
    expect(parseTargetInput('http.header', 'localhost:9200')).toEqual({
      ok: false,
      error: 'http.header needs both: a host, then the header name.',
    });
    expect(parseTargetInput('developer.env', '').ok).toBe(false);
  });

  it('reads JSON as the target the owner meant, whatever the kind', () => {
    expect(parseTargetInput('http.header', '{"host":"localhost:9200","header":"X-Key"}')).toEqual({
      ok: true,
      target: { host: 'localhost:9200', header: 'X-Key' },
    });
    expect(parseTargetInput('some.kind', '{"workspace":"w","variable":"V"}')).toEqual({
      ok: true,
      target: { workspace: 'w', variable: 'V' },
    });
    expect(parseTargetInput('http.header', '{"host":').ok).toBe(false);
    expect(parseTargetInput('http.header', '["host"]').ok).toBe(false);
  });

  it('hands a kind it does not know through as the text it was given', () => {
    expect(parseTargetInput('other.thing', 'somewhere')).toEqual({ ok: true, target: 'somewhere' });
  });
});

describe('a stored target as the page reads it back', () => {
  it('shows the known shapes as readable text and anything else as JSON', () => {
    expect(renderTarget('browser.field', 'https://localhost:8443')).toBe('https://localhost:8443');
    expect(renderTarget('http.header', { host: 'localhost:9200', header: 'Authorization' })).toBe('localhost:9200 · Authorization');
    expect(renderTarget('developer.env', { workspace: 'cour des comptes', variable: 'ADMIN_PASSWORD' })).toBe(
      'cour des comptes · ADMIN_PASSWORD',
    );
    expect(renderTarget('browser.form.data', { origin: 'https://localhost:8443', field: 'card-number' })).toBe(
      'https://localhost:8443 · card-number',
    );
    expect(renderTarget('some.kind', { host: 'h' })).toBe('{"host":"h"}');
    expect(renderTarget('some.kind', null)).toBe('null');
  });

  it('round-trips through the one text input', () => {
    for (const target of ['https://localhost:8443', { host: 'localhost:9200', header: 'X-Key' }, { workspace: 'cour des comptes', variable: 'V' }]) {
      const kind = typeof target === 'string' ? 'browser.field' : 'host' in (target as object) ? 'http.header' : 'developer.env';
      const parsed = parseTargetInput(kind, targetInputText(target));
      expect(parsed).toEqual({ ok: true, target });
    }
  });
});

describe('what a save reports', () => {
  it("reads the places out of the tool's answer, and never a value", () => {
    const result = { name: 'PNC password', found: [{ place: 'events', count: 3 }, { place: 'memory notes', count: 1 }] };
    expect(placeCounts(result, 'found')).toEqual([
      { place: 'events', count: 3 },
      { place: 'memory notes', count: 1 },
    ]);
    expect(placeCounts(result, 'scrubbed')).toEqual([]);
    expect(placeCounts(undefined, 'found')).toEqual([]);
    expect(placeCounts({ found: [{ place: 'events', count: 0 }, 'junk', null] }, 'found')).toEqual([]);
  });

  it('counts the places in one sentence, singular where there was one', () => {
    expect(placesSentence([{ place: 'events', count: 3 }, { place: 'memory notes', count: 1 }])).toBe('3 events and 1 memory note');
    expect(placesSentence([{ place: 'messages', count: 1 }])).toBe('1 message');
    expect(placesSentence([])).toBe('');
  });

  it('says what the save found, and what the scrub replaced', () => {
    const result = { name: 'x', found: [{ place: 'events', count: 3 }] };
    expect(foundSentence(result)).toBe('The value already sits in 3 events.');
    expect(foundSentence({ found: [] })).toBe('');
    expect(scrubbedSentence({ scrubbed: [{ place: 'memory preferences', count: 2 }, { place: 'events', count: 1 }] })).toBe(
      'Replaced with ‹secret:…› in 2 memory preferences and 1 event.',
    );
    expect(scrubbedSentence({ scrubbed: [] })).toBe('');
  });

  it('says a secret with no binding is stored but not usable', () => {
    expect(UNBOUND_LINE).toMatch(/Stored, not usable/);
  });
});

describe('a browser.field target', () => {
  it('takes a bare host as https and keeps only the origin', () => {
    expect(parseTargetInput('browser.field', 'auth.wikimedia.org')).toEqual({ ok: true, target: 'https://auth.wikimedia.org' });
    expect(parseTargetInput('browser.field', 'https://en.wikipedia.org/w/index.php?title=Special:UserLogin')).toEqual({ ok: true, target: 'https://en.wikipedia.org' });
    expect(parseTargetInput('browser.field', 'http://localhost:8443/x')).toEqual({ ok: true, target: 'http://localhost:8443' });
  });
  it('refuses what is not a site', () => {
    expect(parseTargetInput('browser.field', 'not a site at all').ok).toBe(false);
  });
});

describe('a wildcard origin', () => {
  it('takes *.wikimedia.org with or without its scheme and stores the https pattern', () => {
    expect(parseTargetInput('browser.field', '*.wikimedia.org')).toEqual({ ok: true, target: 'https://*.wikimedia.org' });
    expect(parseTargetInput('browser.field', ' https://*.WikiMedia.org/ ')).toEqual({ ok: true, target: 'https://*.wikimedia.org' });
    expect(parseTargetInput('browser.field', 'http://*.corp.test:8443')).toEqual({ ok: true, target: 'http://*.corp.test:8443' });
    expect(parseTargetInput('browser.form.data', '*.wikimedia.org card-number')).toEqual({ ok: true, target: { origin: 'https://*.wikimedia.org', field: 'card-number' } });
    expect(targetPlaceholder('browser.field')).toContain('*.wikimedia.org');
  });

  it('refuses a * anywhere but the leftmost part, in one sentence', () => {
    for (const text of ['*', 'auth.*.org', 'https://*wikimedia.org', 'en.wikipedia.org/*', '*.*.wikimedia.org']) {
      expect(parseTargetInput('browser.field', text)).toEqual({ ok: false, error: 'A wildcard may only stand for the leftmost part of a site, like *.wikimedia.org.' });
    }
    expect(parseTargetInput('browser.form.data', 'auth.*.org card-number')).toEqual({ ok: false, error: 'A wildcard may only stand for the leftmost part of a site, like *.wikimedia.org.' });
  });

  it('refuses a public suffix, naming what it would match', () => {
    expect(parseTargetInput('browser.field', '*.com')).toEqual({ ok: false, error: 'That is a public suffix; *.com would match every site.' });
    expect(parseTargetInput('browser.field', 'https://*.co.uk')).toEqual({ ok: false, error: 'That is a public suffix; *.co.uk would match every site.' });
    for (const text of ['*.github.io', '*.pages.dev', '*.vercel.app', '*.herokuapp.com']) {
      expect(parseTargetInput('browser.field', text)).toMatchObject({ ok: false, error: expect.stringContaining('public suffix') });
    }
  });

  it("normalises a form data binding's origin the way a field binding's is, and refuses one that is not a site", () => {
    expect(parseTargetInput('browser.form.data', 'localhost:8443 card-number')).toEqual({ ok: true, target: { origin: 'https://localhost:8443', field: 'card-number' } });
    expect(parseTargetInput('browser.form.data', 'not a site card-number')).toMatchObject({ ok: false });
  });
});

/* ---- the page's words for a secret ---- */

const NOW = Date.parse('2026-10-01T12:00:00Z');
const at = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
const secret = (over: Partial<SecretListingView>): SecretListingView => ({
  name: 'PNC password',
  totp: false,
  bindings: [],
  lastUse: null,
  hasValue: true,
  usedBy: [],
  unused: false,
  ...over,
});
const bound = (kind: string, target: unknown, rule: 'every-time' | 'first-time' | 'pre-approved' = 'pre-approved', firstApprovedAt: string | null = null) => ({
  kind, target, rule, firstApprovedAt, heldByPlugin: kind.endsWith('.account'),
});
const MAILBOX = { kind: 'mailbox' as const, id: 'm-1', address: 'sam@gmail.com', provider: 'Gmail', auth: 'app-password' as const, loginFailedAt: null };
const MODEL = { kind: 'model-account' as const, id: 'acct-1', label: 'Claude', auth: 'api-key' };
const CONNECTION = { kind: 'connection' as const, id: 'conn-1', name: 'Linear', variable: null };
const ACCOUNTS = new Map([['acct-1', { label: 'Claude', provider: 'Anthropic API' }]]);

describe('which group a secret sits in', () => {
  it('goes by what holds it, then what it is bound to, else it is the owner’s own', () => {
    expect(secretGroup(secret({ usedBy: [MAILBOX] }))).toBe('mail');
    expect(secretGroup(secret({ name: 'GMAIL_APP_PASSWORD' }))).toBe('mail');
    expect(secretGroup(secret({ usedBy: [MODEL] }))).toBe('models');
    expect(secretGroup(secret({ name: 'CODEX_ACCOUNT_1234' }))).toBe('models');
    expect(secretGroup(secret({ usedBy: [CONNECTION] }))).toBe('connections');
    expect(secretGroup(secret({ name: 'MCP_TOKEN_abc' }))).toBe('connections');
    expect(secretGroup(secret({ bindings: [bound('http.url', { plugin: 'calendar', host: 'calendar.google.com' })] }))).toBe('plugin:calendar');
    expect(secretGroup(secret({ bindings: [bound('browser.field', 'https://www.pnc.com')] }))).toBe('mine');
    expect(secretGroup(secret({}))).toBe('mine');
  });

  it('heads each group in a word and orders them: yours, Mail, the plugins’, then the two managed elsewhere', () => {
    expect(groupHeading('plugin:calendar').title).toBe('Calendar links');
    expect(groupHeading('plugin:weather').title).toBe('Weather');
    const order = (['connections', 'models', 'plugin:calendar', 'mail', 'mine'] as const).slice().sort(groupOrder);
    expect(order).toEqual(['mine', 'mail', 'plugin:calendar', 'models', 'connections']);
  });
});

describe('the human name of each kind', () => {
  it('names a mailbox’s password by its provider, a model account by its label, a connection by its name, a calendar link by its calendar', () => {
    expect(secretTitle(secret({ name: 'EMAIL_SAM_GMAIL_COM_b68f74ea', usedBy: [MAILBOX] }))).toBe('Gmail app password');
    expect(secretTitle(secret({ name: 'EMAIL_X', usedBy: [{ ...MAILBOX, provider: 'Email' }] }))).toBe('Mailbox app password');
    expect(secretTitle(secret({ name: 'EMAIL_X', usedBy: [{ ...MAILBOX, auth: 'xoauth2' }] }))).toBe('Gmail sign-in');
    expect(secretTitle(secret({ name: 'GMAIL_APP_PASSWORD' }))).toBe('Old mailbox password');
    expect(secretTitle(secret({ name: 'PROVIDER_ACCOUNT_1', usedBy: [MODEL] }), ACCOUNTS)).toBe('Claude');
    expect(secretTag(secret({ name: 'PROVIDER_ACCOUNT_1', usedBy: [MODEL] }), ACCOUNTS)).toBe('Anthropic API');
    expect(secretTitle(secret({ name: 'MCP_TOKEN_abc', usedBy: [CONNECTION] }))).toBe('Linear');
    expect(secretTitle(secret({ name: 'Calendar link: Family', bindings: [bound('http.url', { plugin: 'calendar', host: 'x.test' })] }))).toBe('Family');
    expect(secretTitle(secret({ name: 'PNC password' }))).toBe('PNC password');
  });
});

describe('where it may go, in one line', () => {
  it('says who holds it for the held groups, and the places for the rest, never an id', () => {
    expect(whereLine(secret({ usedBy: [MAILBOX] }))).toBe('Used by the mailbox sam@gmail.com');
    expect(whereLine(secret({ usedBy: [MODEL] }))).toBe('API key for this model account');
    expect(whereLine(secret({ name: 'MCP_TOKEN_a', usedBy: [CONNECTION], bindings: [bound('http.header', { host: 'mcp.linear.app', header: 'Authorization' })] }))).toBe('Sign-in token · sent only to mcp.linear.app');
    expect(whereLine(secret({ bindings: [bound('browser.field', 'https://www.pnc.com', 'first-time')] }))).toBe('Filled on pnc.com · asks you the first time');
    // Approved once: "the first time" is behind it.
    expect(whereLine(secret({ bindings: [bound('browser.field', 'https://www.pnc.com', 'first-time', '2026-09-01T00:00:00Z')] }))).toBe('Filled on pnc.com');
    expect(whereLine(secret({ bindings: [bound('http.header', { host: 'api.github.com', header: 'Authorization' })] }))).toBe('Sent only to api.github.com');
    expect(whereLine(secret({ totp: true, bindings: [bound('browser.field', 'https://*.amazon.com', 'every-time')] }))).toBe('Filled on any amazon.com site · asks you every time · a fresh code each time');
    expect(whereLine(secret({}))).toBe('');
  });
});

describe('a problem, as one sentence with its one fix', () => {
  it('says a value that is not stored, with the fix where it lives', () => {
    expect(secretProblem(secret({ hasValue: false, bindings: [bound('browser.field', 'https://a.test')] }), NOW)).toEqual({ text: 'No value stored.', fix: { label: 'Set a value', action: 'replace' } });
    expect(secretProblem(secret({ hasValue: false, usedBy: [MAILBOX] }), NOW)?.fix).toEqual({ label: 'Set password', href: '#/settings/p.email.settings?account=m-1&set=password' });
    expect(secretProblem(secret({ hasValue: false, usedBy: [MODEL] }), NOW)?.fix).toEqual({ label: 'Fix in Model accounts', href: '#/settings/accounts?account=acct-1' });
  });

  it('says a refusal truthfully: buddi held it back, and where it was asked for', () => {
    const refused = (detail: string) => secret({
      name: 'GitHub token',
      bindings: [bound('http.header', { host: 'api.github.com', header: 'Authorization' })],
      lastUse: { at: at(23), kind: 'http.header', target: {}, agentId: 'forge', outcome: 'refused', detail },
    });
    expect(secretProblem(refused('"GitHub token" is not bound to uploads.github.com.'), NOW)).toEqual({
      text: 'Held back 23 seconds ago: it was asked for at uploads.github.com, where it may not go.',
      fix: { label: 'Change where it may go', action: 'places' },
    });
    expect(secretProblem(refused('The vault is locked; unlock this machine and try again.'), NOW)).toEqual({ text: 'Held back 23 seconds ago: the vault was locked.', fix: null });
    expect(secretProblem(refused('"GitHub token" has no value stored; replace it in Settings.'), NOW)?.text).toBe('No value stored.');
  });

  it('keeps an id out of a held group’s refusal', () => {
    const problem = secretProblem(secret({
      usedBy: [MAILBOX],
      lastUse: { at: at(60), kind: 'email.account', target: 'm-1', agentId: null, outcome: 'refused', detail: '"X" is not bound to the login of mailbox 4f8d261b-e100-4c1a-9a51-6b2f0e7d9c11.' },
    }), NOW);
    expect(problem).toEqual({ text: 'Held back 1 minute ago: it was asked for somewhere it may not go.', fix: null });
  });

  it('says a mailbox the server turned down, a failed delivery, a wait on the owner, and a secret with nowhere to go', () => {
    expect(secretProblem(secret({ usedBy: [{ ...MAILBOX, loginFailedAt: at(720) }] }), NOW)).toEqual({
      text: 'Gmail turned it down at sign-in 12 minutes ago.',
      fix: { label: 'Set password', href: '#/settings/p.email.settings?account=m-1&set=password' },
    });
    expect(secretProblem(secret({ bindings: [bound('browser.field', 'https://a.test')], lastUse: { at: at(5), kind: 'browser.field', target: 'https://a.test', agentId: 'x', outcome: 'failed', detail: 'the field was gone.' } }), NOW))
      .toEqual({ text: 'Didn’t go through 5 seconds ago: the field was gone.', fix: { label: 'Replace value', action: 'replace' } });
    expect(secretProblem(secret({ bindings: [bound('browser.field', 'https://a.test', 'every-time')], lastUse: { at: at(5), kind: 'browser.field', target: 'https://a.test', agentId: 'x', outcome: 'pending', detail: null } }), NOW))
      .toEqual({ text: 'Waiting for your approval since 5 seconds ago.', fix: { label: 'Review', href: '#/needs' } });
    expect(secretProblem(secret({}), NOW)).toEqual({ text: 'Can’t be used anywhere until you choose where it may go.', fix: { label: 'Choose where it may go', action: 'places' } });
  });

  it('says nothing on a healthy row, nor on one nothing uses any more', () => {
    expect(secretProblem(secret({ bindings: [bound('browser.field', 'https://a.test')], lastUse: { at: at(5), kind: 'browser.field', target: 'https://a.test', agentId: 'x', outcome: 'delivered', detail: null } }), NOW)).toBeNull();
    expect(secretProblem(secret({ name: 'GMAIL_APP_PASSWORD', unused: true, hasValue: false }), NOW)).toBeNull();
  });
});

describe('not used by anything', () => {
  it('is a quiet line, worded for the group, and only when the gateway says so', () => {
    expect(unusedLine(secret({ name: 'GMAIL_APP_PASSWORD', unused: true }))).toBe('Not used by anything — no mailbox uses it any more.');
    expect(unusedLine(secret({ name: 'PROVIDER_ACCOUNT_1', unused: true }))).toBe('Not used by anything — no model account uses it any more.');
    expect(unusedLine(secret({ name: 'GMAIL_APP_PASSWORD' }))).toBe('');
  });
});

describe('the rest of the page’s words', () => {
  it('links the read-only groups to where they are managed', () => {
    expect(managedHref(secret({ usedBy: [MODEL] }))).toEqual({ label: 'Managed in Model accounts', href: '#/settings/accounts?account=acct-1' });
    expect(managedHref(secret({ usedBy: [CONNECTION] }))).toEqual({ label: 'Managed in Connections', href: '#/settings/connections?connection=conn-1' });
    expect(managedHref(secret({}))).toBeNull();
  });

  it('names what a delete stops', () => {
    expect(deleteStops(secret({ bindings: [bound('browser.field', 'https://www.pnc.com')] }))).toBe('Agents can no longer fill it on pnc.com.');
    expect(deleteStops(secret({ unused: true, bindings: [bound('email.account', 'm-1')] }))).toBe('Nothing uses it, so nothing stops working.');
  });

  it('says each use in the history in words', () => {
    expect(historyWords({ kind: 'http.header', target: { host: 'api.github.com', header: 'A' }, outcome: 'delivered', detail: null })).toEqual({ text: 'Sent to api.github.com' });
    expect(historyWords({ kind: 'email.account', target: 'm-1', outcome: 'held', detail: null })).toEqual({ text: 'Signed in' });
    expect(refusalWords('"X" is not bound to uploads.github.com.')).toBe('asked for at uploads.github.com, where it may not go');
  });

  it('starts a new place at “the first time” when the kind allows it, never looser', () => {
    expect(defaultRule('pre-approved')).toBe('first-time');
    expect(defaultRule('first-time')).toBe('first-time');
    expect(defaultRule('every-time')).toBe('every-time');
  });
});
