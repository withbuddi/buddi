import { describe, expect, it } from 'vitest';
import { unlinkSignatures } from './channel.js';

describe('agent signatures on Telegram', () => {
  it('stops Telegram linking "@handle:" to a public account, and changes nothing else', () => {
    expect(unlinkSignatures('@buddi: Hello')).toBe('@⁠buddi: Hello');
    expect(unlinkSignatures('While you were away: 2 things.\n\n- @buddi: Hello\n- buddi: Scheduled work did not run.'))
      .toBe('While you were away: 2 things.\n\n- @⁠buddi: Hello\n- buddi: Scheduled work did not run.');
    // A handle the owner typed in the text, or an address, is left alone.
    expect(unlinkSignatures('Ask @ledger about it; mail me at a@b.co')).toBe('Ask @ledger about it; mail me at a@b.co');
  });
});
