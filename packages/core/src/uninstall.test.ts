import { describe, expect, it } from 'vitest';
import { clearTelegramMenu, purgeKeychain } from './uninstall.js';

describe('purgeKeychain', () => {
  it('deletes each name and the index, treating missing as gone', async () => {
    const calls: string[] = [];
    await purgeKeychain('buddi.install.x', ['A', 'B'], async (args) => {
      calls.push(args.join(' '));
      return { code: args.includes('B') ? 44 : 0, stdout: '', stderr: '' };
    });
    expect(calls).toEqual([
      'delete-generic-password -s buddi.install.x -a A',
      'delete-generic-password -s buddi.install.x -a B',
      'delete-generic-password -s buddi.install.x -a buddi.index',
    ]);
  });

  it('names what a locked keychain refused, never a value', async () => {
    await expect(purgeKeychain('buddi', ['A'], async () => ({ code: 51, stdout: '', stderr: '' })))
      .rejects.toThrow(/refused to delete A \(security exit 51\), buddi\.index \(security exit 51\)/);
  });
});

describe('clearTelegramMenu', () => {
  it('empties the default scope and each paired chat', async () => {
    const bodies: unknown[] = [];
    await clearTelegramMenu('123:abc', ['42'], async (url, init) => {
      expect(url).toBe('https://api.telegram.org/bot123:abc/setMyCommands');
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    });
    expect(bodies).toEqual([
      { commands: [], scope: { type: 'default' } },
      { commands: [], scope: { type: 'chat', chat_id: '42' } },
    ]);
  });
});
