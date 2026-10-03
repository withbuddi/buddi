/**
 * A CLI command reads the agent catalog without printing its notices (an
 * agent's own skill shadowing a shared one) above its output: they go to the
 * debug channel, shown only with BUDDI_DEBUG. `serve` keeps them in its log.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sinks: Array<((line: string) => void) | undefined> = [];
vi.mock('@buddi/core', async (original) => ({
  ...(await original<typeof import('@buddi/core')>()),
  setCatalogNoticeLog: (log: ((line: string) => void) | undefined) => void sinks.push(log),
}));

const { debugLine, dispatch } = await import('./main.js');

afterEach(() => {
  sinks.length = 0;
  vi.restoreAllMocks();
});

describe('catalog notices in a CLI command', () => {
  it('points the catalog notices away from the console before a command runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await dispatch({ kind: 'version' }, { env: {} })).toBe(0);
    expect(sinks).toHaveLength(1);
    sinks[0]!('agents: scout has its own skill "x"; it shadows the shared one');
    expect(err).not.toHaveBeenCalled();
  });

  it('prints them on stderr with BUDDI_DEBUG set, and nowhere without it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugLine({})('quiet');
    debugLine({ BUDDI_DEBUG: '0' })('quiet');
    expect(err).not.toHaveBeenCalled();
    debugLine({ BUDDI_DEBUG: '1' })('shadows the shared one');
    expect(err).toHaveBeenCalledWith('debug: shadows the shared one');
  });
});
