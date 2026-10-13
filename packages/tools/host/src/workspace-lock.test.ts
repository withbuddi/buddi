/**
 * The owner's save into a workspace holds every workspace: a command in any
 * conversation, whatever its cwd, waits until the save is done; and a save
 * can tell that a command is running anywhere, to refuse while one is.
 */
import { describe, expect, it } from 'vitest';
import { commandsRunning, enterWorkspace, holdWorkspaces } from './service.js';

describe('the workspace lock', () => {
  it('makes a command from any conversation wait for a save, then counts it as running', async () => {
    let entered = false;
    let leave: (() => void) | null = null;
    await holdWorkspaces(async () => {
      void enterWorkspace().then((out) => { entered = true; leave = out; });
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      expect(entered).toBe(false);
      expect(commandsRunning()).toBe(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(entered).toBe(true);
    expect(commandsRunning()).toBe(1);
    leave!();
    // Leaving twice counts once.
    leave!();
    expect(commandsRunning()).toBe(0);
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
