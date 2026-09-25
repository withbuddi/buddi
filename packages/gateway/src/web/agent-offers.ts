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
 * page's Accept button runs; the owner's click is the approval. This module only decides
 * which cards to draw, and remembers a no.
 */
import {
  getAction,
  listPendingActions,
  OWNER_AGENT_ID,
  readWebSetting,
  writeWebSetting,
  type ActionRecord,
} from '@buddi/core';
import { pluginAgentProposals } from '../agents/platform.js';
import { runPageQuery, type PagesDeps } from './pages.js';

/** The `core.web_settings` key the owner's dismissals are kept under. */
export const AGENT_OFFERS_KEY = 'agent-offers';

interface AgentOffersSetting {
  /** `<plugin>/<agent>`, one per offer the owner said no to. */
  dismissed?: string[];
  /**
   * `<plugin>/<agent>`, one per offer the gateway raised as an approval on its
   * own (`raiseAgentOffers`). Raised once per installation: a card the owner
   * rejected, or let expire, is not raised again; the button stays.
   */
  raised?: string[];
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

async function readSetting(pool: AgentOffersDeps['pool']): Promise<AgentOffersSetting> {
  try {
    return (await readWebSetting<AgentOffersSetting>(pool as never, AGENT_OFFERS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function listOf(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string') : []);
}

async function dismissedSet(pool: AgentOffersDeps['pool']): Promise<Set<string>> {
  return listOf((await readSetting(pool)).dismissed);
}

/** Add one key to one of the setting's lists, keeping the other as it was. */
async function remember(pool: AgentOffersDeps['pool'], list: 'dismissed' | 'raised', key: string): Promise<void> {
  const setting = await readSetting(pool);
  const next = listOf(setting[list]);
  next.add(key);
  await writeWebSetting(pool as never, AGENT_OFFERS_KEY, { ...setting, [list]: [...next].sort() });
}

/** Whether a plugin's offer query says the agent is wanted now. A failed read is "no". */
async function wanted(deps: AgentOffersDeps, plugin: string, query: string | undefined): Promise<boolean> {
  if (!query) return true;
  const answer = await runPageQuery(deps, plugin, query, new URLSearchParams()).catch(() => null);
  const data = (answer?.body as { data?: { wanted?: unknown } } | null)?.data;
  return answer?.status === 200 && data?.wanted === true;
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
    if (!(await wanted(deps, plugin, offer.query))) continue;
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
  await remember(deps.pool, 'dismissed', keyOf(plugin, agent));
  return { status: 200, body: { dismissed: true } };
}

/** The pending accept for one proposal, when there is one. */
export function isPendingAccept(action: ActionRecord, plugin: string, agent: string): boolean {
  const args = action.canonicalArgs as { plugin?: unknown; agent?: unknown } | null;
  return (
    action.tool === 'platform.accept_plugin_agent' &&
    args?.plugin === plugin &&
    typeof args.agent === 'string' &&
    args.agent.toLowerCase() === agent.toLowerCase()
  );
}

export interface RaiseAgentOffersDeps extends AgentOffersDeps {
  /** Post the new card to the owner's Telegram chat, when one is paired. */
  askApproval?: ((action: ActionRecord) => Promise<void>) | undefined;
  log?: (line: string) => void;
}

/**
 * Raise the approval for a plugin's offers the moment they become wanted.
 *
 * Asked after every write a plugin's page makes (saving a mailbox is one). For
 * each of that plugin's offers: nobody has the id, the owner has not said no,
 * it was never raised before, no accept is already waiting, and the plugin's
 * query says it is wanted now — then the gateway invokes the same gated
 * `platform.accept_plugin_agent` the button does, as the owner, and the card
 * is on every surface at once: the plugin's page, Home, the approvals list,
 * Telegram. Approving it is the one click.
 *
 * Once per installation per agent: the raise is remembered beside the
 * dismissals before the card exists, so a second mailbox, or a card rejected
 * or left to expire, raises nothing. "Create @mail" stays for later. Answers
 * the approvals it raised.
 */
export async function raiseAgentOffers(deps: RaiseAgentOffersDeps, plugin: string): Promise<string[]> {
  const proposals = pluginAgentProposals(deps.registry).filter((p) => p.plugin === plugin && p.agent.offer);
  if (proposals.length === 0) return [];
  const raisedIds: string[] = [];
  for (const { agent } of proposals) {
    const key = keyOf(plugin, agent.id);
    const setting = await readSetting(deps.pool);
    if (listOf(setting.dismissed).has(key) || listOf(setting.raised).has(key)) continue;
    if (deps.agentIds().includes(agent.id)) continue;
    const pending = await listPendingActions(deps.pool as never, { now: deps.now() }).catch(() => [] as ActionRecord[]);
    if (pending.some((action) => isPendingAccept(action, plugin, agent.id))) continue;
    if (!(await wanted(deps, plugin, agent.offer?.query))) continue;
    await remember(deps.pool, 'raised', key);
    const result = await deps.registry.invoke(
      'platform.accept_plugin_agent',
      { plugin, agent: agent.id },
      { ...deps.ctx, agentId: OWNER_AGENT_ID, now: deps.now },
    );
    if (result.ok || result.reason !== 'approval-required') {
      deps.log?.(`agent offer ${key}: not raised (${result.ok ? 'ran without an approval' : result.message})`);
      continue;
    }
    raisedIds.push(result.actionId);
    if (deps.askApproval) {
      const action = await getAction(deps.pool as never, result.actionId).catch(() => null);
      if (action) await deps.askApproval(action).catch((err: unknown) => deps.log?.(`agent offer ${key}: Telegram: ${String(err)}`));
    }
  }
  return raisedIds;
}
