/**
 * The scrubber (docs/specs/owner-secrets.md §5, acceptance 4).
 *
 * What a stored value looks like when it comes back out of a process, a page
 * or a header: exact, URL-encoded (both space spellings), JSON-escaped, and
 * base64 whole or embedded at any of the three byte alignments. And the one
 * the acceptance names: a four-digit PIN does not blank every year in a page.
 */
import { describe, expect, it } from 'vitest';
import {
  SecretAutomaton,
  encodingsOf,
  findSecretMatches,
  primeSecretScrubber,
  scrubDeep,
  scrubText,
  secretMarker,
  setSecretScrubSource,
} from './scrub.js';

function scrubWith(entries: Array<{ name: string; value: string }>, text: string): string {
  setSecretScrubSource(async () => entries);
  // primeSecretScrubber never throws, even on a source that does; this one answers.
  return (async () => {
    await primeSecretScrubber();
    return scrubText(text);
  })();
}

describe('encodingsOf', () => {
  it('carries the exact value first', () => {
    expect(encodingsOf('s3cret-value')).toContain('s3cret-value');
  });

  it('URL-encodes reserved characters both ways a space is spelled', () => {
    const encodings = encodingsOf('a b/c?d=e&f');
    expect(encodings).toContain('a%20b%2Fc%3Fd%3De%26f');
    expect(encodings).toContain('a+b%2Fc%3Fd%3De%26f');
  });

  it('JSON-escapes quotes and backslashes', () => {
    const encodings = encodingsOf('say "hi" \\ go');
    expect(encodings).toContain('say \\"hi\\" \\\\ go');
  });

  it('base64 at each byte alignment, both alphabets', () => {
    const encodings = encodingsOf('topsecret');
    const std = Buffer.from('topsecret', 'utf8').toString('base64');
    const url = std.replaceAll('+', '-').replaceAll('/', '_');
    expect(encodings).toContain(std);
    expect(encodings).toContain(url);
  });

  it('the stable middle matches a value inside a longer base64 blob, at every alignment', () => {
    const value = 'the-middle-of-a-long-token-9f8e7d6c';
    const cores = encodingsOf(value).filter((e) => /^[A-Za-z0-9+/=_-]+$/.test(e) && e !== value);
    expect(cores.length).toBeGreaterThan(4);
    for (let offset = 0; offset < 5; offset++) {
      const blob = Buffer.concat([Buffer.from('x'.repeat(offset), 'utf8'), Buffer.from(value, 'utf8'), Buffer.from('y'.repeat(7), 'utf8')]).toString('base64');
      const hits = cores.filter((core) => blob.includes(core));
      expect(hits.length, `offset ${offset}`).toBeGreaterThan(0);
    }
  });
});

describe('SecretAutomaton', () => {
  it('finds one pattern among many, whatever the order of the patterns', () => {
    const automaton = new SecretAutomaton(
      ['alpha', 'bravo', 'charlie'].flatMap((name) => [{ pattern: `p-${name}`, name }]),
    );
    const matches = automaton.matches('nothing here p-bravo end');
    expect(matches).toEqual([{ pattern: 'p-bravo', name: 'bravo', start: 13, end: 20 }]);
  });

  it('a shared prefix does not confuse it', () => {
    const automaton = new SecretAutomaton([
      { pattern: 'token-one-value', name: 'one' },
      { pattern: 'token-two-value', name: 'two' },
    ]);
    expect(scrubOf(automaton, 'x token-two-value y')).toBe(`x ${secretMarker('two')} y`);
    expect(scrubOf(automaton, 'token-one-value token-one-value')).toBe(
      `${secretMarker('one')} ${secretMarker('one')}`,
    );
  });

  it('one pass replaces several different secrets in one text', () => {
    const automaton = new SecretAutomaton([
      { pattern: 'AAA111', name: 'first' },
      { pattern: 'BBB222', name: 'second' },
    ]);
    expect(scrubOf(automaton, 'AAA111 and BBB222 and AAA111 again')).toBe(
      `${secretMarker('first')} and ${secretMarker('second')} and ${secretMarker('first')} again`,
    );
  });
});

function scrubOf(automaton: SecretAutomaton, text: string): string {
  let out = '';
  let at = 0;
  const sorted = [...automaton.matches(text)].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: typeof sorted = [];
  let cursor = -1;
  for (const m of sorted) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }
  for (const m of kept) {
    out += text.slice(at, m.start) + secretMarker(m.name);
    at = m.end;
  }
  return out + text.slice(at);
}

describe('scrubText', () => {
  it('replaces an exact value in a tool-result-shaped text', async () => {
    const out = await scrubWith([{ name: 'PNC password', value: 'hunter2-password' }],
      'the login failed: password hunter2-password rejected');
    expect(out).toBe(`the login failed: password ${secretMarker('PNC password')} rejected`);
  });

  it('catches a value URL-encoded or JSON-escaped (acceptance 4)', async () => {
    const value = 'tok en/+"';
    const url = encodeURIComponent(value);
    const json = JSON.stringify(value).slice(1, -1);
    expect(await scrubWith([{ name: 'API token', value }], `header=${url}`)).toBe(`header=${secretMarker('API token')}`);
    expect(await scrubWith([{ name: 'API token', value }], `{"k":"${json}"}`)).toBe(`{"k":"${secretMarker('API token')}"}`);
  });

  it('catches a value base64-encoded in a blob (acceptance 4)', async () => {
    const value = 'sk-ant-oat01-embedded-secret-value';
    const blob = Buffer.concat([Buffer.from('prefix-bytes-', 'utf8'), Buffer.from(value, 'utf8')]).toString('base64');
    const out = await scrubWith([{ name: 'model key', value }], `result: ${blob}`);
    // The stable middle is replaced; the head characters belong to the
    // preceding bytes and the tail to whatever followed, so they remain — the
    // value itself cannot be reconstructed from either.
    expect(out.startsWith(`result: cHJlZml4LWJ5dGVzLX`)).toBe(true);
    expect(out).toContain(secretMarker('model key'));
    expect(out.endsWith('U=')).toBe(true);
    expect(out).not.toContain(blob);
  });

  it('a short value matches only on token boundaries', async () => {
    // `1234` inside the longer number `12345` is a substring of a token, not a
    // PIN standing alone: untouched. Between spaces it is the PIN: scrubbed.
    const out = await scrubWith([{ name: 'PIN', value: '1234' }], 'in 12345 the code 1234 appears');
    expect(out).toBe(`in 12345 the code ${secretMarker('PIN')} appears`);
  });

  it('buddi env keys with no vault are still scrubbed via the source', async () => {
    const out = await scrubWith([{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-live-abc123' }],
      'error: request to api.anthropic.com failed with key sk-ant-live-abc123');
    expect(out).toBe(`error: request to api.anthropic.com failed with key ${secretMarker('ANTHROPIC_API_KEY')}`);
  });

  it('no source configured: identity', () => {
    setSecretScrubSource(null);
    expect(scrubText('nothing to see')).toBe('nothing to see');
  });
});

describe('scrubDeep', () => {
  it('walks objects, arrays and keys, and leaves non-JSON objects alone', async () => {
    setSecretScrubSource(async () => [{ name: 'S', value: 'sekret' }]);
    await primeSecretScrubber();
    const date = new Date(0);
    const out = scrubDeep({
      nested: { text: 'a sekret here', list: ['plain', 'sekret again'] },
      when: date,
      count: 3,
    });
    expect(out).toEqual({
      nested: { text: `a ${secretMarker('S')} here`, list: ['plain', `${secretMarker('S')} again`] },
      when: date,
      count: 3,
    });
    setSecretScrubSource(null);
  });
});

describe('findSecretMatches', () => {
  it('names what a text contains, with counts, never a value', async () => {
    setSecretScrubSource(async () => [
      { name: 'PNC password', value: 'hunter2-pass' },
      { name: 'API token', value: 'abcd-efgh' },
    ]);
    await primeSecretScrubber();
    expect(findSecretMatches('hunter2-pass and abcd-efgh and hunter2-pass')).toEqual([
      { name: 'API token', count: 1 },
      { name: 'PNC password', count: 2 },
    ]);
    setSecretScrubSource(null);
  });
});