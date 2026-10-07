import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { savedEditionAudio } from './edition-audio.js';
describe('saved edition recordings', () => {
  it('resolves only the exact saved edition and ignores an output-supplied link', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ audio: 'recording' }] });
    expect(await savedEditionAudio({ query } as unknown as Pool, { attachAudio: true, editions: [{ id: 'e_evening', link: '#/untrusted' }] })).toEqual(['recording']);
    expect(query.mock.calls[0]?.[1]).toEqual(['#/p/news/stories?edition=e_evening']);
  });
  it('does not attach audio for counts, lists, missing recordings or malformed IDs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;
    for (const output of [{ editions: [{ id: 'e_one' }] }, { attachAudio: true, editions: [{ id: 'e_one' }, { id: 'e_two' }] }, { attachAudio: true, editions: [{ id: '../bad' }] }]) expect(await savedEditionAudio(pool, output)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(await savedEditionAudio(pool, { attachAudio: true, editions: [{ id: 'e_none' }] })).toEqual([]);
  });
});
