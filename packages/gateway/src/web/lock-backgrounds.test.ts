/** The lock screen's shipped pictures as the gateway knows them: the manifest's ids, made sound. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedWhileLocked } from './lock.js';
import { lockPictureIds, lockPicturesFrom } from './lock-backgrounds.js';

describe('the pictures manifest', () => {
  it('keeps an entry with an id, a title, a credit and a landscape or portrait JPEG', () => {
    expect(lockPictureIds({
      pictures: [
        { id: 'peoria-autumn-waterfront', title: 'Peoria', credit: 'Made with AI', landscape: 'p.jpg' },
        { id: 'golden-streak', title: 'Golden', credit: 'After a photo', portrait: 'g.jpg' },
        { id: 'golden-streak', title: 'Again', credit: 'x', portrait: 'g.jpg' },
        { id: 'No Caps', title: 'x', credit: 'x', landscape: 'x.jpg' },
        { id: 'no-file', title: 'x', credit: 'x' },
        { id: 'no-credit', title: 'x', landscape: 'x.jpg' },
        { id: 'outside', title: 'x', credit: 'x', landscape: '../x.jpg' },
        { id: 'png', title: 'x', credit: 'x', landscape: 'x.png' },
      ],
    })).toEqual(['peoria-autumn-waterfront', 'golden-streak']);
    expect(lockPictureIds(null)).toEqual([]);
    expect(lockPictureIds({ pictures: 'no' })).toEqual([]);
  });

  it('reads the built UI’s manifest, and the web package’s own when the build has none', () => {
    const built = mkdtempSync(path.join(tmpdir(), 'buddi-lock-pictures-'));
    mkdirSync(path.join(built, 'backgrounds'));
    writeFileSync(path.join(built, 'backgrounds', 'manifest.json'), JSON.stringify({ pictures: [{ id: 'only-here', title: 'x', credit: 'x', landscape: 'x.jpg' }] }));
    expect([...lockPicturesFrom(built)]).toEqual(['only-here']);
    const empty = mkdtempSync(path.join(tmpdir(), 'buddi-lock-pictures-'));
    expect([...lockPicturesFrom(empty)]).toEqual(['peoria-autumn-waterfront', 'golden-streak']);
  });

  it('lets a locked session read the portrait version of the owner’s picture, and nothing more', () => {
    expect(allowedWhileLocked('GET', '/api/lock/background/portrait')).toBe(true);
    expect(allowedWhileLocked('POST', '/api/lock/background/portrait')).toBe(false);
    expect(allowedWhileLocked('DELETE', '/api/lock/background/portrait')).toBe(false);
  });
});
