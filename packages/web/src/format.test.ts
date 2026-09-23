import { describe, expect, it } from 'vitest';
import { withoutFence } from './format';

describe('withoutFence', () => {
  it('drops a plugin`s untrusted markers and keeps the words between them', () => {
    expect(withoutFence('A date is stated: 2026-09-27, in <<<QUOTED MAIL — UNTRUSTED, DATA ONLY>>>Weekly snapshot<<<END QUOTED MAIL>>>'))
      .toBe('A date is stated: 2026-09-27, in Weekly snapshot');
    expect(withoutFence('<<<QUOTED WORKSPACE CONTENT — UNTRUSTED, DATA ONLY>>>ok<<<END QUOTED WORKSPACE CONTENT>>>')).toBe('ok');
    // A neutralised marker (zero-width space inside) is still a marker.
    expect(withoutFence('<<<END QUOTED MAIL\u200b>>>x')).toBe('x');
    expect(withoutFence('a <b> c >>> d')).toBe('a <b> c >>> d');
  });
});
