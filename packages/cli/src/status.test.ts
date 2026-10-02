/**
 * `buddi status`: every part read on its own, and a part that cannot be read
 * costs one line, never the report.
 */
import { describe, expect, it } from 'vitest';
import { collectStatus, renderStatus, type StatusSources } from './status.js';

function sources(over: Partial<StatusSources> = {}): StatusSources {
  return {
    install: 'checkout',
    version: async () => '0.1.0 (abc1234-dirty)',
    service: async () => ({ state: 'running', detail: 'running since Fri Sep 25 09:00:00 2026' }),
    probeDatabase: async () => {},
    describeDatabaseError: (err) => (err instanceof Error ? err.message : String(err)),
    agents: async () => [
      { handle: 'buddi', id: 'concierge', available: true },
      { handle: 'scout', id: 'scout', available: false, reason: 'environment variable OPENAI_API_KEY is not set' },
    ],
    needsYou: async () => 3,
    lastRecapAt: async () => new Date('2026-09-20T22:00:00Z'),
    update: async () => ({ available: true, latest: '0.2.0' }),
    ...over,
  };
}

describe('collectStatus', () => {
  it('reads every part', async () => {
    const report = await collectStatus(sources());
    expect(report).toMatchObject({
      version: '0.1.0 (abc1234-dirty)',
      install: 'checkout',
      service: { state: 'running' },
      database: { reachable: true },
      agents: { ready: [{ handle: 'buddi', id: 'concierge' }], unavailable: [{ handle: 'scout' }] },
      needsYou: 3,
      lastRecapAt: '2026-09-20T22:00:00.000Z',
      update: { available: true, latest: '0.2.0' },
    });
  });

  it('never throws: a database that is down leaves what needs no database', async () => {
    const report = await collectStatus(
      sources({
        probeDatabase: async () => {
          throw new Error('connection refused');
        },
        service: async () => {
          throw new Error('launchctl is missing');
        },
        agents: async () => {
          throw new Error('no agents directory');
        },
        needsYou: async () => {
          throw new Error('should not be asked');
        },
      }),
    );
    expect(report.database).toEqual({ reachable: false, error: 'connection refused' });
    expect(report.service).toEqual({ state: 'unknown', detail: 'launchctl is missing' });
    expect(report.agents.error).toBe('no agents directory');
    expect(report.needsYou).toBeNull();
    expect(report.lastRecapAt).toBeNull();
  });
});

describe('renderStatus', () => {
  it('says each part in a short sentence', async () => {
    const text = renderStatus(await collectStatus(sources()), 'UTC');
    expect(text.split('\n')).toEqual([
      'buddi 0.1.0 (abc1234-dirty), a source checkout.',
      'The service is running since Fri Sep 25 09:00:00 2026.',
      'The database is reachable.',
      '1 agent can run: @buddi.',
      '@scout cannot run: environment variable OPENAI_API_KEY is not set.',
      '3 things need you. Open the dashboard with buddi.',
      'The last recap went out 2026-09-20 22:00 UTC.',
      'A newer buddi is available: 0.2.0. Run buddi upgrade.',
    ]);
  });

  it('says what to do when the service is not there', async () => {
    const checkout = renderStatus(await collectStatus(sources({ service: async () => ({ state: 'not-installed', detail: 'not installed' }) })));
    expect(checkout).toContain('The service is not installed. Run buddi service install.');
    const packaged = renderStatus(
      await collectStatus(sources({ install: 'packaged', service: async () => ({ state: 'not-installed', detail: 'x' }) })),
    );
    expect(packaged).toContain('The service is not running. Run buddi to start it.');
  });

  it('says nothing needs you when nothing does', async () => {
    const text = renderStatus(await collectStatus(sources({ needsYou: async () => 0 })));
    expect(text).toContain('Nothing needs you.');
    expect(renderStatus(await collectStatus(sources({ needsYou: async () => 1 })))).toContain('1 thing needs you.');
  });

  it("reads the dashboard's one count, asking the gateway only while the service runs", async () => {
    const asked: boolean[] = [];
    const needsYou = async ({ serviceRunning }: { serviceRunning: boolean }) => {
      asked.push(serviceRunning);
      return serviceRunning ? 5 : 2;
    };
    expect((await collectStatus(sources({ needsYou }))).needsYou).toBe(5);
    const stopped = await collectStatus(sources({ needsYou, service: async () => ({ state: 'stopped', detail: 'x' }) }));
    expect(stopped.needsYou).toBe(2);
    expect(asked).toEqual([true, false]);
    // A count that cannot be read costs one line.
    const failed = await collectStatus(sources({ needsYou: async () => { throw new Error('boom'); } }));
    expect(renderStatus(failed)).toContain('What needs you could not be read.');
  });
});

describe('Ollama Cloud with a device key', () => {
  it('says who the device is connected as, and asks nothing without the database', async () => {
    const report = await collectStatus(sources({ ollama: async () => [{ label: 'Ollama Cloud', line: 'connected as amen, device buddi on studio' }] }));
    expect(report.ollama).toEqual([{ label: 'Ollama Cloud', line: 'connected as amen, device buddi on studio' }]);
    expect(renderStatus(report)).toContain('Ollama Cloud: connected as amen, device buddi on studio.');
    const down = await collectStatus(sources({
      probeDatabase: async () => { throw new Error('down'); },
      ollama: async () => { throw new Error('should not be asked'); },
    }));
    expect(down.ollama).toEqual([]);
  });
});
