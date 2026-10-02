/**
 * `buddi agents catalogue|add|update|remove`: the words, and the routes they
 * go through with the plan printed before anything changes.
 */
import { describe, expect, it } from 'vitest';
import { CatalogueUsage, parseCatalogueArgs, runAgentsCatalogue, type CatalogueGateway } from './agents-catalogue-cmd.js';

describe('the words', () => {
  it('reads add with picks, missions and a handle', () => {
    expect(parseCatalogueArgs(['add', 'Chef', '--fill', 'diet=no pork, no peanuts', '--mission', 'sunday-plan', '--handle', '@cook', '--yes'])).toEqual({
      action: 'add',
      name: 'chef',
      yes: true,
      json: false,
      handle: 'cook',
      fills: { diet: 'no pork, no peanuts' },
      missions: ['sunday-plan'],
    });
    expect(parseCatalogueArgs(['catalogue', '--json'])).toEqual({ action: 'catalogue', json: true, refresh: false });
    expect(parseCatalogueArgs(['update', '@planner', '--replace'])).toMatchObject({ action: 'update', agent: 'planner', replace: true });
    expect(parseCatalogueArgs(['remove', 'chef', '-y'])).toMatchObject({ action: 'remove', agent: 'chef', yes: true });
  });

  it('refuses what it does not know', () => {
    expect(() => parseCatalogueArgs(['add'])).toThrow(CatalogueUsage);
    expect(() => parseCatalogueArgs(['add', 'chef', '--fill', 'nope'])).toThrow(/pick/);
    expect(() => parseCatalogueArgs(['remove', 'chef', '--replace'])).toThrow(/unknown option/);
  });
});

function gateway(answers: Record<string, unknown>, posted: Array<{ path: string; body: unknown }>): CatalogueGateway {
  return {
    async get<T>(path: string) {
      if (!(path in answers)) throw new Error(`unexpected GET ${path}`);
      return answers[path] as T;
    },
    async post<T>(path: string, body: unknown) {
      posted.push({ path, body });
      return { status: path.endsWith('/install') ? 202 : 200, body: answers[`POST ${path}`] as T };
    },
  };
}

describe('adding', () => {
  const plan = {
    title: 'Chef',
    version: '1.0.0',
    handle: 'chef',
    plugins: [{ title: 'Weather', version: '0.1.4' }],
    blocked: [],
    fills: [{ id: 'diet', label: "Anything you don't eat?", value: '', kind: 'text' }],
    missions: [{ id: 'sunday-plan', name: 'Sunday meal plan', enabled: false }],
    preview: 'Add Chef 1.0.0 from the catalogue (made by buddi).',
  };

  it('prints the plan and changes nothing without a terminal or --yes', async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    const out: string[] = [];
    const code = await runAgentsCatalogue(
      { action: 'add', name: 'chef', yes: false, json: false, fills: {}, missions: [] },
      { gateway: gateway({ 'POST /api/catalogue/chef/plan': plan }, posted), io: { out: (l) => void out.push(l), interactive: false } },
    );
    expect(code).toBe(0);
    expect(posted.map((p) => p.path)).toEqual(['/api/catalogue/chef/plan']);
    expect(out.join('\n')).toContain('Installs on the way: Weather 0.1.4');
    expect(out.join('\n')).toContain('Nothing was changed. To approve it, run: buddi agents add chef --yes');
  });

  it('adds it with --yes and follows the job', async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    const out: string[] = [];
    const code = await runAgentsCatalogue(
      { action: 'add', name: 'chef', yes: true, json: false, fills: { diet: 'no pork' }, missions: [] },
      {
        gateway: gateway(
          {
            'POST /api/catalogue/chef/plan': plan,
            'POST /api/catalogue/chef/install': { jobId: 'j1' },
            '/api/catalogue/jobs/j1': { state: 'done', steps: [], agent: { handle: 'chef', name: 'Chef' } },
          },
          posted,
        ),
        io: { out: (l) => void out.push(l), sleep: async () => {} },
      },
    );
    expect(code).toBe(0);
    expect(posted[1]).toEqual({ path: '/api/catalogue/chef/install', body: { version: '1.0.0', fills: { diet: 'no pork' }, missionsOn: [] } });
    expect(out.at(-1)).toBe('Chef is on your team: @chef.');
  });

  it('says so when the dashboard is off', async () => {
    const err: string[] = [];
    const code = await runAgentsCatalogue({ action: 'catalogue', json: false, refresh: false }, { gateway: { off: 'The dashboard is off.' }, io: { err: (l) => void err.push(l) } });
    expect(code).toBe(3);
    expect(err).toEqual(['The dashboard is off.']);
  });
});
