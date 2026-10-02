/**
 * `buddi skills list`: the Skills page from the terminal (docs/agents.md,
 * "Skills"). The page's own route, `/api/skills`, reached through the running
 * gateway the way `buddi connections` reaches its routes.
 */
import { GatewayError, GatewayUnavailable, type Gateway } from './mcp/gateway-client.js';

interface SkillLine {
  id: string;
  title: string;
  description: string;
  group: 'mine' | 'learned' | 'plugin' | 'catalogue';
  every: boolean;
  holders: Array<{ agent: string }>;
  untrusted: 'upload' | 'page' | null;
}

const GROUPS: ReadonlyArray<[SkillLine['group'], string]> = [
  ['mine', 'Yours'],
  ['learned', 'Learned'],
  ['plugin', 'From plugins'],
  ['catalogue', 'From the catalogue'],
];

export async function runSkills(
  deps: { gateway: Pick<Gateway, 'get'> | { off: string }; json: boolean; out?: (line: string) => void; err?: (line: string) => void },
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  if ('off' in deps.gateway) {
    err(deps.gateway.off);
    return 3;
  }
  let view: { skills: SkillLine[] };
  try {
    view = await deps.gateway.get<{ skills: SkillLine[] }>('/api/skills');
  } catch (e) {
    if (e instanceof GatewayUnavailable) {
      err(e.message);
      return 3;
    }
    err(e instanceof GatewayError ? e.message : String(e));
    return 1;
  }
  if (deps.json) {
    out(JSON.stringify(view.skills, null, 2));
    return 0;
  }
  if (view.skills.length === 0) {
    out('No skills yet. Write one on the Skills page, under Agents.');
    return 0;
  }
  for (const [group, title] of GROUPS) {
    const rows = view.skills.filter((s) => s.group === group);
    if (rows.length === 0) continue;
    out('');
    out(title);
    for (const s of rows) {
      const who = s.every ? 'every agent' : s.holders.length === 0 ? 'no agent uses it' : s.holders.map((h) => h.agent).join(', ');
      out(`  ${s.title} (${s.id}) — ${who}${s.untrusted === 'upload' ? ' · untrusted until you mark it as yours' : ''}`);
      out(`    ${s.description}`);
    }
  }
  return 0;
}
