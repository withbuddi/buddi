import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from './args.js';

describe('parseArgs', () => {
  it('treats no arguments as help', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['help'])).toEqual({ kind: 'help' });
  });

  it('hands chat, ask and agents to the gateway CLI with the command word intact', () => {
    expect(parseArgs(['chat', '--last'])).toEqual({ kind: 'chat-cli', argv: ['chat', '--last'] });
    expect(parseArgs(['ask', 'can I afford a bike?', '--resume', 'abc'])).toEqual({
      kind: 'chat-cli',
      argv: ['ask', 'can I afford a bike?', '--resume', 'abc'],
    });
    expect(parseArgs(['agents'])).toEqual({ kind: 'chat-cli', argv: ['agents'] });
  });

  it('strips the command word from a missions invocation', () => {
    expect(parseArgs(['missions', 'run-now', 'friday-recap', '--inline'])).toEqual({
      kind: 'missions',
      argv: ['run-now', 'friday-recap', '--inline'],
    });
    expect(parseArgs(['missions'])).toEqual({ kind: 'missions', argv: [] });
  });

  it('parses the standalone commands', () => {
    expect(parseArgs(['serve'])).toEqual({ kind: 'serve' });
    expect(parseArgs(['init'])).toEqual({ kind: 'init' });
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor' });
    expect(parseArgs(['migrate'])).toEqual({ kind: 'migrate' });
  });

  it('parses every service action', () => {
    for (const action of ['install', 'uninstall', 'status', 'logs', 'restart'] as const) {
      expect(parseArgs(['service', action])).toEqual({ kind: 'service', action });
    }
  });

  it('refuses a service action it does not have', () => {
    expect(() => parseArgs(['service'])).toThrow(UsageError);
    expect(() => parseArgs(['service', 'start'])).toThrow(/unknown service action/);
    expect(() => parseArgs(['service', 'status', 'extra'])).toThrow(/unexpected argument/);
  });

  it('parses telegram pair and devices', () => {
    expect(parseArgs(['telegram', 'pair'])).toEqual({ kind: 'telegram', action: 'pair' });
    expect(parseArgs(['telegram', 'devices'])).toEqual({ kind: 'telegram', action: 'devices' });
  });

  it('requires a device id to unpair', () => {
    expect(parseArgs(['telegram', 'unpair', 'dev-1'])).toEqual({
      kind: 'telegram',
      action: 'unpair',
      deviceId: 'dev-1',
    });
    expect(() => parseArgs(['telegram', 'unpair'])).toThrow(/needs a device id/);
  });

  it('rejects an unknown command rather than guessing one', () => {
    expect(() => parseArgs(['chatt'])).toThrow(/unknown command: chatt/);
    expect(() => parseArgs(['serve', '--port', '3000'])).toThrow(/takes no arguments/);
  });
});
