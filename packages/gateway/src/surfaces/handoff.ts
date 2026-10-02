/**
 * The front desk hands an agent request on (ROADMAP "Concierge hands off agent
 * requests"): asked for a new agent, it checks the catalogue first and offers
 * the match ("Add Chef", which opens that agent's install sheet), and when
 * nothing fits, "Continue with Agent Father", which moves the conversation to
 * the maker with the owner's request carried.
 *
 * Both are offers in `core.offers` with a `handoff`, so they live and lapse
 * exactly as `conversation.offer`'s do: one turn's, claimed once, gone when
 * the owner says the next thing. What is different is what a tap does — it
 * never asks the front desk again:
 *
 *  - `install`: the dashboard opens the package's install sheet (on Telegram,
 *    a link to it). Nothing is claimed; adding is the sheet's own approval.
 *  - `maker`: the surface switches the chat to the maker and sends the request
 *    as the owner's turn. Only the owner's tap starts it: the front desk still
 *    cannot reach the maker by itself (a writer is never a delegation target,
 *    `delegation.ts`), and this tool writes a button, nothing more.
 *
 * Registered per interactive turn, and only for an agent holding the
 * front-desk role; `conversation.offer` cannot make one (its schema has no
 * handoff), so no other agent can put a "Continue with Agent Father" button
 * in front of the owner.
 */
import { MAX_OFFER_LABEL, MAX_OFFER_PROMPT, type PluginManifest, type ToolDefinition, type ToolRegistry } from '@buddi/core';
import { z } from 'zod';
import { catalogueBindingOf } from '../agents/platform.js';
import { ROLE_FRONT_DESK, ROLE_MAKER } from '../agents/roles.js';
import type { OfferSink } from './offered-actions.js';

export const HANDOFF_PLUGIN = 'conversation-handoff';
export const HANDOFF_TOOL = 'conversation.hand_off';
export const HANDOFF_TOOLS: readonly string[] = [HANDOFF_TOOL];

/** Who and what a handoff can name on this installation. */
export interface HandoffTargets {
  /** The agent that makes agents, when there is one. */
  maker(): { id: string; name: string } | undefined;
  /** A package the catalogue lists, by name; undefined when it lists none such (or is offline). */
  listed(name: string): Promise<{ name: string; title: string } | undefined>;
}

const handoffInput = z.object({
  to: z
    .enum(['catalogue', 'maker'])
    .describe('"catalogue": an agent platform.catalogue lists fits, offer to add it. "maker": nothing listed fits, offer to continue with Agent Father.'),
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional()
    .describe('With "catalogue": the package name platform.catalogue gave (e.g. "chef").'),
  request: z
    .string()
    .min(1)
    .max(MAX_OFFER_PROMPT)
    .optional()
    .describe(
      'With "maker": what the owner wants the new agent to do, in their own words and voice, complete enough that Agent Father can start from it ("I want an agent that tracks my plants and reminds me to water them").',
    ),
});

export type HandoffResult = { offered: string };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The `conversation.hand_off` manifest, bound to one run's offer sink. */
export function createHandoffManifest(sink: OfferSink, targets: HandoffTargets): PluginManifest {
  const tool: ToolDefinition<z.infer<typeof handoffInput>, HandoffResult> = {
    name: HANDOFF_TOOL,
    description:
      'When the owner asks for a new agent: put one button under your reply. With to "catalogue" and the package name, it opens that ' +
      "catalogue agent's install sheet (check platform.catalogue first and use it when an agent there fits). With to \"maker\" and the " +
      "owner's request, it offers \"Continue with Agent Father\", which moves the conversation to Agent Father with the request. " +
      'It starts nothing: only the owner tapping it does. Call it once, before you write the reply.',
    tier: 'auto',
    input: handoffInput,
    async execute(input) {
      if (input.to === 'catalogue') {
        if (!input.name) throw new Error('name the catalogue package (platform.catalogue gives it)');
        const pkg = await targets.listed(input.name);
        if (!pkg) throw new Error(`the catalogue lists no agent "${input.name}"; check platform.catalogue, or offer Agent Father instead`);
        sink.handoff = {
          label: clip(`Add ${pkg.title}`, MAX_OFFER_LABEL),
          prompt: `Open ${pkg.title}'s install sheet.`,
          handoff: { kind: 'install', package: pkg.name, title: pkg.title },
        };
        return { offered: sink.handoff.label };
      }
      const maker = targets.maker();
      if (!maker) throw new Error('no agent here makes agents, so there is nobody to continue with');
      const request = (input.request ?? '').trim();
      if (request === '') throw new Error("carry the owner's request: what the new agent should do");
      sink.handoff = {
        label: clip(`Continue with ${maker.name}`, MAX_OFFER_LABEL),
        prompt: request,
        handoff: { kind: 'maker', agentId: maker.id },
      };
      return { offered: sink.handoff.label };
    },
  };
  return { name: HANDOFF_PLUGIN, version: '0.1.0', schema: 'core', migrationsDir: '', tools: [tool] };
}

/** Told to a front-desk turn alongside the offer policy. */
export const HANDOFF_POLICY_SUFFIX = [
  `When the owner asks for a new agent, you hand the request on with ${HANDOFF_TOOL}; you never make agents and you never ask Agent Father yourself.`,
  `First look in the catalogue (platform.catalogue). If an agent there does what they asked, call ${HANDOFF_TOOL} with to "catalogue" and its name, and say in a sentence what it does.`,
  `If nothing there fits, call ${HANDOFF_TOOL} with to "maker" and their request in their own words, and say Agent Father can make it with them.`,
  'The button is the whole handoff: do not also tell them to type /use @father.',
].join(' ');

/** Does this agent answer for the front desk (and so get the handoff tool)? */
export function isFrontDesk(agent: { roles?: readonly string[] }): boolean {
  return (agent.roles ?? []).includes(ROLE_FRONT_DESK);
}

/** The targets as this installation has them: the catalog's maker, the catalogue's list. */
export function handoffTargets(
  registry: ToolRegistry,
  catalog: { list(): ReadonlyArray<{ id: string; name: string; roles?: readonly string[] }> },
): HandoffTargets {
  return {
    maker() {
      const found = catalog.list().find((a) => (a.roles ?? []).includes(ROLE_MAKER));
      return found ? { id: found.id, name: found.name } : undefined;
    },
    async listed(name) {
      const service = catalogueBindingOf(registry)?.service;
      if (!service) return undefined;
      const loaded = await service.load().catch(() => ({ unavailable: 'unreachable' }) as const);
      if ('unavailable' in loaded) return undefined;
      const pkg = loaded.packages.find((p) => p.manifest.name === name);
      return pkg ? { name: pkg.manifest.name, title: pkg.manifest.title } : undefined;
    },
  };
}
