/**
 * Agents a plugin offers on Home (`SuggestedAgent.offer`).
 *
 * A proposal lives on the Plugins page, where an owner who never goes there
 * never meets it. Some proposals are not optional extras but the other half of
 * something the owner already set up — the mail plugin polls every mailbox and
 * hands each new message to `mail-triage`, which nothing creates. Those carry
 * an `offer`, and Home shows it while nobody has that id, the plugin says it is
 * wanted, and the owner has not dismissed it.
 *
 * Accepting is not here. It is `POST /api/plugins/<plugin>/agents/<id>/accept`
 * (`acceptAgentRoute`), the gated `platform.accept_plugin_agent` the Plugins
 * page's Accept button runs, approval card and all. This module only decides
 * which cards to draw, and remembers a no.
 */
import { readWebSetting, writeWebSetting } from '@buddi/core';
import { pluginAgentProposals } from '../agents/platform.js';
import { runPageQuery, type PagesDeps } from './pages.js';

/** The `core.web_settings` key the owner's dismissals are kept under. */
export const AGENT_OFFERS_KEY = 'agent-offers';

interface AgentOffersSetting {
  /** `<plugin>/<agent>`, one per offer the owner said no to. */
  dismissed?: string[];
}

/** One card, as Home draws it. */
export interface AgentOfferView {
  plugin: string;
  agent: string;
  handle: string;
  name: string;
  description: string;
  /** The plugin's one line: why the owner would want it. */
  text: string;
}

export interface AgentOffersDeps extends PagesDeps {
  pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
  /** The ids the roster holds right now. */
  agentIds: () => readonly string[];
}

function keyOf(plugin: string, agent: string): string {
  return `${plugin}/${agent}`;
}

async function dismissedSet(pool: AgentOffersDeps['pool']): Promise<Set<string>> {
  try {
    const value = await readWebSetting<AgentOffersSetting>(pool as never, AGENT_OFFERS_KEY);
    return new Set(Array.isArray(value?.dismissed) ? value.dismissed.filter((d) => typeof d === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * The offers to draw: proposed with an `offer`, nobody has that id, not
 * dismissed, and — when the plugin names a query — wanted now.
 *
 * A query that fails is treated as "not wanted": a card that appears because a
 * read broke is a card the owner cannot reason about.
 */
export async function readAgentOffers(deps: AgentOffersDeps): Promise<{ offers: AgentOfferView[] }> {
  const present = new Set(deps.agentIds());
  const dismissed = await dismissedSet(deps.pool);
  const offers: AgentOfferView[] = [];
  for (const { plugin, agent } of pluginAgentProposals(deps.registry)) {
    const offer = agent.offer;
    if (!offer || typeof offer.text !== 'string' || offer.text.trim() === '') continue;
    if (present.has(agent.id) || dismissed.has(keyOf(plugin, agent.id))) continue;
    if (offer.query) {
      const answer = await runPageQuery(deps, plugin, offer.query, new URLSearchParams()).catch(() => null);
      const data = (answer?.body as { data?: { wanted?: unknown } } | null)?.data;
      if (answer?.status !== 200 || data?.wanted !== true) continue;
    }
    offers.push({
      plugin,
      agent: agent.id,
      handle: agent.handle,
      name: agent.name,
      description: agent.description,
      text: offer.text.trim(),
    });
  }
  return { offers };
}

/** The owner said no to one offer. It stays on the Plugins page; Home stops asking. */
export async function dismissAgentOffer(
  deps: AgentOffersDeps,
  plugin: string,
  agent: string,
): Promise<{ status: number; body: unknown }> {
  const known = pluginAgentProposals(deps.registry).some(
    (p) => p.plugin === plugin && p.agent.id === agent && p.agent.offer !== undefined,
  );
  if (!known) return { status: 404, body: { error: `No plugin offers an agent "${agent}" under "${plugin}".` } };
  const dismissed = await dismissedSet(deps.pool);
  dismissed.add(keyOf(plugin, agent));
  await writeWebSetting(deps.pool as never, AGENT_OFFERS_KEY, { dismissed: [...dismissed].sort() });
  return { status: 200, body: { dismissed: true } };
}
