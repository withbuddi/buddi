import { describe, expect, it } from 'vitest';
import { parseApiTokenArgs } from './api-token-cli.js';

describe('buddi api-token arguments', () => {
  it('reads create, list and revoke', () => {
    expect(parseApiTokenArgs(['create', 'home', 'automation'])).toEqual({ action: 'create', name: 'home automation' });
    expect(parseApiTokenArgs([])).toEqual({ action: 'list', json: false });
    expect(parseApiTokenArgs(['list', '--json'])).toEqual({ action: 'list', json: true });
    expect(parseApiTokenArgs(['revoke', '6b2f9c1e'])).toEqual({ action: 'revoke', id: '6b2f9c1e' });
    expect(parseApiTokenArgs(['--help'])).toEqual({ action: 'help' });
  });

  it('says what is wrong', () => {
    expect(() => parseApiTokenArgs(['create'])).toThrow(/needs a name/);
    expect(() => parseApiTokenArgs(['revoke'])).toThrow(/needs one token id/);
    expect(() => parseApiTokenArgs(['create', 'x', '--json'])).toThrow(/Only buddi api-token list takes --json/);
    expect(() => parseApiTokenArgs(['mint'])).toThrow(/not a command/);
  });
});
