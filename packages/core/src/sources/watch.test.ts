/**
 * Source watchers (`Source.watch`): started once, stopped when their plugin
 * goes or is replaced, stopped for good by `stopAll`.
 */
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { PluginManifest, Source, SourceContext } from '../tools.js';
import { createSourceWatches } from './watch.js';

function manifestWith(name: string, sources: Source[]): PluginManifest {
  return { name, version: '0.0.1', schema: name, migrationsDir: '/nowhere', tools: [], sources };
}

function watched(id: string, events: string[]): Source & { ctxs: SourceContext[] } {
  const ctxs: SourceContext[] = [];
  return {
    id,
    description: id,
    every: 60,
    async poll() {},
    ctxs,
    watch(ctx) {
      ctxs.push(ctx);
      events.push(`start ${id}`);
      return {
        async stop() {
          events.push(`stop ${id}`);
        },
      };
    },
  };
}

const input = { now: () => new Date(), timezone: 'UTC', enqueueRun: async () => {}, log: () => {} };

describe('createSourceWatches', () => {
  it('starts each watcher once, with a live clock, and stops it when its plugin goes', async () => {
    const events: string[] = [];
    const a = watched('a.inbox', events);
    const plain: Source = { id: 'b.poll', description: 'b', every: 60, async poll() {} };
    const watches = createSourceWatches({} as Pool);
    const manifests = [manifestWith('a', [a]), manifestWith('b', [plain])];
    await watches.reconcile(manifests, input);
    await watches.reconcile(manifests, input);
    expect(events).toEqual(['start a.inbox']);
    expect(watches.running()).toEqual(['a.inbox']);
    const first = a.ctxs[0]!.buddi!.clock.now().getTime();
    await new Promise((r) => setTimeout(r, 5));
    expect(a.ctxs[0]!.buddi!.clock.now().getTime()).toBeGreaterThan(first);

    await watches.reconcile([manifestWith('b', [plain])], input);
    expect(events).toEqual(['start a.inbox', 'stop a.inbox']);
    expect(watches.running()).toEqual([]);
  });

  it('restarts a watcher whose plugin was reloaded, and starts nothing after stopAll', async () => {
    const events: string[] = [];
    const watches = createSourceWatches({} as Pool);
    await watches.reconcile([manifestWith('a', [watched('a.inbox', events)])], input);
    await watches.reconcile([manifestWith('a', [watched('a.inbox', events)])], input);
    expect(events).toEqual(['start a.inbox', 'stop a.inbox', 'start a.inbox']);
    await watches.stopAll();
    await watches.reconcile([manifestWith('a', [watched('a.inbox', events)])], input);
    expect(events).toEqual(['start a.inbox', 'stop a.inbox', 'start a.inbox', 'stop a.inbox']);
  });

  it('a watcher that throws on start is logged and tried again next tick', async () => {
    const lines: string[] = [];
    let tries = 0;
    const flaky: Source = {
      id: 'c.flaky',
      description: 'c',
      every: 60,
      async poll() {},
      watch() {
        tries += 1;
        if (tries === 1) throw new Error('boom');
        return { async stop() {} };
      },
    };
    const watches = createSourceWatches({} as Pool);
    await watches.reconcile([manifestWith('c', [flaky])], { ...input, log: (l: string) => lines.push(l) });
    expect(lines.some((l) => /did not start: boom/.test(l))).toBe(true);
    await watches.reconcile([manifestWith('c', [flaky])], input);
    expect(watches.running()).toEqual(['c.flaky']);
    await watches.stopAll();
  });
  it('a second stopAll (the signal handler, then finally) waits for the same stops', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stoppedWatcher = false;
    const slow: Source = {
      id: 'a.slow',
      description: 'slow',
      every: 60,
      async poll() {},
      watch() {
        return {
          async stop() {
            await gate;
            stoppedWatcher = true;
          },
        };
      },
    };
    const watches = createSourceWatches({} as Pool);
    await watches.reconcile([manifestWith('a', [slow])], input);
    const first = watches.stopAll();
    let secondDone = false;
    const second = watches.stopAll().then(() => {
      secondDone = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(secondDone).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(stoppedWatcher).toBe(true);
  });

  it('stopAll waits for a stop a reconcile already began', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stoppedWatcher = false;
    const slow: Source = {
      id: 'a.slow',
      description: 'slow',
      every: 60,
      async poll() {},
      watch() {
        return {
          async stop() {
            await gate;
            stoppedWatcher = true;
          },
        };
      },
    };
    const watches = createSourceWatches({} as Pool);
    await watches.reconcile([manifestWith('a', [slow])], input);
    const reconciling = watches.reconcile([], input);
    let allDone = false;
    const all = watches.stopAll().then(() => {
      allDone = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(allDone).toBe(false);
    release();
    await Promise.all([reconciling, all]);
    expect(stoppedWatcher).toBe(true);
  });
});
