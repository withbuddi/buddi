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

  it('hands the reminders slice to the gateway, command word stripped', () => {
    expect(parseArgs(['reminders'])).toEqual({ kind: 'reminders', argv: [] });
    expect(parseArgs(['reminders', '--agent', 'credit-coach'])).toEqual({
      kind: 'reminders',
      argv: ['--agent', 'credit-coach'],
    });
    expect(parseArgs(['reminders', 'cancel', 'r-1'])).toEqual({
      kind: 'reminders',
      argv: ['cancel', 'r-1'],
    });
  });

  it('parses the standalone commands', () => {
    expect(parseArgs(['serve'])).toEqual({ kind: 'serve' });
    expect(parseArgs(['init'])).toEqual({ kind: 'init' });
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor' });
    expect(parseArgs(['migrate'])).toEqual({ kind: 'migrate' });
  });

  it('parses every service action, start and stop included', () => {
    for (const action of [
      'install',
      'uninstall',
      'start',
      'stop',
      'status',
      'logs',
      'restart',
    ] as const) {
      expect(parseArgs(['service', action])).toEqual({ kind: 'service', action });
    }
    expect(() => parseArgs(['service', 'begin'])).toThrow(/unknown service action: begin/);
  });

  it('refuses a service action it does not have', () => {
    expect(() => parseArgs(['service'])).toThrow(UsageError);
    expect(() => parseArgs(['service', 'begin'])).toThrow(/unknown service action/);
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

  it('parses the pause control', () => {
    expect(parseArgs(['pause'])).toEqual({ kind: 'pause' });
    expect(parseArgs(['resume'])).toEqual({ kind: 'resume' });
    expect(() => parseArgs(['pause', 'now'])).toThrow(/takes no arguments/);
  });

  it('lists jobs, with filters', () => {
    expect(parseArgs(['jobs'])).toEqual({ kind: 'jobs', action: 'list' });
    expect(parseArgs(['jobs', '--state', 'failed', '--limit', '5'])).toEqual({
      kind: 'jobs',
      action: 'list',
      state: 'failed',
      limit: 5,
    });
    expect(parseArgs(['jobs', '--kind', 'mission-run'])).toEqual({
      kind: 'jobs',
      action: 'list',
      kind_: 'mission-run',
    });
  });

  it('refuses a job state or limit it cannot mean', () => {
    expect(() => parseArgs(['jobs', '--state', 'running'])).toThrow(/unknown job state/);
    expect(() => parseArgs(['jobs', '--limit', 'lots'])).toThrow(/positive integer/);
    expect(() => parseArgs(['jobs', '--state'])).toThrow(/needs a value/);
    expect(() => parseArgs(['jobs', '--everything'])).toThrow(/unknown option/);
  });

  it('parses the two job verbs that take an id', () => {
    expect(parseArgs(['jobs', 'retry', 'abc123'])).toEqual({
      kind: 'jobs',
      action: 'retry',
      jobId: 'abc123',
    });
    expect(parseArgs(['jobs', 'cancel', 'abc123'])).toEqual({
      kind: 'jobs',
      action: 'cancel',
      jobId: 'abc123',
    });
    expect(() => parseArgs(['jobs', 'retry'])).toThrow(/needs a job id/);
  });

  it('rejects an unknown command rather than guessing one', () => {
    expect(() => parseArgs(['chatt'])).toThrow(/unknown command: chatt/);
    expect(() => parseArgs(['serve', '--port', '3000'])).toThrow(/takes no arguments/);
  });
});

describe('buddi vault', () => {
  it('parses the actions that name a secret', () => {
    expect(parseArgs(['vault', 'set', 'TELEGRAM_BOT_TOKEN'])).toEqual({
      kind: 'vault',
      action: 'set',
      name: 'TELEGRAM_BOT_TOKEN',
    });
    expect(parseArgs(['vault', 'list'])).toEqual({ kind: 'vault', action: 'list' });
    expect(parseArgs(['vault', 'import-env'])).toEqual({ kind: 'vault', action: 'import-env' });
  });

  it('refuses a missing name, an unknown action, and a value on the command line', () => {
    expect(() => parseArgs(['vault'])).toThrow(UsageError);
    expect(() => parseArgs(['vault', 'set'])).toThrow(/needs a secret name/);
    expect(() => parseArgs(['vault', 'peek', 'A'])).toThrow(/unknown vault action/);
    // A secret is never an argument: it would land in shell history.
    expect(() => parseArgs(['vault', 'set', 'A_KEY', 'the-secret'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['vault', 'list', 'A_KEY'])).toThrow(/unexpected argument/);
  });
});


describe('buddi db', () => {
  it('parses the three container actions', () => {
    for (const action of ['up', 'down', 'status'] as const) {
      expect(parseArgs(['db', action])).toEqual({ kind: 'db', action });
    }
  });

  it('names the actions it accepts instead of guessing one', () => {
    expect(() => parseArgs(['db'])).toThrow(/buddi db needs one of: up, down, status/);
    expect(() => parseArgs(['db', 'start'])).toThrow(/unknown db action: start/);
    expect(() => parseArgs(['db', 'up', 'postgres'])).toThrow(/unexpected argument/);
  });
});

describe('buddi status', () => {
  it('is the doctor under the name a person reaches for', () => {
    expect(parseArgs(['status'])).toEqual({ kind: 'doctor' });
    expect(parseArgs(['doctor'])).toEqual({ kind: 'doctor' });
  });
});

describe('dashboard', () => {
  it('opens by default, and has exactly two flags', () => {
    expect(parseArgs(['dashboard'])).toEqual({ kind: 'dashboard', action: 'open' });
    expect(parseArgs(['dashboard', '--token'])).toEqual({ kind: 'dashboard', action: 'token' });
    expect(parseArgs(['dashboard', '--off'])).toEqual({ kind: 'dashboard', action: 'off' });
  });

  it('refuses anything else', () => {
    expect(() => parseArgs(['dashboard', '--open'])).toThrow(UsageError);
    expect(() => parseArgs(['dashboard', '--token', 'extra'])).toThrow(UsageError);
  });
});
