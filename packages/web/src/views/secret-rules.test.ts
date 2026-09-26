/**
 * The pure rules the Keys and secrets page stands on: which rules a binding
 * may pick, what one target input builds for each kind, how a stored target
 * reads back, and what the save's look reports. No server, no React.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_HELD_LINE,
  UNBOUND_LINE,
  allowedRules,
  foundSentence,
  isAccountKind,
  outcomeTone,
  parseTargetInput,
  placeCounts,
  placesSentence,
  renderTarget,
  scrubbedSentence,
  targetInputText,
  targetPlaceholder,
} from './secret-rules';

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

  it('says the one line the spec states for them', () => {
    expect(ACCOUNT_HELD_LINE).toContain('holds the value for as long as its connection lives');
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

describe('the outcome of a use', () => {
  it('wears the tone its word deserves', () => {
    expect(outcomeTone('delivered')).toBe('good');
    expect(outcomeTone('held')).toBe('warning');
    expect(outcomeTone('pending')).toBe('warning');
    expect(outcomeTone('refused')).toBe('critical');
    expect(outcomeTone('failed')).toBe('critical');
    expect(outcomeTone('something else')).toBeUndefined();
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
