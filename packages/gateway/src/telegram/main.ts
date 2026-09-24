#!/usr/bin/env node
/**
 * `buddi-telegram` — the Telegram surface process (roadmap step 2).
 *
 * Wiring only: resolve the provider once, register the finance plugin, pair the
 * allowlisted owner id if the environment names one, then long-poll. Every
 * authorization decision belongs to core; every tool call belongs to the
 * registry. This file decides nothing.
 *
 * `startTelegram` is the reusable half: `buddi serve` starts the same surface
 * next to the scheduler in one process, sharing one pool and one provider.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ensureOwner,
  getAction,
  getSurfaceCursor,
  askQuestion,
  listSurfaceIdentities,
  pairSurfaceIdentity,
  resumeJob,
  TELEGRAM_SURFACE,
  ToolRegistry,
  type JobControl,
  type Offer,
  type SurfaceIdentity,
  type ToolContext,
  listToolPermissions,
  revokeToolPermission,
  conversationGroup,
  type ActionRecord,
} from '@buddi/core';
import { runAgent, type RunAgentOptions, type RuntimeProvider } from '@buddi/runtime';
import { nativeSearchRecorder } from '@buddi/tool-web';
import { hostService } from '@buddi/tool-host';
import { hostBrowser } from '@buddi/tool-browser';
import { continueBrowserTask } from '../surfaces/browser-continuation.js';
import { browserTabUrl, webConfig } from '../web/config.js';
import { BROWSER_ACT, BrowserPhotos, runBrowserCommand } from './browser-view.js';
import { approvalResumeContext, ownerRequestContext } from '../surfaces/owner-request.js';
import {
  ASK_POLICY_SUFFIX,
  ASK_TOOLS,
  createAskManifest,
  type AskSink,
} from '../surfaces/pending-question.js';
import {
  OFFER_POLICY_SUFFIX,
  OFFER_TOOLS,
  createOfferManifest,
  storeTurnOffers,
  withdrawTurnOffers,
  type OfferSink,
} from '../surfaces/offered-actions.js';
import type { Pool } from 'pg';
import type { ApprovalResume } from '@buddi/runtime';
import { memoryPreambleFor } from '../agents/catalog.js';
import { ROLE_MAKER } from '../agents/roles.js';
import { bindOwnerTools } from '../agents/owner-tools.js';
import { createWiringAsync, loadEnvironment } from '../bootstrap.js';
import { TelegramApprovals } from './approvals.js';
import { syncProfilePhoto } from './profile-photo.js';
import { TelegramApi, type TelegramBotCommand } from './api.js';
import { createEngagementHooks } from '../missions/engagement.js';
import { recapMissionId } from '../missions/recap.js';
import { createCoreArtifactStore, type ArtifactStore } from './attachments.js';
import {
  QUIET_UNAVAILABLE_TEXT,
  SURFACE,
  TelegramSurface,
  handleLabel,
  replyText,
  type RunRequest,
  type RunReply,
  type RunMission,
} from './surface.js';
import type { ReloadableAgentCatalog } from '../agents/catalog.js';
import type { AgentCatalog } from './types.js';

/**
 * The command menu, shown only to paired owner chats.
 *
 * Telegram resolves a menu from the narrowest scope outward. buddi clears the
 * *default* scope and publishes this list per paired chat, so a stranger who
 * opens the bot sees no menu at all — the same fail-closed posture the surface
 * takes with messages.
 */
export const OWNER_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'agents', description: 'List the agents you can talk to' },
  { command: 'use', description: 'Switch agent' },
  { command: 'status', description: 'Where you stand right now' },
  { command: 'recap', description: 'Run the weekly recap now' },
  { command: 'reminders', description: 'What the agents put on the clock' },
  { command: 'quiet', description: 'Stop proactive messages for a while' },
  { command: 'approvals', description: 'Anything waiting for your approval' },
  { command: 'browser', description: 'Where the screen stands; stop, resume or release it' },
  { command: 'host', description: 'Host execution permissions and running commands' },
  { command: 'hoststop', description: 'Interrupt all host commands' },
  { command: 'hostrevoke', description: 'Revoke all host auto-permissions and stop commands' },
  { command: 'files', description: 'The last files you sent me' },
  { command: 'devices', description: 'Devices paired to this installation' },
  { command: 'reset', description: 'Start a fresh conversation' },
  { command: 'id', description: 'Show my Telegram ids' },
  { command: 'help', description: 'What buddi can do' },
];

/**
 * The entry that is in the menu only while somebody can act on it.
 *
 * It sits directly after `/agents`: the two are one thought — what you have,
 * and how to get another — and a menu that separates them makes the owner hunt
 * for the thing they just failed to find in the list.
 */
export const MAKE_AGENT_COMMAND: TelegramBotCommand = {
  command: 'new',
  description: 'Make a new agent',
};

/**
 * Is there anyone to run `/new`? A holder that exists but cannot run on this
 * machine (no credential) is not offered: a menu entry is a promise.
 */
export function canMakeAgents(catalog: AgentCatalog): boolean {
  const resolution = catalog.agentForRole(ROLE_MAKER);
  return resolution.ok && resolution.agent.availability.ok;
}

/**
 * The menu as one chat sees it: `use` names the agent that chat is talking to
 * — `Switch agent (active: Ledger)` — so the active agent is visible without
 * asking. No `@`: that spelling is reserved for what the owner types, because
 * Telegram renders it as a link to a user who does not exist.
 *
 * `/new` is added only when an agent claims the `maker` role, which is why this
 * is recomputed per publish rather than frozen at boot — the owner can make the
 * maker's replacement in session, and the menu follows the catalog reload.
 */
export function ownerCommandsFor(
  activeAgentHandle?: string,
  makerAvailable = false,
): readonly TelegramBotCommand[] {
  const label = handleLabel(activeAgentHandle);
  const named =
    label === ''
      ? OWNER_COMMANDS
      : OWNER_COMMANDS.map((c) =>
          c.command === 'use' ? { ...c, description: `Switch agent (active: ${label})` } : c,
        );
  if (!makerAvailable) return named;
  const after = named.findIndex((c) => c.command === 'agents') + 1;
  return [...named.slice(0, after), MAKE_AGENT_COMMAND, ...named.slice(after)];
}

/**
 * Publish the owner menu for every paired chat and clear the default scope.
 * Cosmetic: a Bot API failure is logged and never stops the surface starting.
 */
export async function applyCommandMenus(
  api: Pick<TelegramApi, 'setMyCommands' | 'deleteMyCommands'>,
  paired: readonly SurfaceIdentity[],
  log: (line: string) => void,
  activeAgentHandle?: (chatId: string) => Promise<string | undefined>,
  makerAvailable = false,
): Promise<void> {
  try {
    await api.deleteMyCommands({ type: 'default' });
  } catch (err) {
    log(`telegram: clearing the default command menu failed: ${errorText(err)}`);
  }
  for (const identity of paired) {
    const chatId = identity.externalChatId;
    if (!chatId) continue;
    let handle: string | undefined;
    if (activeAgentHandle) {
      handle = await activeAgentHandle(chatId).catch((err) => {
        log(`telegram: active agent for chat ${chatId} unknown: ${errorText(err)}`);
        return undefined;
      });
    }
    try {
      await api.setMyCommands(ownerCommandsFor(handle, makerAvailable), {
        type: 'chat',
        chat_id: chatId,
      });
      log(`telegram: menu set for chat ${chatId}`);
    } catch (err) {
      log(`telegram: menu for chat ${chatId} failed: ${errorText(err)}`);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Subscribe to catalog reloads when the catalog can be reloaded at all.
 *
 * Duck-typed on purpose: `TelegramDeps.catalog` is the read-only `AgentCatalog`
 * every surface holds, and a test (or a build with no `platform.*` tools) may
 * hand over a plain one. Nothing to subscribe to is not a failure — it is an
 * installation where the menu cannot go stale.
 */
function watchCatalogReloads(catalog: AgentCatalog, listener: () => void): () => void {
  const reloadable = catalog as Partial<ReloadableAgentCatalog>;
  if (typeof reloadable.onReload !== 'function') return () => {};
  return reloadable.onReload(listener);
}

/**
 * What the chat is told when a run stops on an approval and the model said
 * nothing else. The request itself arrives as its own message, with buttons.
 */
export const AWAITING_APPROVAL_REPLY =
  'I need your approval before I can do that — see the request just below.';

/** Numeric ids only: a username is not an identity. */
export function numericId(value: string | undefined, label: string): string | undefined {
  const raw = (value ?? '').trim();
  if (raw === '') return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${label} must be a numeric id, got: ${raw}`);
  }
  return raw;
}

export interface TelegramDeps {
  pool: Pool;
  registry: ToolRegistry;
  /** Every installed agent. One bot, many agents; the chat picks with /use. */
  catalog: AgentCatalog;
  provider: RuntimeProvider;
  providerFor?: (agent: ReturnType<AgentCatalog['resolve']>) => RuntimeProvider;
  ctx: ToolContext;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Injected in tests; built from `TELEGRAM_BOT_TOKEN` otherwise. */
  api?: TelegramApi;
  /** Injected in tests; bound to core's artifact store otherwise. */
  artifacts?: ArtifactStore;
  log?: (line: string) => void;
  /**
   * Where a group's suspended request resumes. Groups live on the dashboard
   * (docs/groups.md); a decision taken here is handed over, never run here as
   * an ordinary turn. Returns false when no dashboard is running to take it.
   */
  resumeGroup?: (action: ActionRecord, resume: ApprovalResume) => Promise<boolean>;
  /**
   * Runs a mission inline for `/recap`. `buddi serve` owns the executor and
   * passes it; the standalone surface has no scheduler and leaves it out.
   */
  runMission?: RunMission;
  /** The mission `/recap` runs; the installed plugins' `recap` suggestion. */
  recapMissionId?: string;
  /**
   * The queue, for waking a run that suspended awaiting an approval. Defaults
   * to core's own `resumeJob`; a build with no queue passes `null`.
   */
  jobs?: JobControl | null;
  /**
   * Asked before every interactive turn. A string is the answer the owner gets
   * *instead of* a run — `buddi serve` uses it for the global pause, so a paused
   * installation says so rather than quietly doing the work anyway. Null means
   * carry on. Absent: nothing is gated.
   */
  gate?: () => Promise<string | null>;
  /**
   * Start the run a tapped offered action asks for, returning the job id.
   *
   * `buddi serve` owns the queue and passes it; the standalone surface has no
   * worker and leaves it out, which means an offer button there is claimed and
   * answered honestly rather than pretending to have started something.
   */
  takeOffer?: (offer: Offer) => Promise<string | undefined>;
}

export interface TelegramHandle {
  botUsername: string | undefined;
  botId: number;
  /**
   * The approval surface this process runs. Exposed so an *unattended* run —
   * a scheduled mission, a source's run — can ask the owner too: the run has
   * no chat of its own, but the request must still arrive with buttons bound
   * to the one action it authorizes.
   */
  approvals: TelegramApprovals;
  /** Owner identities paired for this surface at startup. */
  paired: SurfaceIdentity[];
  /** The persisted polling offset as it stood at startup. */
  cursor: string | undefined;
  /** Resolves when polling has stopped and every queued run has drained. */
  done: Promise<void>;
  /** Bring the bot's profile photo in line with the default agent's picture. Fire and forget. */
  syncProfilePhoto(): void;
  stop(): Promise<void>;
}

/**
 * Start the Telegram surface. Returns once the bot identity is known and
 * polling has begun; the caller owns the pool and decides when to stop.
 */
export async function startTelegram(deps: TelegramDeps): Promise<TelegramHandle> {
  const { pool, env, now } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!deps.api && token === '') throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const api = deps.api ?? new TelegramApi({ token });

  await ensureOwner(pool, 'owner');

  const ownerUserId = numericId(env.TELEGRAM_OWNER_USER_ID, 'TELEGRAM_OWNER_USER_ID');
  const ownerChatId = numericId(env.TELEGRAM_OWNER_CHAT_ID, 'TELEGRAM_OWNER_CHAT_ID');
  if (ownerUserId) {
    // The startup allowlist. `paired_via` is recorded, and core keeps the
    // first value, so a device that paired by code is never relabelled 'env'.
    await pairSurfaceIdentity(pool, {
      surface: SURFACE,
      externalUserId: ownerUserId,
      externalChatId: ownerChatId ?? ownerUserId,
      pairedVia: 'env',
    });
  }

  const paired = await listSurfaceIdentities(pool, SURFACE);
  const cursor = await getSurfaceCursor(pool, SURFACE);
  const me = await api.getMe();

  // Recomputed per publish, never captured: `/new` is in the menu only while
  // the `maker` role has a holder, and that can change while the process runs.
  const setChatMenu = async (chatId: string, agent: { handle: string }): Promise<void> => {
    await api.setMyCommands(ownerCommandsFor(agent.handle, canMakeAgents(deps.catalog)), {
      type: 'chat',
      chat_id: chatId,
    });
  };

  // Files land in core's artifact store; the surface only hands bytes over and
  // asks for them back when a run needs to look at one.
  const artifacts = deps.artifacts ?? createCoreArtifactStore({ pool, env });

  // Approvals: the surface routes a tap here, and every decision, execution and
  // resume happens inside core. The queue is wired in so a decided action wakes
  // the run that was suspended waiting for it.
  const jobs = deps.jobs === null ? undefined : (deps.jobs ?? { resumeJob });
  let runInteractive: (request: RunRequest) => Promise<string | RunReply>;
  const approvals = new TelegramApprovals({
    api,
    pool,
    registry: deps.registry,
    ctx: deps.ctx,
    timezone: deps.ctx.timezone,
    ...(jobs ? { jobs } : {}),
    log,
    now,
    resumeInteractive: async (chatId, action, resume) => {
      const agent = deps.catalog.get(action.agentId);
      if (!agent || !action.conversationId) return;
      // A room never runs as one agent's ordinary turn: it has a budget, a
      // projection and a memory scope of its own, all of which live with the
      // dashboard's group path.
      if (await conversationGroup(pool, action.conversationId).catch(() => null)) {
        const taken = (await deps.resumeGroup?.(action, resume)) === true;
        await api.sendMessage(chatId, taken
          ? `Decided. The group "${agent.name}" was waiting on continues on the dashboard.`
          : 'Decided. That was a group\'s request; it continues when the dashboard is running.');
        return;
      }
      // The decision is the owner's act; the run it wakes says so.
      const reply = await runInteractive({ chatId, conversationId: action.conversationId, agent, text: '', resume, approval: { tool: action.tool } });
      const text = replyText(reply);
      if (text) await api.sendMessage(chatId, text);
    },
  });

  // Rebound with this surface's name so a first run completed here is recorded
  // as having happened here.
  bindOwnerTools(deps.registry, { catalog: deps.catalog, surface: SURFACE });

  /*
   * Sight on the phone: the screenshot the agent just looked at, with a way in.
   *
   * The host controller is the same one the dashboard reads and the same one
   * the agent drives, so the picture is the observation itself rather than a
   * second capture, and the allow lists it is checked against are the owner's
   * own. Where the Take over button lands is the dashboard's business
   * (`browserTabUrl`): the tailnet origin when one is configured, loopback
   * otherwise — and then the caption says so.
   */
  const photos = new BrowserPhotos({
    api,
    browser: hostBrowser(env),
    link: (agentId, conversationId) => browserTabUrl(webConfig(env), agentId, conversationId),
    allowedHosts: env.BUDDI_BROWSER_HOSTS?.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean) ?? [],
    log,
  });

  const surface = new TelegramSurface({
    api,
    pool,
    catalog: deps.catalog,
    timezone: deps.ctx.timezone,
    // The bot's own @username, so Telegram's mention of it is stripped before
    // the owner's `@handle` is read.
    ...(me.username ? { botUsername: me.username } : {}),
    artifacts,
    log,
    setChatMenu,
    // `/quiet` and the unanswered counter. Both belong to the arc, not to the
    // transport: the surface routes the word and prints the sentence.
    engagement: createEngagementHooks({
      pool,
      now,
      timezone: deps.ctx.timezone,
      unavailableText: QUIET_UNAVAILABLE_TEXT,
      log,
    }),
    ...(deps.takeOffer ? { takeOffer: deps.takeOffer } : {}),
    ...(deps.runMission ? { runMission: deps.runMission } : {}),
    ...(deps.recapMissionId === undefined
      ? (() => {
          const suggested = recapMissionId();
          return suggested === undefined ? {} : { recapMissionId: suggested };
        })()
      : { recapMissionId: deps.recapMissionId }),
    approvals,
    onConversationRollover: (agentId, previousConversationId, conversationId, reason) => continueBrowserTask(pool, hostBrowser(env), { ownerId: deps.ctx.ownerId, agentId, previousConversationId, conversationId }, reason),
    browserControl: (command) => runBrowserCommand(hostBrowser(env), command),
    hostControl: async (ownerId, command) => {
      const host = hostService(env);
      const permissions = (await listToolPermissions(pool, ownerId)).filter(p => p.tool === 'host.exec');
      if (command === 'revoke') {
        for (const permission of permissions) await revokeToolPermission(pool, ownerId, permission.id);
        host.stop(ownerId);
        return 'All host execution auto-permissions revoked; running host commands interrupted. Completed changes are not undone. Future commands will ask for approval.';
      }
      if (command === 'stop') return `Interrupted ${host.stop(ownerId)} host command(s). Completed changes are not undone. Use /hostrevoke to also end auto-permissions.`;
      const runs = host.runs(ownerId);
      return ['Host execution — not sandboxed', ...permissions.map(p => `${p.agentId}: ${p.conversationId ? 'conversation auto-mode' : 'always allowed'}`),
        `${runs.length} command(s) running.`, '/hoststop interrupts all host commands.', '/hostrevoke revokes all host auto-permissions and interrupts commands.',
        'Individual controls and command output are in the dashboard under Host execution.'].join('\n');
    },
    // The surface decided *which* agent this turn belongs to; resolving the id
    // again here is what makes the definition current (`{{today}}`, a reloaded
    // file) without letting the wiring choose a different agent.
    run: runInteractive = async ({ conversationId, chatId, text, agent, attachments, onToolCall, systemSuffix, resume, approval, interjections }) => {
      // Interactive turns stay inline — they are user-facing and already
      // serialized per chat — but they are not exempt from a global pause.
      const blocked = deps.gate ? await deps.gate() : null;
      if (blocked !== null) return blocked;

      // `conversation.ask` is registered per run, exactly as the mission tools
      // are: a copy of the base registry, so nothing outside an interactive
      // turn can call it and two chats never share a sink. It is how a turn
      // *declares* that it ended on a question, rather than leaving the surface
      // to guess it from prose.
      const sink: AskSink = {};
      // Its sibling: what this turn *offers* the owner to do next. Same
      // mechanism, same per-run isolation; the offers themselves are the rows
      // `core.offers` already holds, and a tap is the `off:` callback that
      // already exists.
      const offers: OfferSink = {};
      const registry = new ToolRegistry();
      for (const manifest of deps.registry.manifests()) registry.register(manifest);
      registry.register(createAskManifest(sink));
      registry.register(createOfferManifest(offers));

      // An offer belongs to the turn that made it: the moment the owner says
      // the next thing, whatever the last turn offered is withdrawn, so no
      // button in this conversation can still fire an hour and three subjects
      // later.
      await withdrawTurnOffers(pool, conversationId, new Date(now()), log);

      const base = deps.catalog.resolve(agent.id).definition(now(), deps.ctx.timezone);
      const options: RunAgentOptions = {
        agent: { ...base, tools: [...base.tools, ...ASK_TOOLS, ...OFFER_TOOLS] },
        provider: deps.providerFor ? deps.providerFor(deps.catalog.resolve(agent.id)) : deps.provider,
        registry,
        // A resume carries the owner's decision, which is the owner acting in
        // this chat: it is an owner request too, so a `session` tool still
        // works on the other side of an approval. A resume for any other
        // reason — there is none today — would not get one.
        ctx: resume
          ? (approval ? approvalResumeContext(deps.ctx, approval) : deps.ctx)
          : ownerRequestContext(deps.ctx, text),
        pool,
        conversationId,
        ...(resume ? { resume } : { userMessage: text }),
        // The declared profile, not a sentence written here: how Telegram
        // renders is a property of Telegram, and it belongs in one place that
        // every surface reads the same way.
        surface: TELEGRAM_SURFACE,
        // The ask policy is about every interactive turn; the first run's
        // instruction is about this one. Both, in that order.
        systemSuffix: [
          ASK_POLICY_SUFFIX,
          OFFER_POLICY_SUFFIX,
          ...(systemSuffix === undefined ? [] : [systemSuffix]),
        ].join('\n\n'),
        memoryPreamble: memoryPreambleFor(pool),
        // A second message while this run works is not a second run: the loop
        // takes it between two tool calls, and the reply is still one message.
        ...(interjections ? { interjections } : {}),
        // The provider's own web search leaves the same audit row `web.search`
        // does; see @buddi/tool-web's native.ts.
        onNativeSearch: nativeSearchRecorder(pool),
        onToolCall: (name, input) => {
          log(`⚙ ${name} ${JSON.stringify(input)}`);
          // Held until the result comes back, so the caption can say what the
          // step was *for* rather than only naming its verb.
          if (name === BROWSER_ACT) photos.noteCall(conversationId, input);
          onToolCall?.(name, input);
        },
        // Presentation only, and never awaited: the photo is queued on its own
        // tail, so Telegram can never slow a step down or fail one.
        onToolResult: (name, outcome) => {
          if (name !== BROWSER_ACT) return;
          void photos.step({
            chatId,
            agentId: agent.id,
            conversationId,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        },
      };
      // Multimodal input is the runtime's business: the surface says *which*
      // artifacts this turn may see and how to fetch one, and never builds a
      // provider content block itself.
      if (attachments && attachments.length > 0) {
        options.attachments = attachments;
        options.loadArtifact = (id) => artifacts.load(id);
      }
      const result = await runAgent(options);

      // The run proposed a gated effect and stopped. The owner is asked in this
      // same chat, with the preview the *tool* rendered and buttons bound to
      // that one action — no message here can approve anything by itself.
      if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
        const action = await getAction(pool, result.pendingActionId);
        if (action) await approvals.request(chatId, action);
        // A run parked on an approval is waiting on a *button*, not on an
        // answer: it never owns the owner's next message.
        return {
          text: result.text.trim() === '' ? AWAITING_APPROVAL_REPLY : result.text,
        };
      }
      // Stored now, bound to this agent and this conversation, and handed back
      // as rows: how they are *drawn* is the surface's business, and it reads
      // the profile rather than its own name to decide.
      const stored = await storeTurnOffers(pool, {
        sink: offers,
        agentId: agent.id,
        conversationId,
        now: new Date(now()),
        log,
      });
      const question = sink.asked
        ? await askQuestion(pool, {
            agentId: agent.id,
            conversationId,
            question: sink.asked.question,
            options: sink.asked.options,
            allowOther: sink.asked.allowOther,
            now: new Date(now()),
          }).catch((err) => {
            log(`telegram: storing question failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          })
        : null;
      return {
        text: result.text,
        askedOwner: sink.asked !== undefined,
        ...(stored.length > 0 ? { offers: stored } : {}),
        ...(question ? { question } : {}),
      };
    },
  });

  // Only paired chats get a menu; strangers see none. Each chat's menu names
  // the agent that chat is talking to.
  const publishMenus = async (): Promise<void> => {
    await applyCommandMenus(
      api,
      paired,
      log,
      async (chatId) => (await surface.activeAgent(chatId)).handle,
      canMakeAgents(deps.catalog),
    );
  };
  await publishMenus();

  // The bot's profile photo is the default agent's uploaded picture, when it
  // has one. Cosmetic like the menus: a Bot API refusal is logged, no more.
  const photo = (): void => {
    syncProfilePhoto({ api, pool, catalog: deps.catalog })
      .then((outcome) => {
        if (outcome !== 'unchanged') log(`telegram: profile photo ${outcome}`);
      })
      .catch((err) => log(`telegram: profile photo not updated: ${errorText(err)}`));
  };
  photo();

  // The catalog is a façade that can be rebuilt without a restart, and the menu
  // is derived from it: an owner who makes their own maker in session — or
  // deletes the one they had — gets the matching menu on the same turn, not on
  // the next boot. Cosmetic, so a failure is logged and never propagated.
  const unwatchCatalog = watchCatalogReloads(deps.catalog, () => {
    photo();
    publishMenus().catch((err) => {
      log(`telegram: republishing the command menus after a catalog reload failed: ${errorText(err)}`);
    });
  });

  surface.offset = cursor === undefined ? undefined : Number(cursor);

  const done = surface.start();

  return {
    botUsername: me.username ?? undefined,
    botId: me.id,
    approvals,
    paired,
    cursor,
    done,
    syncProfilePhoto: photo,
    async stop(): Promise<void> {
      hostService(env).stop(deps.ctx.ownerId);
      unwatchCatalog();
      surface.stop();
      await done;
    },
  };
}

/** How the startup banner renders a paired identity list. */
export function describePaired(paired: readonly SurfaceIdentity[]): string {
  if (paired.length === 0) {
    return 'none — messages will be ignored until TELEGRAM_OWNER_USER_ID is set';
  }
  return paired
    .map((p) => `${p.externalUserId}${p.externalChatId ? `@chat:${p.externalChatId}` : ''}`)
    .join(', ');
}

export async function main(): Promise<void> {
  await loadEnvironment();

  let wiring;
  try {
    wiring = await createWiringAsync(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    const handle = await startTelegram({
      pool: wiring.pool,
      registry: wiring.registry,
      catalog: wiring.catalog,
      provider: wiring.provider,
      providerFor: wiring.providerFor,
      ctx: wiring.ctx,
      env: process.env,
      now: wiring.now,
    });

    console.log(`buddi telegram surface`);
    console.log(`  bot: @${handle.botUsername ?? '(unknown)'} (id ${handle.botId})`);
    console.log(`  paired owner ids: ${describePaired(handle.paired)}`);
    console.log(`  last cursor: ${handle.cursor ?? '(none)'}`);
    console.log(`  model: ${wiring.model} (${wiring.credentialKind})`);
    if (wiring.secrets) {
      const sources = Object.entries(wiring.secrets.sources)
        .map(([name, source]) => `${name}<-${source}`)
        .join(', ');
      console.log(`  vault: ${wiring.secrets.vault}${sources ? ` (${sources})` : ''}`);
    }

    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping telegram surface…`);
      void handle.stop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await handle.done;
    console.log('telegram surface stopped cleanly');
  } finally {
    await wiring.pool.end();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
