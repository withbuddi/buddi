import { describe, expect, it } from 'vitest';
import { knownSecrets, redact, redactText, REDACTED } from './secrets.js';

describe('redact', () => {
  it('cuts credential fields but keeps their states', () => {
    expect(redact({ token: 'abc123secret', configured: true, refreshToken: null, apiKey: '', key: 'tone' })).toEqual({
      token: REDACTED,
      configured: true,
      refreshToken: null,
      apiKey: '',
      key: 'tone',
    });
    expect(redact({ credentials: { token: 'x', connected: true } })).toEqual({ credentials: { connected: true } });
  });

  it('cuts credential shapes anywhere in text', () => {
    const text = redactText(
      'key sk-ant-api03-abcdefghijklmnop, bot 123456789:AAHabcdefghijklmnopqrstuvwxyz0123456, ' +
        'Authorization: Bearer abcdefgh12345678, url postgres://buddi:s3cretpass@db:5432/buddi',
    );
    expect(text).not.toMatch(/sk-ant-api03|AAHabc|abcdefgh12345678|s3cretpass/);
    expect(text).toContain('postgres://buddi:[redacted]@db:5432/buddi');
  });

  it('cuts the values of credential variables, and leaves configuration alone', () => {
    const known = knownSecrets({ GMAIL_APP_PASSWORD: 'plainvaultvalue', BUDDI_WEB_PORT: '4317', TOKEN_TTL: '86400000', ANTHROPIC_API_KEY_FILE: '/x/y' });
    expect(known).toEqual(['plainvaultvalue']);
    expect(redactText('the password is plainvaultvalue on port 4317', known)).toBe(`the password is ${REDACTED} on port 4317`);
  });
});
