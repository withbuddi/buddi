import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('reads the ask question and a resume id', () => {
    expect(parseArgs(['ask', 'is it wise?', '--resume', 'abc'])).toEqual({
      command: 'ask',
      question: 'is it wise?',
      resume: 'abc',
      last: false,
    });
  });

  it('ignores the pnpm `--` separator', () => {
    expect(parseArgs(['chat', '--', '--last'])).toMatchObject({
      command: 'chat',
      last: true,
    });
  });

  it('reads --agent', () => {
    expect(parseArgs(['ask', 'q', '--agent', 'concierge'])).toMatchObject({
      command: 'ask',
      question: 'q',
      agent: 'concierge',
    });
  });

  it('leaves the agent unset when no --agent is given', () => {
    expect(parseArgs(['chat']).agent).toBeUndefined();
  });

  it('refuses --agent without a value', () => {
    expect(() => parseArgs(['chat', '--agent'])).toThrow(/agent id/);
  });

  it('parses the agents listing command', () => {
    expect(parseArgs(['agents']).command).toBe('agents');
  });

  it('refuses an unknown option', () => {
    expect(() => parseArgs(['chat', '--wat'])).toThrow(/unknown option/);
  });

  it('refuses --resume without a value', () => {
    expect(() => parseArgs(['ask', 'q', '--resume'])).toThrow(/conversation id/);
  });

  it('falls back to help', () => {
    expect(parseArgs([]).command).toBe('help');
  });
});
