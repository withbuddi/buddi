/**
 * The dev loop's one decision: restart it, or say to restart it.
 *
 * Tested through `onRebuilt` rather than through the watcher, because a file
 * system event is the least interesting half and the noisiest to arrange. What
 * matters is that a supervised installation gets a real restart, that a
 * checkout is told the truth about plugins loading at start, and that a failed
 * restart degrades into the same sentence instead of a stack trace.
 */
import { describe, expect, it } from 'vitest';
import { assertBuilt, onRebuilt, type DevDeps } from './dev.js';

function recorder(over: Partial<DevDeps> = {}): { deps: DevDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      log: (line) => lines.push(line),
      serviceRunning: async () => false,
      restart: async () => 'restarted',
      ...over,
    },
  };
}

describe('onRebuilt', () => {
  it('restarts the service when there is one running', async () => {
    let restarted = false;
    const { deps, lines } = recorder({
      serviceRunning: async () => true,
      restart: async () => {
        restarted = true;
        return 'buddi: restarted';
      },
    });
    expect(await onRebuilt(deps, 'weather')).toBe('restarted');
    expect(restarted).toBe(true);
    expect(lines.join('\n')).toContain('buddi: restarted');
  });

  it('tells the developer to restart when there is no service', async () => {
    const { deps, lines } = recorder();
    expect(await onRebuilt(deps, 'weather')).toBe('told');
    expect(lines.join('\n')).toMatch(/loaded once, at start/);
    expect(lines.join('\n')).toMatch(/restart buddi/i);
  });

  it('degrades to the same sentence when the restart fails', async () => {
    const { deps, lines } = recorder({
      serviceRunning: async () => true,
      restart: async () => {
        throw new Error('launchctl: no such unit');
      },
    });
    expect(await onRebuilt(deps, 'weather')).toBe('told');
    expect(lines.join('\n')).toContain('launchctl: no such unit');
    expect(lines.join('\n')).toMatch(/Restart buddi yourself/);
  });
});

describe('assertBuilt', () => {
  it('refuses a directory with no dist, naming what to run', () => {
    expect(() => assertBuilt('/definitely/not/a/plugin')).toThrow(/pnpm build/);
  });
});
