/**
 * `buddi agents catalogue|add|update|remove`: the agent catalogue from the
 * terminal (docs/agents.md, "The catalogue").
 *
 * The catalogue, its install job and the approvals live in the running
 * gateway, so every subcommand goes through the dashboard's own routes
 * (`/api/catalogue…`, `/api/agents/:id/remove`), reached as the owner the way
 * `buddi connections` reaches them. The same plan the install sheet draws is
 * printed first; `--yes` (or a "y" at a terminal) is the owner's approval,
 * exactly as the sheet's button is.
 */
import { GatewayError, GatewayUnavailable, NOT_RUNNING } from './mcp/gateway-client.js';
import { confirmTty } from './vault-cmd.js';

export interface CatalogueGateway {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }>;
}

export type AgentsCatalogueCommand =
  | { action: 'catalogue'; json: boolean; refresh: boolean }
  | { action: 'add'; name: string; yes: boolean; json: boolean; handle?: string; fills: Record<string, string>; missions: string[] }
  | { action: 'update'; agent: string; yes: boolean; json: boolean; replace: boolean }
  | { action: 'remove'; agent: string; yes: boolean; json: boolean };

export const CATALOGUE_ACTIONS = ['catalogue', 'add', 'update', 'remove'] as const;

export class CatalogueUsage extends Error {}

/** `buddi agents <catalogue|add|update|remove> …`, parsed. Throws `CatalogueUsage` on a bad word. */
export function parseCatalogueArgs(argv: readonly string[]): AgentsCatalogueCommand {
  const [action, ...rest] = argv;
  let json = false;
  let yes = false;
  let replace = false;
  let refresh = false;
  let handle: string | undefined;
  const fills: Record<string, string> = {};
  const missions: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    const value = (): string => {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new CatalogueUsage(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--json') json = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--replace' && action === 'update') replace = true;
    else if (arg === '--refresh' && action === 'catalogue') refresh = true;
    else if (arg === '--handle' && action === 'add') handle = value().replace(/^@/, '');
    else if (arg === '--fill' && action === 'add') {
      const pair = value();
      const at = pair.indexOf('=');
      if (at <= 0) throw new CatalogueUsage('--fill takes <pick>=<answer>, like --fill diet="no pork"');
      fills[pair.slice(0, at)] = pair.slice(at + 1);
    } else if (arg === '--mission' && action === 'add') missions.push(value());
    else if (arg.startsWith('-')) throw new CatalogueUsage(`unknown option for buddi agents ${action}: ${arg}`);
    else words.push(arg);
  }
  switch (action) {
    case 'catalogue':
      if (words.length > 0) throw new CatalogueUsage('buddi agents catalogue takes no name');
      return { action, json, refresh };
    case 'add':
      if (words.length !== 1) throw new CatalogueUsage('buddi agents add <name>: name one agent from buddi agents catalogue');
      return { action, name: (words[0] as string).toLowerCase(), yes, json, ...(handle ? { handle } : {}), fills, missions };
    case 'update':
      if (words.length !== 1) throw new CatalogueUsage('buddi agents update <handle>: name one agent');
      return { action, agent: (words[0] as string).replace(/^@/, ''), yes, json, replace };
    case 'remove':
      if (words.length !== 1) throw new CatalogueUsage('buddi agents remove <handle>: name one agent');
      return { action, agent: (words[0] as string).replace(/^@/, ''), yes, json };
    default:
      throw new CatalogueUsage(`not a catalogue command: ${action ?? '(none)'}`);
  }
}

export interface CatalogueIo {
  out(line: string): void;
  err(line: string): void;
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

function defaultIo(): CatalogueIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: confirmTty,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

interface Card {
  name: string;
  version: string;
  title: string;
  handle: string;
  pitch: string;
  category: string;
  state: 'ready' | 'needs' | 'installed' | 'unavailable';
  addable?: boolean;
  missing?: Array<{ kind: string; name: string; title?: string; fix: string }>;
  installed?: { agentId: string; handle: string; version: string; drift: string; via?: string };
  reason?: string;
}

interface CatalogueView {
  agents: Card[];
  fromPlugins?: Array<{ plugin: string; agent: string; handle: string; name: string; state: string }>;
  stale?: boolean;
  unavailable?: string;
}

function stateWords(card: Card): string {
  switch (card.state) {
    case 'ready':
      return 'ready to add';
    case 'needs': {
      const what = (card.missing ?? []).map((m) => (m.kind === 'need' ? (m.name === 'mailbox' ? 'a mailbox' : 'an account that draws') : (m.title ?? m.name)));
      return card.addable ? `adds ${what.join(' and ')} on the way` : `needs ${what.join(' and ')}`;
    }
    case 'installed': {
      const i = card.installed!;
      const base = i.via ? `replaces your @${i.handle}` : `on the team as @${i.handle}`;
      if (i.drift === 'update') return `${base}; ${i.via ? 'update it' : `${card.version} is out`}: buddi agents update ${i.handle}`;
      if (i.drift === 'edited-update') return `${base}; you changed it, so it is left alone unless you replace your changes: buddi agents update ${i.handle} --replace`;
      return base;
    }
    case 'unavailable':
      return card.reason ?? 'not for this buddi';
  }
}

async function poll<T extends { state: string }>(gateway: CatalogueGateway, path: string, io: CatalogueIo, onTick: (job: T) => void): Promise<T> {
  const until = Date.now() + 10 * 60_000;
  for (;;) {
    const job = await gateway.get<T>(path);
    onTick(job);
    if (job.state !== 'running' || Date.now() > until) return job;
    await io.sleep(1000);
  }
}

class Stop extends Error {
  constructor(readonly code: number) {
    super('stop');
  }
}

async function approve(io: CatalogueIo, yes: boolean, question: string, again: string): Promise<void> {
  if (yes) return;
  if (!io.interactive) {
    io.out('');
    io.out(`Nothing was changed. To approve it, run: ${again}`);
    throw new Stop(0);
  }
  if (!(await io.confirm(question))) {
    io.out('Nothing was changed.');
    throw new Stop(0);
  }
}

async function findInstalled(gateway: CatalogueGateway, agent: string): Promise<Card> {
  const view = await gateway.get<CatalogueView>('/api/catalogue');
  if (view.unavailable) throw new GatewayError(503, view.unavailable);
  const card = view.agents.find(
    (c) => c.installed && (c.installed.agentId === agent || c.installed.handle.toLowerCase() === agent.toLowerCase()),
  );
  if (!card) throw new GatewayError(404, `@${agent} did not come from the catalogue (or from an older agent a package replaces), so there is nothing to update.`);
  return card;
}

export async function runAgentsCatalogue(
  command: AgentsCatalogueCommand,
  deps: { gateway: CatalogueGateway | { off: string }; io?: Partial<CatalogueIo> },
): Promise<number> {
  const io: CatalogueIo = { ...defaultIo(), ...deps.io };
  if ('off' in deps.gateway) {
    io.err(deps.gateway.off);
    return 3;
  }
  const gateway = deps.gateway;
  try {
    switch (command.action) {
      case 'catalogue': {
        const view = await gateway.get<CatalogueView>(`/api/catalogue${command.refresh ? '?refresh=1' : ''}`);
        if (command.json) {
          io.out(JSON.stringify(view, null, 2));
          return view.unavailable ? 3 : 0;
        }
        if (view.unavailable) {
          io.err(view.unavailable);
          return 3;
        }
        if (view.stale) io.out('(withbuddi.com did not answer; this is the copy buddi kept)');
        let category = '';
        for (const card of view.agents) {
          if (card.category !== category) {
            category = card.category;
            io.out('');
            io.out(category.charAt(0).toUpperCase() + category.slice(1));
          }
          io.out(`  ${card.title} (${card.name} ${card.version}) — ${card.pitch}`);
          io.out(`    ${stateWords(card)}`);
        }
        const fromPlugins = view.fromPlugins ?? [];
        if (fromPlugins.length > 0) {
          io.out('');
          io.out('From your plugins');
          for (const p of fromPlugins) io.out(`  ${p.name} (@${p.handle}, from ${p.plugin}) — ${p.state === 'installed' ? 'on the team' : 'add it on the Plugins page'}`);
        }
        io.out('');
        io.out('Add one: buddi agents add <name>');
        return 0;
      }
      case 'add': {
        const plan = (
          await gateway.post<{
            title: string;
            version: string;
            handle: string;
            plugins: Array<{ title: string; version: string | null }>;
            blocked: Array<{ kind: string; name: string; title?: string }>;
            fills: Array<{ id: string; label: string; value: string; kind: string }>;
            missions: Array<{ id: string; name: string; enabled: boolean }>;
            tools?: Array<{ name: string }>;
            preview: string | null;
            plan?: string;
            note?: string;
          }>(`/api/catalogue/${encodeURIComponent(command.name)}/plan`, {
            fills: command.fills,
            missionsOn: command.missions,
            ...(command.handle ? { handle: command.handle } : {}),
          })
        ).body;
        if (command.json && !command.yes) {
          io.out(JSON.stringify(plan, null, 2));
          return 0;
        }
        if (plan.blocked.length > 0) {
          io.err(`${plan.title} needs ${plan.blocked.map((b) => (b.kind === 'need' ? (b.name === 'mailbox' ? 'a mailbox (Settings → Email)' : 'an account that draws') : (b.title ?? b.name))).join(' and ')} first.`);
          return 1;
        }
        if (!command.json) {
          io.out(`${plan.title} ${plan.version}, as @${plan.handle}`);
          if (plan.plugins.length > 0) io.out(`Installs on the way: ${plan.plugins.map((p) => `${p.title}${p.version ? ` ${p.version}` : ''}`).join(', ')}`);
          for (const fill of plan.fills.filter((f) => f.kind !== 'time' || f.value !== '')) {
            io.out(`  ${fill.label} ${fill.value === '' ? '(left empty)' : fill.value}   --fill ${fill.id}=…`);
          }
          for (const mission of plan.missions) io.out(`  Mission ${mission.name}: ${mission.enabled ? 'on' : 'off'}   --mission ${mission.id}`);
          io.out('');
          if (plan.preview === null && plan.tools && plan.tools.length > 0) io.out(`It asks for: ${plan.tools.map((t) => t.name).join(', ')}`);
          io.out(plan.preview ?? plan.note ?? '');
        }
        const again = ['buddi agents add', command.name, ...Object.entries(command.fills).map(([k, v]) => `--fill ${k}=${JSON.stringify(v)}`), ...command.missions.map((m) => `--mission ${m}`), ...(command.handle ? [`--handle ${command.handle}`] : []), '--yes'].join(' ');
        await approve(io, command.yes, `Add ${plan.title}?`, again);
        const started = await gateway.post<{ jobId: string }>(`/api/catalogue/${encodeURIComponent(command.name)}/install`, {
          version: plan.version,
          fills: command.fills,
          missionsOn: command.missions,
          ...(command.handle ? { handle: command.handle } : {}),
          // What the owner approved: this exact plan, or (while a plugin was missing) this grant.
          ...(plan.plan ? { plan: plan.plan } : {}),
          ...(plan.tools ? { tools: plan.tools.map((t) => t.name) } : {}),
        });
        let said = '';
        type Job = {
          id: string;
          state: string;
          steps: Array<{ title: string; state: string }>;
          agent?: { handle: string; name: string };
          confirm?: { unshown: string[]; preview: string };
          error?: string;
        };
        let job = await poll<Job>(
          gateway,
          `/api/catalogue/jobs/${started.body.jobId}`,
          io,
          (j) => {
            const step = j.steps.find((s) => s.state !== 'done' && s.state !== 'waiting');
            const line = step ? `${step.state === 'adding' ? 'Adding' : 'Installing'} ${step.title}…` : '';
            if (line && line !== said && !command.json) io.out(line);
            said = line || said;
          },
        );
        if (job.state === 'confirm' && job.confirm) {
          // The plugins resolved a grant that is not the one shown: a new question, never the --yes already given.
          if (command.json) io.out(JSON.stringify(job, null, 2));
          else {
            io.out('');
            io.out(`What ${plan.title} gets is not what was listed${job.confirm.unshown.length ? ` (also: ${job.confirm.unshown.join(', ')})` : ''}:`);
            io.out(job.confirm.preview);
          }
          if (!io.interactive || command.yes) {
            if (!command.json) io.err(`${plan.title} was not added yet: approve it in Needs you on the dashboard, or run buddi agents add ${command.name} again to see it.`);
            return 1;
          }
          const yes = await io.confirm(`Add ${plan.title} with these tools?`);
          job = (await gateway.post<Job>(`/api/catalogue/jobs/${job.id}/confirm`, { approve: yes })).body;
          if (!yes) {
            io.out('Nothing was added.');
            return 0;
          }
        }
        if (command.json) io.out(JSON.stringify(job, null, 2));
        if (job.state !== 'done') {
          if (!command.json) io.err(job.error ?? 'It did not finish.');
          return 1;
        }
        if (!command.json) io.out(`${job.agent?.name ?? plan.title} is on your team: @${job.agent?.handle ?? plan.handle}.`);
        return 0;
      }
      case 'update': {
        const card = await findInstalled(gateway, command.agent);
        const agentId = card.installed!.agentId;
        const plan = (
          await gateway.post<{ plan: string; title: string; version: string; fromVersion: string; changes: string; edited: boolean; preview: string; handle: string }>(
            `/api/catalogue/${encodeURIComponent(card.name)}/update/plan`,
            { agentId },
          )
        ).body;
        if (command.json && !command.yes) {
          io.out(JSON.stringify(plan, null, 2));
          return 0;
        }
        if (!command.json) io.out(plan.preview);
        if (plan.edited && !command.replace) {
          io.out('');
          io.out(`You changed @${plan.handle}, so nothing is touched. To replace your changes with ${plan.title} ${plan.version} (your file goes to the trash): buddi agents update ${plan.handle} --replace`);
          return 0;
        }
        await approve(io, command.yes, `Update @${plan.handle} to ${plan.version}?`, `buddi agents update ${plan.handle}${command.replace ? ' --replace' : ''} --yes`);
        const done = await gateway.post(`/api/catalogue/${encodeURIComponent(card.name)}/update`, { agentId, plan: plan.plan, ...(command.replace ? { replace: true } : {}) });
        if (command.json) io.out(JSON.stringify(done.body, null, 2));
        else io.out(`@${plan.handle} is ${plan.title} ${plan.version} now.`);
        return 0;
      }
      case 'remove': {
        const plan = await gateway.get<{ id: string; handle: string; name: string; preview: string }>(`/api/agents/${encodeURIComponent(command.agent)}/remove`);
        if (command.json && !command.yes) {
          io.out(JSON.stringify(plan, null, 2));
          return 0;
        }
        if (!command.json) io.out(plan.preview);
        await approve(io, command.yes, `Remove @${plan.handle}?`, `buddi agents remove ${plan.handle} --yes`);
        const done = await gateway.post<{ result?: { movedTo?: string; message?: string; delegateListsNotUpdated?: Array<{ id: string; handle: string }> } }>(`/api/agents/${encodeURIComponent(plan.id)}/remove`, {});
        if (command.json) io.out(JSON.stringify(done.body, null, 2));
        else {
          io.out(`@${plan.handle} is off the team. Its files are at ${done.body.result?.movedTo ?? 'the trash beside your agents'}.`);
          const stuck = done.body.result?.delegateListsNotUpdated ?? [];
          if (stuck.length > 0) {
            io.out(`Cleanup is incomplete: could not update the delegate list of ${stuck.map((a) => `@${a.handle}`).join(', ')}; it still names @${plan.handle}, which reaches nobody. Edit that list to remove it.`);
          }
        }
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof Stop) return err.code;
    if (err instanceof GatewayUnavailable) {
      io.err(NOT_RUNNING);
      return 3;
    }
    if (err instanceof GatewayError) {
      io.err(err.message);
      return err.status === 503 ? 3 : err.status === 404 ? 3 : 1;
    }
    throw err;
  }
  return 0;
}
