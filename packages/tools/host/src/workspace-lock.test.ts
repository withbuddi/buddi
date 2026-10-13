/**
 * The owner's save into a workspace holds every workspace: a command in any
 * conversation, whatever its cwd, waits until the save is done.
 */
import { describe, expect, it } from 'vitest';
import { enterWorkspace, holdWorkspaces, hostWorkspaceKey, workspaceBusy } from './service.js';

describe('the workspace lock', () => {
  it('makes a command from another conversation wait for a save, then lets it in', async () => {
    const here = hostWorkspaceKey('owner', 'scout', 'conversation-a');
    const there = hostWorkspaceKey('owner', 'ledger', 'conversation-b');
    let entered = false;
    let leave: (() => void) | null = null;
    await holdWorkspaces(async () => {
      void enterWorkspace(there).then((out) => { entered = true; leave = out; });
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      expect(entered).toBe(false);
      expect(workspaceBusy(here)).toBe(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(entered).toBe(true);
    expect(workspaceBusy(there)).toBe(true);
    leave!();
    expect(workspaceBusy(there)).toBe(false);
  });

  it('lets a second save wait for the first', async () => {
    const order: string[] = [];
    await Promise.all([
      holdWorkspaces(async () => { order.push('a+'); await new Promise((resolve) => setTimeout(resolve, 5)); order.push('a-'); }),
      holdWorkspaces(async () => { order.push('b+'); order.push('b-'); }),
    ]);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-']);
  });
});
