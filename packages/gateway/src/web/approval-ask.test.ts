import { describe, expect, it } from 'vitest';
import { ASK_MAX, approvalAsk } from './approval-ask.js';

describe('approvalAsk', () => {
  it('is the preview’s first line, the sentence the tool wrote', () => {
    expect(approvalAsk('calendar.create_event', 'Add to Work (Google)\n"Lunch"\nFri 9 Oct, 13:00')).toBe('Add to Work (Google)');
    expect(approvalAsk('image.generate', 'generate one square image with ChatGPT: "a fox"')).toBe('Generate one square image with ChatGPT: "a fox"');
  });

  it('leaves the registry’s appended reason to the body', () => {
    expect(approvalAsk('demo.double', 'Double one number. — npm install reaches the network.')).toBe('Double one number.');
  });

  it('falls back to the tool’s description when the preview is the id and its JSON', () => {
    expect(approvalAsk('mail.send', 'mail.send {"to":"a@b.c"}', 'Send an email from one of your accounts. Asks first.')).toBe('Send an email from one of your accounts');
    expect(approvalAsk('mail.send', '{"to":"a@b.c"}', 'send an email')).toBe('Send an email');
  });

  it('never answers with the dotted id', () => {
    expect(approvalAsk('mail.send', 'mail.send {"to":"a@b.c"}')).toBe('A mail action needs your approval');
    expect(approvalAsk('mail.send', '', 'mail.send')).toBe('A mail action needs your approval');
    expect(approvalAsk('my_plugin.go', 'my_plugin.go')).toBe('A my plugin action needs your approval');
  });

  it('cuts a long line at a word', () => {
    const ask = approvalAsk('x.y', `Send ${'word '.repeat(60)}`);
    expect(ask.length).toBeLessThanOrEqual(ASK_MAX + 1);
    expect(ask.endsWith('…')).toBe(true);
  });
});
