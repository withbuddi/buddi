import { describe, expect, it } from 'vitest';
import { applyEnvEdits, isBlank, maskSecret, parseEnv } from './env-file.js';

describe('parseEnv', () => {
  it('reads keys and ignores comments and blanks', () => {
    expect(parseEnv('# a comment\n\nA=1\nB = two \n')).toEqual({ A: '1', B: 'two' });
  });

  it('strips surrounding quotes, as dotenv does — the vault marker is written quoted', () => {
    expect(parseEnv('TELEGRAM_BOT_TOKEN="<vault>"\nA=\'one\'\n')).toEqual({
      TELEGRAM_BOT_TOKEN: '<vault>',
      A: 'one',
    });
  });

  it('leaves unmatched or inner quotes alone', () => {
    expect(parseEnv('A="half\nB=say "hi"\nC="\n')).toEqual({
      A: '"half',
      B: 'say "hi"',
      C: '"',
    });
  });

  it('keeps an = inside the value', () => {
    expect(parseEnv('DATABASE_URL=postgres://u:p@h:5432/db?x=1')).toEqual({
      DATABASE_URL: 'postgres://u:p@h:5432/db?x=1',
    });
  });
});

describe('isBlank', () => {
  it('is true for missing, empty and whitespace values — what `init` asks about', () => {
    const env = parseEnv('A=\nB=   \nC=set\n');
    expect(isBlank(env, 'A')).toBe(true);
    expect(isBlank(env, 'B')).toBe(true);
    expect(isBlank(env, 'C')).toBe(false);
    expect(isBlank(env, 'MISSING')).toBe(true);
  });
});

describe('applyEnvEdits', () => {
  it('replaces a key in place, keeping order and comments', () => {
    const out = applyEnvEdits('# head\nA=old\nB=keep\n', [{ key: 'A', value: 'new' }]);
    expect(out).toBe('# head\nA=new\nB=keep\n');
  });

  it('uncomments a commented-out key rather than adding a second one', () => {
    const out = applyEnvEdits('# BUDDI_TZ=America/New_York\n', [
      { key: 'BUDDI_TZ', value: 'Europe/Paris' },
    ]);
    expect(out).toBe('BUDDI_TZ=Europe/Paris\n');
    expect(out.match(/BUDDI_TZ/g)).toHaveLength(1);
  });

  it('appends a key the file has never had', () => {
    expect(applyEnvEdits('A=1\n', [{ key: 'B', value: '2' }])).toBe('A=1\n\nB=2\n');
  });

  it('is idempotent: writing the same value twice changes nothing', () => {
    const once = applyEnvEdits('A=1\n', [{ key: 'B', value: '2' }]);
    expect(applyEnvEdits(once, [{ key: 'B', value: '2' }])).toBe(once);
  });

  it('writes the quoted vault marker in place and reads it back unquoted', () => {
    const out = applyEnvEdits('TELEGRAM_BOT_TOKEN=123:abc\n', [
      { key: 'TELEGRAM_BOT_TOKEN', value: '"<vault>"' },
    ]);
    expect(out).toBe('TELEGRAM_BOT_TOKEN="<vault>"\n');
    expect(parseEnv(out)).toEqual({ TELEGRAM_BOT_TOKEN: '<vault>' });
  });

  it('never drops a key the owner added by hand', () => {
    const out = applyEnvEdits('MINE=xyz\nA=1\n', [{ key: 'A', value: '2' }]);
    expect(parseEnv(out)).toEqual({ MINE: 'xyz', A: '2' });
  });
});

describe('maskSecret', () => {
  it('shows the shape and never the secret', () => {
    const masked = maskSecret('sk-ant-oat01-abcdefghijklmnop');
    expect(masked).not.toContain('abcdefghijklmnop');
    expect(masked).toContain('sk-a');
  });
});
