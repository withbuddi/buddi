/**
 * A plugin package for the lifecycle suite — a *real* one, on disk, imported
 * the way an installed plugin is imported.
 *
 * It exists rather than the weather example being used because the suite
 * migrates and drops a schema, and a suite that dropped `weather` would destroy
 * the data of any owner who had actually installed the weather plugin. So this
 * fixture owns a schema whose name nobody would ever choose for real.
 *
 * It is plain JavaScript because that is what an installed plugin is: the thing
 * a `main` points at, already built.
 */
import { z } from 'zod';

export const manifest = {
  name: 'testplug',
  version: '2.0.0',
  description: 'A plugin that exists to be installed and removed.',
  schema: 'buddi_fixture_testplug',
  migrationsDir: new URL('./migrations', import.meta.url).pathname,
  tools: [
    {
      name: 'testplug.ping',
      description: 'Returns pong. Reads nothing and writes nothing.',
      tier: 'auto',
      input: z.object({}).strict(),
      async execute() {
        return { pong: true };
      },
    },
  ],
  missions: [
    {
      id: 'testplug-daily',
      name: 'Test plugin daily',
      agentRole: 'overview',
      cron: '0 9 * * *',
      prompt: 'call testplug.ping',
    },
  ],
  agents: [
    {
      id: 'pinger',
      handle: 'pinger',
      name: 'Pinger',
      description: 'Says pong.',
      persona: 'You are the pinger. You call the ping tool and report what it said.',
      tools: ['testplug.*'],
    },
  ],
  network: [{ host: 'example.invalid', why: 'nothing; it is declared to be read' }],
};

export default manifest;
