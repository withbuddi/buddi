/**
 * The dashboard's HTTP server — bound to loopback, CSRF-checked, and CORS-free.
 *
 * docs/architecture.md, "Owner and surface authentication": the dashboard
 * binds to `127.0.0.1` by default, CSRF and `Origin` checks gate every write,
 * and remote access is an explicit, authenticated transport. The binding is the credential. Each
 * rule runs here before any handler sees a request:
 *
 *   1. **Rate limit.** Failed authentications are counted per address; over
 *      budget is `429` with no body. Valid sessions and fresh, valid tickets
 *      still work, so a stale polling tab cannot lock out the owner.
 *   2. **Open on loopback.** A server bound to a loopback address serves every
 *      request that arrives on one, with no ticket and no expiry: the owner
 *      bookmarks `http://127.0.0.1:4317/` and it works, across restarts and
 *      idle months. The threat a token would answer — a remote party — cannot
 *      reach a loopback socket, and the browser-borne one is answered below and
 *      by the absence of CORS. A session is minted silently when the browser
 *      has none, so the CSRF machinery below works unchanged; nothing the owner
 *      does ever shows an authentication step.
 *   3. **The ticket exchange.** Only on a non-loopback binding (or by explicit
 *      ask): a `?t=` on any page GET is verified against the installation's token
 *      and answered with a redirect to a clean URL carrying an HttpOnly session
 *      cookie. The ticket is good for its five minutes however many times it
 *      is opened: a browser opens a pasted link more than once (it prerenders,
 *      then navigates; an extension may fetch it too), and a one-time rule
 *      turned that into a blank refusal for the owner. Whoever could reuse it
 *      within five minutes had it already; after that it is a signature over
 *      an expired time. The token never appears in a log line, an error, or
 *      the redirect target.
 *   4. **The session, when the binding is not loopback.** Anything else without
 *      a live session cookie is `401` with an empty body. Not a message, not a
 *      `WWW-Authenticate`, not a different status for "expired" — one bit, and
 *      no hint.
 *   5. **Writes.** A mutating method additionally needs the double-submit CSRF
 *      header to match its cookie *and* an `Origin`/`Referer` that is the bound
 *      address. Either failing is `403`, empty. This is the rule that survives
 *      open access: a page on another origin can send this server a request,
 *      but it cannot claim to be the dashboard, and it cannot read a single
 *      response back.
 *
 * No `Access-Control-*` header is ever emitted, and `OPTIONS` is refused: a
 * page on another origin gets no preflight and no permission.
 */
import { runningAgentRuns } from '@buddi/runtime';
import { agentMuteRoute, focusRoute, listNotificationsRoute, markSeenRoute, notificationSettingsRoute, presenceRoute, testChannelRoute } from './notifications.js';
import { catalogSkillLookup, discardProposalFromWeb, keepAllProposalsFromWeb, keepProposalFromWeb, readProposals, registryChangeLookup } from './proposals.js';
import { latestDigest, readDigestSchedule, setDigestSchedule } from '../agents/learning-digest.js';
import { readAgentSkills, removeLearnedSkillFromWeb } from '../agents/learned-skills.js';
import {
  createSkillRoute,
  deleteSkillRoute,
  editSkillRoute,
  grantSkillRoute,
  listSkillsRoute,
  skillDetailRoute,
  skillDownload,
  skillFileRoute,
  skillImage,
  stagedFileRoute,
  stagedImage,
  acceptBundleRoute,
  trustSkillRoute,
  type SkillsDeps,
} from './skills.js';
import { discardStaged, incomingDirFor, receiveBundleUpload, stageBundle, uploadLabel } from './skill-bundles.js';
import { bindMcpRequests, requestThroughMcp } from '../mcp/requests.js';
import { randomUUID, createHmac, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { continueBrowserTask } from '../surfaces/browser-continuation.js';
import { carryOverDeps } from '../surfaces/carry-over.js';
import { deleteCarryOver } from '../surfaces/browser-handoff.js';
import { ProviderSettingsError, type ProviderSettings } from '../providers.js';
import { ProviderAccountError, type ProviderAccounts } from '../provider-accounts.js';
import { agentSearchPath, EXAMPLES_AGENTS_DIR } from '../agents/catalog.js';
import { setDelegatesFromWeb } from './write.js';
import { mlxhBaseUrl, probeMlxh } from '../mlxh.js';
import { PullRefusal, createOllamaPulls, ollamaMachine, type OllamaMachine, type OllamaPulls } from '../ollama-local.js';
import {
  OnboardingRefusal,
  hasOwnerAgent,
  WEB_ONBOARDING_STEPS,
  WEB_ONBOARDING_SURFACE,
  claimOpeningTurn,
  createFirstAgent,
  OLLAMA_BASE_URL,
  probeOllama,
  readOnboarding,
  rebindBrain,
  updateFirstAgent,
  withFirstRunFacts,
  type OnboardingDeps, readFirstAgentPersona } from './onboarding.js';
import type { LiveRegistry as LiveRegistryShape } from '../plugins/live.js';
import { TakeOnRefusal, readTakeOn, readTakeOnOffers, startTakeOn, type TakeOnDeps } from './take-on.js';
import {
  TelegramWebError,
  saveTelegramToken,
  telegramBot,
  telegramDevices,
  telegramPairing,
  telegramStatus,
  unpairTelegramDevice,
  type TelegramControl,
  type TelegramWebDeps,
} from './telegram.js';
import {
  PAGE_ROUTE,
  sendPageFile,
  actOnPage,
  actRateLimited,
  listPageDescriptors,
  runPageQuery,
  type PagesDeps,
} from './pages.js';
import { listSecrets, ownerLoginKey, ownerLoginNames, ownerLoginStore, secretUses, secretsAct, type SecretsDeps } from './secrets.js';
import { sayRoute, transcribeRoute, type SpeechRouteDeps } from './speech.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentCatalog, JobControl, JobState, CoreToolContext, ToolRegistry } from '@buddi/core';
import { asksEachTime, getAction, idleRolloverMs, inRecovery, listMissions, listPendingActions, isJobState, parseAgentFile, setSentinelEnabled, snoozeFinding, snoozeFindings, unmuteFindings, type ActionRecord } from '@buddi/core';
import { actOnAlerts, askPrompt, findingsForAsk, muteAlert } from './alerts.js';
import type { Pool } from 'pg';
import type { BrowserController } from '@buddi/tool-browser';
import { connectionsOf, type ConnectionsService } from '@buddi/tool-mcp';
import { CONNECTIONS_CALLBACK_PATH, connectionsRoute } from './connections.js';
import { browserHost } from '../browser-host.js';
import { hostService } from '@buddi/tool-host';
import { listToolPermissions, revokeToolPermission, getArtifact, readArtifactBytes, artifactBytesExist, discardUnreferencedUpload, listLibrary, getLibraryEntry, decodeCursor, filterKey, textPreviewable, readArtifactPrefix, FILE_FAMILIES, LIBRARY_PAGE_MAX, type FileFamily, type FileOrigin, getOwnerProfile, saveOwnerProfile, listGroups, getGroup, createGroup, updateGroup, archiveGroup, deleteGroup, restoreGroup, clearGroupHistory, groupHistorySize, GROUP_UNDO_MS, GroupRefusal, type GroupCandidate, createGroupConversation, listGroupConversations, latestGroupConversation, openGroupRequest, conversationGroup, type GroupRow, type PermissionScope } from '@buddi/core';
import { EXPORT_MIME, MAX_EXPORT_SOURCE_BYTES, exportFormats, exportName, type ExportFormat } from '../export/document.js';
import { ExportRefused, runExport } from '../export/convert.js';
import { createVault } from '@buddi/core';
import { beginOnboarding, completeOnboarding, getOnboarding, markStepDone, setOnboardingDetails, skipOnboarding, readWebSetting, writeWebSetting, isAssetKey, readPluginAsset } from '@buddi/core';
import { listMemory, setPreference, forgetPreference, updateNote, forgetNote } from '@buddi/tool-memory';
import { purgeGroups, stopGroupWork } from './group-lifecycle.js';
import {
  engineChangeFromBody,
  readAgentEngines,
  readDefaultAgent,
  readEngineOptions,
  setAgentEngineFromWeb,
  setDefaultAgentFromWeb,
} from './agents.js';
import { writeDefaultAgentRecord } from '../agents/default-agent.js';
import { ownerEditableInput, updateAgentFromOwner, PlatformRefusal } from '../agents/platform.js';
import { readAgentProfile } from './profile.js';
import { readToolPicker } from './tool-picker.js';
import { AVATAR_IMAGE } from './chat.js';
import { AvatarRefusal, MAX_AVATAR_INPUT_BYTES, normaliseAvatar, type NormalisedAvatar } from '../agents/avatar-image.js';
import { avatarVersions, pictureUrl, readAvatar, removeAvatar, writeAvatar } from '../agents/avatars.js';
import path_ from 'node:path';
import { readFileSync } from 'node:fs';
import {
  ATTACHMENTS_UNAVAILABLE,
  CHAT_CONVERSATIONS_LIMIT,
  CHAT_UNAVAILABLE,
  WEB_CHAT_SURFACE,
  WebChat,
  conversationAgent,
  readChatAgents,
  readChatConversations,
  readChatTranscript,
  type WebChatDeps,
} from './chat.js';
import { readAgentAttention, streamAttention } from './attention.js';
import { PreviewApp, PreviewTickets, parsePreviewApiPath } from './preview.js';
import { allowedOrigins, isLoopback, webAssetsDir, webUrl, type WebConfig } from './config.js';
import {
  TAILSCALE_SETTING_KEY,
  daemonWhois,
  plausibleLogin,
  proxiedThroughTailscale,
  tailscaleProvider,
  tailscaleSelf,
  tailscaleServeCommand,
  toTailscaleSetting,
  type TailscaleProfile,
  type TailscaleWhois,
} from './access/tailscale.js';
import {
  CLOUDFLARE_SETTING_KEY,
  cloudflareProvider,
  createJwks,
  normalizeTeamDomain,
  plausibleTeamDomain,
  validateCloudflareInput,
  type CloudflareAccessSetting,
  type Jwks,
} from './access/cloudflare.js';
import { arrivalOf } from './access/arrival.js';
import type { HttpTransport } from '@buddi/runtime';
import { CloudflareApiError, createCloudflareApi, CLOUDFLARE_PERMISSION_LINES, CLOUDFLARE_TOKEN_URL } from './access/cloudflare-api.js';
import {
  CLOUDFLARE_SETUP_KEY,
  checkSetupInput,
  claimSetupOperation,
  freshProgress,
  setupBusySentence,
  setupOperation,
  type SetupLease,
  removeCloudflareSetup,
  runCloudflareSetup,
  type SetupDeps,
  type SetupProgress,
  type SetupRecord,
} from './access/cloudflare-setup.js';
import { ownerSecretTokenStore, type CloudflareTokenStore } from './access/cloudflare-token.js';
import { connectorTokenStore, supervisorConnector, type ConnectorControl } from './access/cloudflare-connector.js';
import { createAccessRegistry } from './access/registry.js';
import { createIngress, type Ingress } from './access/ingress.js';
import type { AccessContext, AccessProviderId, AccessRefusal } from './access/provider.js';
import { clientKey } from './client-key.js';
import { appLinkFor, retryHref, sendSignedOut, wantsSignedOutPage, type SignedOutOptions } from './signed-out.js';
import { extensionEndpoint, type ExtensionEndpoint } from './extension.js';
import { REMOTE_HAND_SOCKET_PATH, RemoteHandEndpoint } from './remote-hand.js';
import {
  csrfCookieName,
  CSRF_HEADER,
  sessionCookieName,
  requestPort,
  BodyTooLargeError,
  first,
  cookieHeader,
  parseCookies,
  parseUrl,
  readJsonBody,
  requestOrigin,
  requestScope,
  sendEmpty,
  sendJson,
  sendText,
} from './http.js';
import {
  boundedLimit,
  readAgents,
  readApprovals,
  readConversation,
  readConversations,
  readEventKinds,
  readEvents,
  readJobs,
  readJobFailures,
  readMissions,
  readOverview,
  setGlanceHidden,
  setHomeDismissed,
  readOffers,
  readReminders,
  readSentinels,
  toApprovalView,
} from './read.js';
import {
  RateLimiter,
  SessionStore,
  type Session,
  type SessionScope,
} from './sessions.js';
import { supervisorCall } from './service.js';
import {
  backupJobRoute,
  createBackupRoute,
  discardUpload,
  listBackups,
  passphraseRoute,
  receiveUpload,
  restoreRoute,
  scheduleRoute,
  verifyBackupRoute,
  type RouteReply,
} from './backups.js';
import {
  acceptAgentRoute,
  approveRoute,
  listPlugins,
  pluginJobRoute,
  receivePluginUpload,
  rejectRoute,
  openedRoute,
  stageRoute,
  toggleRoute,
  uninstallRoute,
  updateRoute,
  uploadRoute,
  type PluginsDeps,
  type PluginsEngine,
} from './plugins.js';
import { marketAssetRoute, marketRoute } from './market.js';
import {
  catalogueRoute,
  agentsCatalogue,
  installRoute as catalogueInstallRoute,
  jobRoute as catalogueJobRoute,
  confirmJobRoute as catalogueConfirmJobRoute,
  planRoute as cataloguePlanRoute,
  removePreviewRoute,
  removeRoute as removeAgentRoute,
  updatePlanRoute as catalogueUpdatePlanRoute,
  updateRoute as catalogueUpdateRoute,
  type CatalogueDeps,
} from './catalogue.js';
import { createCatalogueService } from './catalogue-source.js';
import { catalogueBindingOf } from '../agents/platform.js';
import { pluginFoldersRoute } from './folders.js';
import { tipsRoute } from '../tips/route.js';
import { approvalAsk } from './approval-ask.js';
import { createWidgets, widgetsRoute } from './widgets.js';
import { createRequirements, type Requirements } from '../plugins/requires.js';
import { placesList, placesRoute } from './places.js';
import { peopleRoute } from './people.js';
import { syncDateMissions } from '../missions/dates.js';
import { resumeParkedForPage } from '../missions/parked.js';
import { type HttpArea } from '@buddi/core';
import { checkProfilePatch } from '../owner-profile-edit.js';
import { readFacts, webSettingsStore } from '../tips/facts.js';
import { dismissAgentOffer, isPendingAccept, raiseAgentOffers, readAgentOffers, type AgentOffersDeps } from './agent-offers.js';
import {
  currentVersion,
  lockVersion,
  upgradeJobRoute,
  upgradeRoute,
  versionCheckRoute,
  versionRoute,
  type VersionDeps,
} from './version.js';
import { leaveRecoveryMode, readRecoveryView } from './recovery.js';
import { readNeedsYou, type NeedsYou } from './needs-you.js';
import { readRail, setRailPageHidden } from './rail.js';
import { BUILD_MISSING, serveAsset, serveShellAtRoot } from './static.js';
import { StreamBudget, frame, resumeCursor, streamConversation } from './stream.js';
import { ensureWebToken, verifyTicket } from './token.js';
import { MAX_UPLOAD_BYTES, readUpload } from './upload.js';
import { LOCKED_BODY, LockUnavailable, allowedWhileLocked, clientOf, createLock } from './lock.js';
import { acknowledgePassphrase, passphraseNotice, type PassphraseNoticeDeps } from './passphrase-notice.js';
import { cliToolRoute } from './cli-tool.js';
import { createTokenStore, uninstallBackupRoute, uninstallJobRoute, uninstallPlanRoute, uninstallRoute as removeBuddiRoute, withoutPassphrase } from './uninstall.js';
import { matchApiRoute, TOKEN_REFUSALS } from './api-routes.js';
import { QUIET_UNAVAILABLE_TEXT, pluginCommands } from './composer.js';
import { createEngagementHooks } from '../missions/engagement.js';
import { apiTokensRoute, bearerOf, verifyApiToken, type ApiTokenView } from './api-tokens.js';
import { LockImageRefusal, MAX_LOCK_IMAGE_BYTES, normaliseLockImage } from './lock-image.js';
import { lockPicturesFrom } from './lock-backgrounds.js';
import {
  cancelJobFromWeb,
  cancelReminderFromWeb,
  decideApprovalFromWeb,
  retryJobFromWeb,
  retryJobsFromWeb,
  dismissJobsFromWeb,
  undismissJobsFromWeb,
  setMissionEnabledFromWeb,
  keepMissionFromWeb,
  answerStillUsefulFromWeb,
  setPausedFromWeb,
  setScheduleFromWeb,
  dismissOfferFromWeb,
  dismissOffersFromWeb,
  takeOfferFromWeb,
  type WriteDeps,
  type WriteResult,
} from './write.js';

/** How long one account's connection test answers again instead of calling the provider. */
const ACCOUNT_TEST_COOLDOWN_MS = 10_000;

/** How often approvals past their expiry are swept, and waiting delegations told. */
export const EXPIRY_SWEEP_MS = 60_000;
export interface WebServerDeps {
  /**
   * Plugin readiness and requirements, shared with `serve`'s minute loop
   * (plugins/requires.ts). Made here when absent.
   */
  requirements?: Requirements;
  /** The first run's Ollama pull and machine facts, for a test; made here when absent (ollama-local.ts). */
  ollamaPulls?: OllamaPulls;
  ollamaMachine?: () => OllamaMachine;
  /** The place finder's road, for a test; Open-Meteo through core's guard otherwise. */
  placesHttp?: HttpArea;
  /** Host controller; test instances can inject a fake. Reads never enable it. */
  browser?: BrowserController;
  pool: Pool;
  registry: ToolRegistry;
  catalog: AgentCatalog;
  ctx: CoreToolContext;
  timezone: string;
  now: () => Date;
  config: WebConfig;
  /** The installation's dashboard token. Never logged, never sent anywhere. */
  token: string;
  /** The queue, when this process runs one. */
  jobs?: JobControl | undefined;
  /**
   * The environment the engine controls resolve credentials against. Passed
   * explicitly, as everywhere else: nothing here discovers a credential.
   */
  env?: NodeJS.ProcessEnv | undefined;
  providerSettings?: ProviderSettings;
  providerAccounts?: ProviderAccounts;
  /**
   * The plugin engine. Injected only by tests, which fake every one of its
   * functions; a running gateway resolves the real one from `../plugins/`.
   */
  plugins?: PluginsEngine | undefined;
  /**
   * This process's Telegram surface, when it runs one.
   *
   * The dashboard can then take a token from the owner and have the phone
   * working before they put it down. A process without one keeps the token and
   * says it will be there next time buddi starts.
   */
  telegram?: TelegramControl | undefined;
  /**
   * Post a pending approval to the owner's Telegram chat — the same hook an
   * unattended run uses. An MCP write raises its card on both surfaces
   * (docs/mcp.md §2); without it the card is on the dashboard only.
   */
  askApproval?: ((action: ActionRecord) => Promise<void>) | undefined;
  /** Where the built UI lives. Defaults to `packages/web/dist`. */
  assetsDir?: string | undefined;
  /**
   * Settings → Connections (docs/connections.md). Defaults to the service
   * bound to the registry's connections plugin; a test passes its own.
   */
  connections?: ConnectionsService | undefined;
  /**
   * Idle session lifetimes, by scope. Injected only by tests — the defaults in
   * `sessions.ts` are the product, and nothing reads this from the environment.
   */
  sessionTtlMs?: Partial<Record<SessionScope, number>> | undefined;
  /**
   * Whether the gate is open regardless of the binding. Derived from the
   * binding itself (loopback is open), and overridable only by tests, which
   * cannot reach a loopback-bound socket from anywhere else and so could not
   * otherwise exercise the closed gate.
   */
  openAccess?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
  /**
   * Everything the browser needs to be a *talking* surface: the per-agent
   * provider adapter, the artifact store, the memory hook, the pause gate.
   *
   * Optional, and the optionality is the point. A process that serves the
   * dashboard but has no provider wired — a test, a read-only deployment —
   * still serves every read and every existing write; the chat routes answer
   * 503 with a sentence saying so, rather than the server failing to start.
   */
  chat?: Omit<WebChatDeps, 'pool' | 'catalog' | 'registry' | 'ctx' | 'now' | 'timezone' | 'log'>;
  /**
   * The browser extension's WebSocket endpoint. One per data dir by default;
   * a test passes its own so two servers never share a pairing.
   */
  extension?: ExtensionEndpoint;
  /**
   * The local Tailscale daemon, injected. A test passes a whois and a status
   * of its own; a running gateway talks to `tailscaled` over its unix socket.
   */
  tailscale?: {
    whois?: TailscaleWhois;
    self?: () => Promise<{ available: boolean; self: TailscaleProfile | null }>;
  } | undefined;
  /**
   * Cloudflare Access's signing keys, injected. A test passes a JWKS of its
   * own; a running gateway fetches the team's through the transport.
   */
  cloudflare?: {
    jwks?: Jwks;
    /**
     * "Set it up for me": Cloudflare's API (a test's fake at `baseUrl`), the
     * token store (owner secrets by default), the platform the install line
     * is for, and the health poll's pace.
     */
    api?: { transport?: HttpTransport | undefined; baseUrl?: string | undefined } | undefined;
    tokens?: CloudflareTokenStore | undefined;
    platform?: NodeJS.Platform | undefined;
    setup?: Pick<SetupDeps, 'pollMs' | 'waitMs' | 'sleep'> | undefined;
    /** The supervisor's connector (a test's fake); by default the control socket when one is set, else none. */
    connector?: ConnectorControl | null | undefined;
  } | undefined;
}

export interface WebServer {
  server: Server;
  /** The port actually bound — resolved after `listen`, so `0` works in tests. */
  port: number;
  url: string;
  /**
   * The port previews are served on: a second loopback listener, on a second
   * origin, so that untrusted code the owner is looking at never runs on the
   * dashboard's. Null when it could not be bound.
   */
  previewPort: number | null;
  /**
   * The ingress listener for cloudflared (web/access/ingress.ts): bound only
   * while Cloudflare Access is on. `port()` is null while it is not.
   */
  ingress: Ingress;
  /** The chat surface, when this process wired one. */
  chat?: WebChat | undefined;
  close(): Promise<void>;
}

/**
 * Which chat surface belongs to which server.
 *
 * A `WeakMap` rather than a second return value from `createWebApp`: every
 * existing caller keeps its one-line construction, and a server that is
 * garbage-collected takes its queue with it.
 */
/** `buddi service`'s launchd label (SERVICE_LABEL in the cli, which depends on this package, not the other way). */
export const LAUNCHD_LABEL = 'com.buddi.serve';

const WEB_CHATS = new WeakMap<Server, WebChat>();

/**
 * Which preview listener belongs to which dashboard, for the same reason and
 * in the same shape as `WEB_CHATS`: `startWebServer` binds it, `close` takes
 * it down, and a caller that built a bare `createWebApp` is unaffected.
 */
const PREVIEW_APPS = new WeakMap<Server, PreviewApp>();

/**
 * What a dashboard says to its open pages just before it closes: one
 * `closing` frame on every live stream, naming the restart or stop the page
 * itself asked for when it was one (`for`), so a page another device or the
 * CLI restarted under draws "Restarting buddi" rather than errors, and
 * reloads once the next process answers `/_buddi/ready` with a new `boot`.
 */
const CLOSING_SAYS = new WeakMap<Server, () => Promise<void>>();

/** Each server's ingress listener (web/access/ingress.ts). */
const INGRESS_OF = new WeakMap<Server, Ingress>();
/** Each server's request handler, for a listener without a socket of its own (the relay, provider 3). */
const DISPATCH_OF = new WeakMap<Server, (req: IncomingMessage, res: ServerResponse) => void>();

/** The ingress listener belonging to a server built by `createWebApp`. */
export function ingressOf(server: Server): Ingress | undefined {
  return INGRESS_OF.get(server);
}

/**
 * The request handler of a server built by `createWebApp`: what an in-process
 * listener hands a request to after tagging its arrival (`markRequestArrival`).
 */
export function dispatchOf(server: Server): ((req: IncomingMessage, res: ServerResponse) => void) | undefined {
  return DISPATCH_OF.get(server);
}

/** How long a closing frame may take to reach the pages before the sockets go. */
const CLOSING_FLUSH_MS = 250;

/** The chat surface this server is running, if any. */
/** The most of a text file a preview shows; the download has the whole. */
const PREVIEW_TEXT_BYTES = 100_000;

/**
 * How an artifact may be previewed inline, or null for download only. Text
 * is an allowlist of genuinely textual formats, never a binary container
 * however it is named; HTML and SVG count as text and are served as
 * text/plain, so they are read and never rendered.
 */
function previewKind(mime: string, filename: string | null): 'image' | 'pdf' | 'text' | null {
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (textPreviewable(mime, filename)) return 'text';
  return null;
}

/** A group as the page draws it. */
function groupView(group: GroupRow): { id: string; name: string; coordinator: string; members: string[]; contextCapChars: number; createdAt: string } {
  return { id: group.id, name: group.name, coordinator: group.coordinator, members: group.members, contextCapChars: group.contextCapChars, createdAt: group.createdAt.toISOString() };
}

/**
 * Who may be put in a room, as core's membership check wants to see them.
 *
 * The rule lives in core and is applied identically by the route below and by
 * `platform.update_group`: a loaded agent, one this machine can actually run,
 * and never the maker — which is the settings door, not a colleague.
 */
function groupRoster(catalog: AgentCatalog): GroupCandidate[] {
  return catalog.list().map((agent) => ({
    id: agent.id,
    name: agent.name,
    roles: agent.roles,
    available: agent.available && agent.heldBack === undefined,
  }));
}

/** Every IANA zone this Node knows, for a picker. */
/** A reply the backup module composed, on the wire. */
function reply(res: ServerResponse, out: RouteReply): void {
  sendJson(res, out.status, out.body);
}

function knownTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try { return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : []; } catch { return []; }
}

export function webChatOf(server: Server): WebChat | undefined {
  return WEB_CHATS.get(server);
}

/** The preview listener this dashboard owns, if any. */
export function previewAppOf(server: Server): PreviewApp | undefined {
  return PREVIEW_APPS.get(server);
}

/** The query parameter carrying a five-minute ticket. */
export const TICKET_PARAM = 't';

/** How many doors along from `dashboard + 1` a preview port is looked for. */
export const PREVIEW_PORT_ATTEMPTS = 10;

/** How many preview links one session may mint in a minute. */
export const PREVIEW_LINK_LIMIT = 10;
export const PREVIEW_LINK_WINDOW_MS = 60_000;

export function createWebApp(deps: WebServerDeps): Server {
  const limiter = new RateLimiter();
  /*
   * Pairing has a budget of its own, and it is spent per session rather than
   * per address. On loopback every client shares one remote key, so a stale
   * tab or any other local process failing to sign in would otherwise have
   * spent the owner's pairing budget before their first attempt. Five tries
   * in five minutes, never touched by the sign-in limiter above; the pending
   * pair in `extension.ts` keeps its own five-attempt limit on the code.
   */
  const pairLimiter = new RateLimiter(5, 5 * 60_000);
  const assetsDir = deps.assetsDir ?? webAssetsDir();
  const log = deps.log ?? ((line: string) => console.error(line));
  /*
   * Sessions are kept in the database (`core.dashboard_sessions`, hashed ids
   * only), so a restart or an upgrade no longer signs the owner out.
   */
  const sessions = new SessionStore(deps.sessionTtlMs ?? {}, undefined, { db: deps.pool, log });
  const extension = deps.extension ?? extensionEndpoint(deps.env ?? process.env, log);
  /*
   * The remote hand, on the same upgrade listener as the extension socket.
   *
   * Its gate is this server's, not the extension's: the owner's session cookie
   * on the upgrade, an Origin this server would accept a write from, and the
   * CSRF token as the socket's first frame. A tailnet session is re-confirmed
   * here exactly as it is on every request, because a socket that outlives the
   * identity behind it is a socket nobody revoked.
   */
  const hand = new RemoteHandEndpoint({
    log,
    browser: () => deps.browser ?? browserHost(deps.env ?? process.env),
    authorize: async (req) => {
      const now = deps.now();
      const origin = requestOrigin(req);
      if (origin === undefined || !allowed().has(origin)) return null;
      const scope = requestScope(req);
      const session = await sessions.resolve(parseCookies(req.headers.cookie)[sessionCookieName(cookiePort(req))], scope, now);
      if (!session) return null;
      // A locked dashboard drives nothing (docs/dashboard.md, "Lock screen").
      if (await lock.locked(session)) return null;
      if (session.via === 'provider') {
        const confirmed = await access.confirm(session, req, now);
        // "Could not ask", or a stray request without the provider's proof:
        // no socket now, but the session stays.
        if (confirmed.answer === 'unanswered' || confirmed.answer === 'refuse') return null;
        if (confirmed.answer === 'end') {
          await sessions.destroy(session.id).catch(() => {});
          return null;
        }
      }
      return session;
    },
  });
  /*
   * Previews live on their own origin (see `preview.ts`), so all this server
   * owns of them is the link: a session-gated route that mints a single-use
   * ticket for the other listener. Nothing of the dashboard is served there
   * and nothing of it is served here.
   */
  const previewTickets = new PreviewTickets(deps.now);
  /*
   * How often one session may ask for a preview link.
   *
   * Minting is cheap but it is not free — each one is a live credential held
   * in this process — and the store above is bounded, so an unbounded caller
   * would be evicting other people's tickets rather than filling memory. Ten
   * a minute is more panels than a dashboard has.
   */
  const previewLinks = new RateLimiter(PREVIEW_LINK_LIMIT, PREVIEW_LINK_WINDOW_MS);
  const previews: PreviewApp = new PreviewApp({
    registry: deps.registry,
    ctx: deps.ctx,
    log,
    tickets: previewTickets,
    // Only the dashboard may frame a preview. The list is the same one a
    // write's `Origin` is checked against, and it never contains the preview
    // origin itself.
    frameAncestors: () => [...allowed()],
    ownPorts: (): number[] => {
      const own = (server.address() as AddressInfo | null)?.port;
      const preview: number | null = previews.port();
      return [own, preview].filter((port): port is number => typeof port === 'number');
    },
  });
  // Plugin readiness and requirements: serve's, or this server's own.
  const requirements =
    deps.requirements ??
    createRequirements({ registry: deps.registry, ctx: deps.ctx, env: deps.env ?? process.env, pool: deps.pool, now: deps.now, log });
  // Ollama on this computer: the first run's pull of a small model, one at a time.
  const ollamaPulls = deps.ollamaPulls ?? createOllamaPulls({ baseUrl: OLLAMA_BASE_URL });
  const machine = deps.ollamaMachine ?? (() => ollamaMachine());
  // Home's widgets: one cache per server (web/widgets.ts).
  const widgets = createWidgets({ pool: deps.pool, registry: deps.registry, ctx: deps.ctx, now: deps.now, log });
  /*
   * The lock screen (web/lock.ts): which sessions are locked, the PIN, the
   * gate below. A session that locks has its streams closed and its remote
   * hand let go on the spot, and every half minute the sessions holding a
   * stream are asked again, so one left idle past the delay is locked and cut
   * off even if its page never says a word.
   */
  /*
   * What needs the owner, counted once (web/needs-you.ts): Home's counts, the
   * rail's badge and the lock screen all read this, so they agree.
   */
  const needsYou = (): Promise<NeedsYou> =>
    readNeedsYou({
      pool: deps.pool,
      registry: deps.registry,
      now: deps.now(),
      agentOffers: async () =>
        (await readAgentOffers({
          registry: deps.registry, ctx: deps.ctx, now: deps.now, log, pool: deps.pool, agentIds: () => deps.catalog.list().map((a) => a.id),
          agentRoles: () => deps.catalog.list().flatMap((a) => a.roles ?? []),
        })).offers,
      signals: async () => {
        const service = deps.connections ?? connectionsOf(deps.registry.manifests());
        return service ? service.signals() : [];
      },
      recoveryActive: () => inRecovery(deps.pool),
    });
  /** Remove buddi from this Mac: the token its plan mints (web/uninstall.ts). */
  const uninstallTokens = createTokenStore();
  const lock = createLock({ pool: deps.pool, sessions, now: deps.now, get timezone() { return deps.timezone; }, widgets, needsYou, log,
    pictures: () => lockPicturesFrom(assetsDir),
    // The status bar's answer, so the lock screen's version line never disagrees with it.
    version: async () => lockVersion(await versionRoute({ env: deps.env ?? process.env, log, assetsDir })) });
  const openStreams = new Map<string, { session: Session; responses: Set<ServerResponse> }>();
  /*
   * This process's boot: answered by `/_buddi/ready`, so a page that watches a
   * restart can tell the process that went from the one that came back.
   * Random, and nothing else: it says which run this is, not when or where.
   */
  const boot = randomUUID();
  /** Set when a page asked the supervisor to restart or stop this process: what the closing frame says. */
  let goingAway: 'restart' | 'stop' | undefined;
  /*
   * The session a live API token acts through: minted on its first request,
   * kept in memory only, one per token (and scope), so a stream budget or a
   * sign-in in progress keyed by session id holds across its requests.
   */
  const tokenSessions = new Map<string, Session>();
  const tokenSession = (holder: ApiTokenView, scope: SessionScope, now: Date): Session => {
    const key = `${holder.id}:${scope}`;
    const held = tokenSessions.get(key);
    if (held && held.expiresAt.getTime() > now.getTime()) {
      held.expiresAt = new Date(now.getTime() + held.ttlMs);
      return held;
    }
    for (const [k, s] of tokenSessions) if (s.expiresAt.getTime() <= now.getTime()) tokenSessions.delete(k);
    const session = sessions.create(scope, now, { via: 'token', client: 'api' }, { persist: false });
    tokenSessions.set(key, session);
    return session;
  };
  const holdStream = (session: Session, res: ServerResponse): (() => void) => {
    let entry = openStreams.get(session.id);
    if (!entry) openStreams.set(session.id, (entry = { session, responses: new Set() }));
    entry.responses.add(res);
    return () => {
      const held = openStreams.get(session.id);
      if (!held) return;
      held.responses.delete(res);
      if (held.responses.size === 0) openStreams.delete(session.id);
    };
  };
  lock.onLocked((session) => {
    hand.revoke((lease) => lease === session.id);
    for (const res of openStreams.get(session.id)?.responses ?? []) res.end();
  });
  const idleSweep = setInterval(() => {
    for (const { session } of openStreams.values()) void lock.locked(session).catch(() => {});
  }, 30_000);
  idleSweep.unref();
  const writeDeps: WriteDeps = {
    pool: deps.pool,
    registry: deps.registry,
    ctx: deps.ctx,
    now: deps.now,
    jobs: deps.jobs,
    log,
  };
  const chat = deps.chat
    ? new WebChat({
        // The fresh conversation opens with a note the agent's own model wrote
        // from the old one, plus any plugin's lines (surfaces/carry-over.ts).
        onConversationRollover: (agentId, previousConversationId, conversationId, reason) => continueBrowserTask(deps.pool, deps.browser ?? browserHost(deps.env ?? process.env), { ownerId: deps.ctx.ownerId, agentId, previousConversationId, conversationId }, reason, carryOverDeps({
          catalog: deps.catalog,
          providerFor: (agent) => deps.chat!.providerFor(agent),
          registry: deps.registry,
          ctx: deps.ctx,
          log,
        })),
        pool: deps.pool,
        catalog: deps.catalog,
        registry: deps.registry,
        ctx: deps.ctx,
        now: deps.now,
        get timezone() { return deps.timezone; },
        log,
        browser: deps.browser ?? browserHost(deps.env ?? process.env),
        ...deps.chat,
      })
    : undefined;
  /*
   * Anything the owner said to a run that did not survive the restart.
   *
   * Not awaited: it is a query and a promotion per stranded conversation, and
   * the dashboard must come up whether or not the database is quick about it.
   * Failures are the recovery's own business and land in the log.
   */
  void chat?.recoverPendingInput().catch((err) => log(`web chat: recovering queued input failed: ${err instanceof Error ? err.message : String(err)}`));
  /*
   * Give it back: the run that waited on the page carries on. A mission parked
   * on it wakes (missions/parked.ts); otherwise the conversation the take-over
   * held gets its turn. Either way with no message from the owner.
   */
  const offGiveBack = (deps.browser ?? browserHost(deps.env ?? process.env)).onGiveBack?.((info) => {
    void (async () => {
      if (await resumeParkedForPage(deps.pool, info.conversationId, deps.now())) return;
      await chat?.continueAfterGiveBack({ conversationId: info.conversationId, agentId: info.agentId });
    })().catch((err: unknown) => log(`browser: carrying on after the page was given back failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  /*
   * A sign-in the owner made on a page they held, kept when they say Save
   * (docs/browser.md, "Saving a sign-in"): the browser host's keeper hands the
   * pair to core's owner-secret store, as the owner, and to nothing else.
   */
  {
    const loginDeps = { pool: deps.pool, registry: deps.registry, ctx: deps.ctx, now: deps.now };
    (deps.browser ?? browserHost(deps.env ?? process.env)).logins?.useStore(ownerLoginStore(loginDeps), ownerLoginNames(loginDeps), ownerLoginKey(deps.env ?? process.env));
  }
  const streams = new StreamBudget();
  // A bundle script's run asks every time: its card offers no standing permission (`asksEachTime`).
  const permissionScopes = (tool: string, envelope?: unknown): Record<string, unknown> => deps.registry.lookup(tool)?.reusableApproval && !asksEachTime(envelope)
    ? { permissionScopes: ['conversation', 'always'] } : {};
  /** What a card adds to an approval row: its scopes, and its heading in the owner's words (approval-ask.ts). */
  const approvalExtras = (a: { tool: string; envelope?: unknown; preview: string }): Record<string, unknown> => ({
    ...permissionScopes(a.tool, a.envelope),
    ask: approvalAsk(a.tool, a.preview, deps.registry.list().find((t) => t.name === a.tool)?.description),
  });
  writeDeps.resumeInteractive = (action, outcome) => chat?.resumeHost(action, outcome);
  /*
   * What an approved MCP write reaches: the functions the dashboard's own
   * routes below call, and nothing else (docs/mcp.md §2).
   */
  const unwrap = async <T>(result: WriteResult<T> | Promise<WriteResult<T>>): Promise<T> => {
    const settled = await result;
    if (!settled.ok) {
      const error = (settled.body as { error?: unknown } | undefined)?.error;
      throw new Error(typeof error === 'string' ? error : `refused (${settled.status})`);
    }
    return settled.body as T;
  };
  bindMcpRequests(deps.registry, {
    pool: deps.pool,
    catalog: deps.catalog,
    ...(deps.providerAccounts
      ? {
          accounts: () => deps.providerAccounts!.view(),
          assignAccount: (agentId: string, change: { accountId: string; model: string }) =>
            deps.providerAccounts!.assign(agentId, change),
        }
      : {}),
    setDefaultAgent: (agentId) =>
      unwrap(setDefaultAgentFromWeb({ catalog: deps.catalog, record: (id) => writeDefaultAgentRecord(deps.pool, id) }, agentId)),
    defaultAgent: () => readDefaultAgent(deps.catalog).defaultAgentId,
    keepProposal: (id, text) =>
      unwrap(keepProposalFromWeb(writeDeps, id, text, {
        catalog: deps.catalog,
        reload: () => (deps.catalog as { reload?: () => void }).reload?.(),
        env: deps.env ?? process.env,
      })),
    discardProposal: (id, reason) => unwrap(discardProposalFromWeb(writeDeps, id, reason)),
    memory: {
      setPreference: (input) => setPreference(deps.pool, { ...input, now: deps.now() }),
      forgetPreference: (input) => forgetPreference(deps.pool, { ...input, now: deps.now() }),
      updateNote: (input) => updateNote(deps.pool, input),
      forgetNote: (id) => forgetNote(deps.pool, { id, now: deps.now() }),
    },
    // buddi.profile_update: Settings → Profile's save, places through the same geocoder.
    profile: { env: deps.env ?? process.env, log, ...(deps.placesHttp ? { http: deps.placesHttp } : {}) },
  });
  // The binding is the credential: loopback is open, anything else keeps the
  // ticket-and-session gate. The override is a test seam, nothing more.
  const openAccess = deps.openAccess ?? (deps.env?.BUDDI_WEB_REQUIRE_AUTH !== '1' && isLoopback(deps.config.host));

  /*
   * Trusted access providers (web/access/): something in front of buddi
   * proves who is knocking, buddi checks the proof itself, and its own
   * `remote` session rules apply. Tailscale (provider 1) asks the local
   * daemon; Cloudflare Access (provider 2) verifies the JWT Access signs.
   *
   * Which sessions were established that way is a field on the session itself
   * (`via: 'provider'` and `provider`), not a map beside it. It is what keeps
   * a provider session from widening its own access (changing a provider
   * wants a session from this machine) and what lets `/api/session` say how
   * the browser got in.
   */
  const whois = deps.tailscale?.whois ?? daemonWhois();
  const tailscaleSelfOf = deps.tailscale?.self ?? (() => tailscaleSelf());
  const jwks = deps.cloudflare?.jwks ?? createJwks({ log });
  const boundPort = (): number => (server.address() as AddressInfo | null)?.port ?? deps.config.port;
  const accessCtx: AccessContext = {
    dashboardPort: boundPort,
    ingressPort: () => ingress.port(),
    publicOrigin: () => deps.config.publicOrigin,
  };
  const tailscale = tailscaleProvider({ whois, self: tailscaleSelfOf, log });
  const cloudflare = cloudflareProvider({ jwks, log, ingressProblem: () => ingress.problem() });
  const access = createAccessRegistry({
    providers: [tailscale, cloudflare],
    readSetting: (key) => readWebSetting(deps.pool, key),
  });
  /** The command that publishes this dashboard on the tailnet, with this installation's own ports. */
  const serveCommand = (): string => tailscaleServeCommand(boundPort(), deps.config.publicOrigin);
  const readTailscaleSetting = async (): Promise<ReturnType<typeof toTailscaleSetting>> => access.settingOf(tailscale);
  /*
   * The Cloudflare setting as last read, so the synchronous Origin check can
   * honour the public address the panel stored. Refreshed on every read.
   */
  let cloudflareSeen: CloudflareAccessSetting | null = null;
  const readCloudflareSetting = async (): Promise<CloudflareAccessSetting> => {
    cloudflareSeen = await access.settingOf(cloudflare);
    return cloudflareSeen;
  };

  /** Did this request come through a provider, or does it hold a session one minted? Then the block is read-only. */
  const throughProvider = (req: IncomingMessage, session: Session): boolean =>
    session.via === 'provider' || arrivalOf(req) !== 'main' || proxiedThroughTailscale(req);
  /** The Tailscale panel's whole payload (unchanged by the move behind the provider interface). */
  const tailscaleView = async (req: IncomingMessage, session: Session) => {
    const stored = await readTailscaleSetting();
    const daemon = await tailscaleSelfOf();
    return {
      enabled: stored.enabled,
      login: stored.login,
      available: daemon.available,
      self: daemon.self,
      proxied: throughProvider(req, session),
      // What the owner has to run on this machine, with this installation's own two ports in it.
      serveCommand: serveCommand(),
    };
  };
  /** The Cloudflare panel's payload: the stored fields, the status, the setup copy with the real ingress port. */
  const cloudflareView = async (req: IncomingMessage, session: Session) => {
    const stored = await readCloudflareSetting();
    const status = await cloudflare.status(stored, accessCtx);
    const visit = cloudflare.lastVisit();
    return {
      enabled: stored.enabled,
      teamDomain: stored.teamDomain,
      aud: stored.aud,
      email: stored.email,
      publicOrigin: stored.publicOrigin,
      status,
      ingressPort: ingress.port() ?? accessCtx.dashboardPort() + 2,
      listening: ingress.port() !== null,
      lastVisit: visit ? { at: visit.at.toISOString(), email: visit.email } : null,
      setup: cloudflare.setup(stored, accessCtx),
      proxied: throughProvider(req, session),
    };
  };
  /**
   * Store a Cloudflare setting and do what a Save does: end the sessions it
   * admitted unless the same person, team and application stay on, then bind
   * or close the ingress listener. The panel's Save and "Set it up for me"
   * both come through here.
   */
  const applyCloudflareSetting = async (value: CloudflareAccessSetting): Promise<void> => {
    const before = await readCloudflareSetting();
    await writeWebSetting(deps.pool, CLOUDFLARE_SETTING_KEY, value);
    await readCloudflareSetting();
    const same = before.enabled && value.enabled && before.email.toLowerCase() === value.email.toLowerCase()
      && before.teamDomain === value.teamDomain && before.aud === value.aud;
    if (!same) {
      const forgotten = new Set<string>();
      await sessions.forget((s) => { const drop = s.via === 'provider' && s.provider === 'cloudflare-access'; if (drop && s.id) forgotten.add(s.id); return drop; });
      hand.revoke((lease) => forgotten.has(lease), 'Cloudflare access changed. Sign in again.');
    }
    await ingress.sync();
    // Cloudflare Access on or off: the supervisor starts or stops its connector to match.
    void connectorControl()?.sync().catch(() => undefined);
  };

  /*
   * "Set it up for me" (access/cloudflare-setup.ts): one run at a time, in
   * the background — the health wait lasts as long as the owner takes to run
   * one command — and its progress kept here for the panel to poll. The token
   * is an owner secret, read once per run.
   */
  let cfTokens: CloudflareTokenStore | null = deps.cloudflare?.tokens ?? null;
  const tokenStore = (): CloudflareTokenStore => (cfTokens ??= ownerSecretTokenStore(deps.pool as never, createVault({ env: deps.env ?? process.env })));
  let setupRun: { progress: SetupProgress; abort: AbortController; done: Promise<void> } | null = null;
  const readSetupRecord = async (): Promise<SetupRecord | null> => {
    const row = await readWebSetting<SetupRecord>(deps.pool, CLOUDFLARE_SETUP_KEY);
    return row && typeof row === 'object' && typeof row.host === 'string' ? row : null;
  };
  /** The supervisor's connector, when a supervisor runs this gateway (install's cloudflared.ts). */
  const connectorControl = (): ConnectorControl | undefined => {
    if (deps.cloudflare?.connector !== undefined) return deps.cloudflare.connector ?? undefined;
    const socket = (deps.env ?? process.env).BUDDI_SUPERVISOR_SOCKET?.trim();
    if (!socket) return undefined;
    return supervisorConnector(socket, connectorTokenStore(deps.pool as never, createVault({ env: deps.env ?? process.env })));
  };
  // Once at startup: a supervisor whose own boot sync could not read the
  // setting yet (the gateway runs the migrations) catches up now, not at the
  // next settings save or the hourly tick. Only when Access is on: off, the
  // supervisor's boot sync already stopped it and there is nothing to catch up.
  void readCloudflareSetting()
    .then((setting) => (setting.enabled ? connectorControl()?.sync() : undefined))
    .catch(() => undefined);
  const setupDepsFor = (token: string, lease: SetupLease, signal?: AbortSignal): SetupDeps => ({
    api: createCloudflareApi({ token, transport: deps.cloudflare?.api?.transport, baseUrl: deps.cloudflare?.api?.baseUrl }),
    ingressPort: ingress.port() ?? (askedIngressPort() || null) ?? accessCtx.dashboardPort() + 2,
    platform: deps.cloudflare?.platform ?? process.platform,
    readSetting: readCloudflareSetting,
    saveSetting: applyCloudflareSetting,
    readRecord: readSetupRecord,
    saveRecord: (record) => writeWebSetting(deps.pool, CLOUDFLARE_SETUP_KEY, record),
    test: (team) => jwks.refresh(team),
    ...(deps.cloudflare?.setup ?? {}),
    connector: connectorControl(),
    signal,
    lease,
  });
  const setupView = async () => {
    const record = await readSetupRecord();
    return {
      progress: setupRun?.progress ?? freshProgress(record?.host ?? '', record?.email ?? ''),
      tokenStored: await tokenStore().has().catch(() => false),
      record: record ? { host: record.host, email: record.email, zone: record.zone.name, teamDomain: record.teamDomain } : null,
      permissions: CLOUDFLARE_PERMISSION_LINES,
      tokenUrl: CLOUDFLARE_TOKEN_URL,
      ingressPort: ingress.port() ?? (askedIngressPort() || null) ?? accessCtx.dashboardPort() + 2,
    };
  };
  /** Run in the background; the lease (claimed by the caller) goes when the run ends. */
  const startSetup = (lease: SetupLease, job: (onProgress: (p: SetupProgress) => void, signal: AbortSignal) => Promise<SetupProgress>, first: SetupProgress): void => {
    const abort = new AbortController();
    const run: { progress: SetupProgress; abort: AbortController; done: Promise<void> } = { progress: first, abort, done: Promise.resolve() };
    setupRun = run;
    run.done = job((p) => { run.progress = p; }, abort.signal)
      .then((p) => { run.progress = p; })
      .catch(() => { run.progress = { ...run.progress, state: 'failed', error: 'The setup stopped unexpectedly. Try again.' }; })
      .finally(() => lease.release());
  };
  /*
   * A setting written elsewhere (`buddi access cloudflare setup` writes the
   * database directly) reaches the ingress listener here: bound or closed
   * within a quarter of a minute.
   */
  const ingressResync = setInterval(() => {
    void readCloudflareSetting().then((setting) => {
      if (setting.enabled !== (ingress.port() !== null)) return ingress.sync();
      return undefined;
    }).catch(() => undefined);
  }, 15_000);
  ingressResync.unref?.();

  /** Every provider's row, for "Sign in from elsewhere". */
  const accessView = async (req: IncomingMessage, session: Session) => ({
    proxied: throughProvider(req, session),
    providers: await Promise.all(access.providers.map(async (p) => {
      const setting = await access.settingOf(p);
      return { id: p.id, title: p.title, identity: p.identity, proxy: p.proxy, enabled: p.enabled(setting), status: await p.status(setting, accessCtx) };
    })),
  });

  /*
   * The ingress listener (specs/trusted-access.md §3.3): a second loopback
   * listener, the dashboard's port + 2 (or `BUDDI_INGRESS_PORT`), bound only
   * while a this-machine provider other than Tailscale is on. Every request
   * on it is remote, whatever its headers or Host say, and it never passes a
   * loopback-only check. cloudflared points here, never at the dashboard's
   * own port, so a tunnel arrival can never be mistaken for this machine.
   */
  /** `BUDDI_INGRESS_PORT`, when it names a port. */
  function askedIngressPort(): number | null {
    const raw = (deps.env ?? process.env).BUDDI_INGRESS_PORT?.trim();
    const asked = raw ? Number(raw) : NaN;
    return Number.isInteger(asked) && asked >= 0 && asked <= 65535 ? asked : null;
  }
  const ingress = createIngress({
    onRequest: (req, res) => onRequest(req, res),
    onUpgrade: (req, socket, head) => { server.emit('upgrade', req, socket, head); },
    port: () => askedIngressPort() ?? (deps.config.port === 0 ? 0 : boundPort() + 2),
    wanted: async () => (await readCloudflareSetting()).enabled,
    log,
  });

  /**
   * The pair a browser holds: the HttpOnly session and the readable CSRF value
   * the page has to echo back in a header. Both carry the same `Max-Age`, which
   * is the lifetime this session's scope earned it.
   */
  /*
   * Secure cookies for a remote session behind an HTTPS proxy: the configured
   * public origin, or anything on the ingress listener (Cloudflare's edge
   * always speaks HTTPS to the browser).
   */
  const secureCookies = (req: IncomingMessage, scope: SessionScope): boolean =>
    scope === 'remote' && (!!deps.config.publicOrigin || arrivalOf(req) === 'ingress');

  const sessionCookies = (req: IncomingMessage, session: Session): string[] => {
    const maxAgeSeconds = SessionStore.maxAgeSeconds(session);
    return [
      cookieHeader(sessionCookieName(cookiePort(req)), session.id, { httpOnly: true, maxAgeSeconds, secure: secureCookies(req, session.scope) }),
      cookieHeader(csrfCookieName(cookiePort(req)), session.csrf, { httpOnly: false, maxAgeSeconds, secure: secureCookies(req, session.scope) }),
    ];
  };

  /**
   * The same pair, expired: what a response carries when the browser presented
   * a session that is gone, so it stops presenting it. A forgotten tab or a
   * polling page then sends no credential at all, which counts as nothing.
   */
  const expiredCookies = (req: IncomingMessage): string[] => {
    const secure = secureCookies(req, requestScope(req));
    return [
      cookieHeader(sessionCookieName(cookiePort(req)), '', { httpOnly: true, maxAgeSeconds: 0, secure }),
      cookieHeader(csrfCookieName(cookiePort(req)), '', { httpOnly: false, maxAgeSeconds: 0, secure }),
    ];
  };

  /**
   * What the signed-out page should offer this request: how it arrived,
   * which provider can sign it in, why it could not, and whether a lockout is
   * running.
   */
  const signedOutFor = async (
    req: IncomingMessage,
    pathname: string,
    search: string,
    now: Date,
    refused: { provider: AccessProviderId; refusal: AccessRefusal } | undefined,
    key: string,
  ): Promise<SignedOutOptions> => {
    const lockedForMs = limiter.retryAfterMs(key, now);
    const locked = lockedForMs > 0 ? { lockedForMs } : {};
    if (arrivalOf(req) === 'ingress') {
      return {
        retry: retryHref(pathname, search),
        arrived: 'remote',
        provider: {
          title: cloudflare.title,
          ...(refused?.provider === 'cloudflare-access' ? { refusal: refused.refusal.refusal, kind: refused.refusal.kind } : { refusal: 'no-assertion', kind: 'other' as const }),
        },
        ...locked,
      };
    }
    const proxied = proxiedThroughTailscale(req);
    let publicHost: string | undefined;
    try { publicHost = deps.config.publicOrigin ? new URL(deps.config.publicOrigin).hostname : undefined; } catch { publicHost = undefined; }
    let host: string | undefined;
    try { host = req.headers.host ? new URL(`http://${req.headers.host}`).hostname : undefined; } catch { host = undefined; }
    const scope = requestScope(req);
    const arrived: SignedOutOptions['arrived'] =
      proxied || (publicHost !== undefined && host === publicHost) ? 'tailnet' : scope === 'local' ? 'local' : 'remote';
    const setting = arrived === 'tailnet' ? await readTailscaleSetting() : null;
    const tailscaleRefusal = refused?.provider === 'tailscale' ? refused.refusal : undefined;
    return {
      retry: retryHref(pathname, search),
      arrived,
      tailscaleSignIn: !!setting?.enabled && tailscaleRefusal?.kind !== 'login',
      ...(tailscaleRefusal?.kind === 'login' ? { tailscaleRefusal: tailscaleRefusal.sentence } : {}),
      ...(tailscaleRefusal?.kind === 'unanswered' ? { tailscaleUnanswered: true } : {}),
      // From the Chrome extension's popup, on this computer: offer buddi.app first.
      ...((link) => arrived === 'local' && link ? { appLink: link } : {})(appLinkFor(search, first(req.headers['user-agent']) ?? '', req.headers.host ?? '')),
      ...locked,
    };
  };

  /**
   * The port this request's cookies are named after (http.ts says why they
   * carry one): the port the browser sees, from the request's Host, so the
   * loopback page and the tailnet page each keep their own pair. Set, read and
   * checked through this one function.
   */
  const cookiePort = (req: IncomingMessage): number => {
    // Cloudflare's edge serves the page on HTTPS's own port, whatever
    // cloudflared says on the way in; the page names its cookie by it.
    if (arrivalOf(req) === 'ingress') {
      const host = req.headers.host ?? '';
      if (!/:\d+$/.test(host.replace(/^\[[^\]]*\]/, ''))) return 443;
    }
    return requestPort(req, (server.address() as AddressInfo | null)?.port ?? deps.config.port, deps.config.publicOrigin);
  };

  /**
   * The origins a write may claim, resolved against the port actually bound.
   *
   * It has to be lazy: with `port: 0` the OS picks the port only at `listen`,
   * and an origin set computed from the *requested* port would then reject
   * every write the page itself makes.
   */
  let originCache: { port: number; extra: string; set: Set<string> } | undefined;
  const allowed = (): Set<string> => {
    const bound = (server.address() as AddressInfo | null)?.port ?? deps.config.port;
    // The public address the Cloudflare panel stored, while that provider is on.
    const extra = cloudflareSeen?.enabled ? cloudflareSeen.publicOrigin : '';
    if (originCache?.port !== bound || originCache.extra !== extra) {
      const set = new Set(allowedOrigins({ ...deps.config, port: bound }));
      if (extra) set.add(extra);
      originCache = { port: bound, extra, set };
    }
    return originCache.set;
  };

  // The chat surface is reachable from the server object it belongs to, so a
  // caller that needs to drain it on shutdown (or in a test) can, without
  // `createWebApp` growing a second return value every existing caller would
  // have to unpack.
  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err) => {
      // The lock could not say whether this request may pass: refused, never let in (web/lock.ts).
      if (err instanceof LockUnavailable) {
        log('web: the lock screen\'s state could not be read; refusing until it can');
        if (!res.headersSent) return sendEmpty(res, 503, { 'Retry-After': '5' });
        return res.end();
      }
      // A defect is a 500 with nothing in it. The sentence goes to the log,
      // where only the owner can read it.
      log(`web: ${req.method} ${req.url} failed: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) sendEmpty(res, 500);
      else res.end();
    });
  }
  const server: Server = createServer(onRequest);

  if (chat) WEB_CHATS.set(server, chat);
  INGRESS_OF.set(server, ingress);
  // The seam the relay (provider 3) hands its in-process requests to,
  // tagged `markRequestArrival(req, 'relay')` first. Never replayed as HTTP to 127.0.0.1.
  DISPATCH_OF.set(server, onRequest);
  PREVIEW_APPS.set(server, previews);
  CLOSING_SAYS.set(server, async () => {
    const said = frame('closing', goingAway === undefined ? {} : { for: goingAway });
    const flushed: Array<Promise<void>> = [];
    for (const { responses } of openStreams.values()) {
      for (const res of responses) {
        if (res.writableEnded || res.destroyed) continue;
        // Ended, not just written: an ended response is flushed before its
        // socket goes, where a frame still queued would be dropped with it.
        flushed.push(new Promise<void>((resolve) => {
          try { res.end(said, () => resolve()); } catch { resolve(); }
        }));
      }
    }
    if (flushed.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(flushed), new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSING_FLUSH_MS); })]);
    clearTimeout(timer);
  });
  // "Your browser": the only path this server ever upgrades. Attached here
  // rather than in `startWebServer` so every caller, tests included, has it.
  extension.attach(server);
  extension.attachPath(REMOTE_HAND_SOCKET_PATH, (req, socket, head) => hand.upgrade(req, socket, head));
  server.once('close', () => { extension.shutdown(); hand.shutdown(); clearInterval(idleSweep); clearInterval(ingressResync); setupRun?.abort.abort(); void ingress.close(); });
  server.once('close', () => offGiveBack?.());
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = deps.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = parseUrl(req);
    /*
     * The bucket failed sign-ins count against (client-key.ts, §7.5): by the
     * arrival path, so a stranger behind a tunnel can never lock out this
     * machine or the tailnet. A request on the ingress listener is asked of
     * its provider at once — a JWT check against cached keys — because its
     * bucket depends on it: `cf:unverified` until it verifies, then the
     * client's own address.
     */
    let key = access.bucketOf(req) ?? clientKey(req);
    const early = arrivalOf(req) === 'main' ? null : await access.identify(req, now);
    if (early?.result.ok && early.result.identity.bucket) key = early.result.identity.bucket;

    // No CORS, and therefore no preflight.
    if (method === 'OPTIONS') return sendEmpty(res, 405);

    // A port answering 401 is not evidence that this installation is ready.
    // Domain-separated challenge proof never sends the install secret to that port.
    // Answered on every binding: `buddi mcp` asks it before it presents a
    // ticket, so a port held by some other buddi never sees one.
    if (method === 'GET' && url.pathname === '/_buddi/ready') {
      const challenge = url.searchParams.get('challenge') ?? '';
      if (!/^[a-f0-9]{64}$/.test(challenge)) return sendEmpty(res, 400);
      return sendJson(
        res,
        200,
        { proof: createHmac('sha256', deps.token).update(`buddi-ready-v1:${challenge}`).digest('hex'), boot },
        { 'Cache-Control': 'no-store' },
      );
    }

    // A remote socket or proxy metadata can only earn remote access. It
    // decides how long a session minted now lives, and it must keep matching
    // for as long as that session is used.
    const scope = requestScope(req);

    /*
     * Where a connected service's consent page sends the owner back
     * (docs/connections.md). The page itself, before the session gate: the
     * session cookie is SameSite=Strict and does not ride a redirect from
     * another site, and minting a fresh session here would orphan the one
     * the sign-in was bound to. It is the dashboard's own shell and nothing
     * else; it hands `code` and `state` to `POST /api/connections/callback`,
     * a same-site request that carries the cookie and the CSRF pair, and the
     * state is checked there against the session that started the sign-in.
     */
    if ((method === 'GET' || method === 'HEAD') && url.pathname === CONNECTIONS_CALLBACK_PATH) {
      const served = await serveShellAtRoot(res, assetsDir);
      if (!served.served) sendText(res, 503, BUILD_MISSING);
      return;
    }

    // The ticket exchange. Only ever on a GET, and only ever on a page URL: a ticket is handed out as a link somebody
    // opens, never as a query on an API call. So under /api/ the parameter is
    // just a parameter, and a poller that happens to use the same name cannot
    // spend a 401 and a sign-in failure on every request.
    const ticket = url.pathname.startsWith('/api/') ? null : url.searchParams.get(TICKET_PARAM);
    if (ticket !== null && (method === 'GET' || method === 'HEAD')) {
      const check = verifyTicket(deps.token, ticket, now);
      if (!check.ok) {
        if (limiter.blocked(key, now)) return sendEmpty(res, 429);
        limiter.fail(key, now);
        // Never says which of "wrong" and "expired" it was — but says it to a
        // person, on the page they opened, rather than as an empty status the
        // browser dresses up as "this page isn't working".
        return sendText(res, 401, 'This sign-in link is no longer valid: a link lasts five minutes.\nRun `buddi` again for a fresh one.\n');
      }
      limiter.reset(key);
      // A ticket takes the installation's token, so it is the one way in that
      // opens a session unlocked: what `buddi dashboard --unlock` hands out.
      const session = sessions.create(scope, now, { via: scope === 'local' ? 'local' : 'ticket', client: clientOf(req.headers['x-buddi-client']) });
      const clean = new URL(url.toString());
      clean.searchParams.delete(TICKET_PARAM);
      return sendEmpty(res, 302, {
        Location: `${clean.pathname}${clean.search}`,
        'Set-Cookie': sessionCookies(req, session),
      });
    }

    /*
     * An owner API token (docs/api.md, "Authentication"): `Authorization:
     * Bearer buddi_…` on an /api request, from a script or another program.
     *
     * It is a credential presented, so a wrong or revoked one counts as a
     * failed sign-in for this address exactly as a stale cookie does. A live
     * one is the owner with no cookie and therefore no CSRF to check, and is
     * answered only on a route the table lets a token call: never one that
     * decides an approval, changes a grant, installs code, opens access or
     * touches a secret. The lock screen does not cover it.
     */
    const bearer = url.pathname === '/api' || url.pathname.startsWith('/api/') ? bearerOf(req.headers.authorization) : undefined;
    if (bearer !== undefined) {
      if (limiter.blocked(key, now)) {
        return sendEmpty(res, 429, { 'Retry-After': String(Math.max(1, Math.ceil(limiter.retryAfterMs(key, now) / 1000))) });
      }
      let holder: ApiTokenView | null;
      try {
        holder = await verifyApiToken(deps.pool, bearer, now);
      } catch (err) {
        log(`web: checking an API token failed: ${err instanceof Error ? err.message : String(err)}`);
        return sendEmpty(res, 503, { 'Retry-After': '5' });
      }
      if (!holder) {
        limiter.failCredential(key, bearer, now);
        return sendEmpty(res, 401, { 'WWW-Authenticate': 'Bearer realm="buddi"' });
      }
      const path = url.pathname.replace(/\/+$/, '') || '/api';
      const route = matchApiRoute(method, path);
      if (!route) return method === 'GET' || method === 'HEAD' ? sendJson(res, 404, { error: 'no such endpoint' }) : sendEmpty(res, 405);
      if (route.token) {
        return sendJson(res, 403, { error: `An API token cannot call ${route.method} ${route.path}. ${TOKEN_REFUSALS[route.token]} Do it on the dashboard.` });
      }
      return api(req, res, url, method, now, tokenSession(holder, scope, now));
    }

    const cookies = parseCookies(req.headers.cookie);
    const presentedSession = cookies[sessionCookieName(cookiePort(req))];
    let session = await sessions.resolve(presentedSession, scope, now);
    /*
     * Why a provider gave this request no identity, when it was asked. Only
     * "this person is not the one allowed" and "could not ask" change what
     * the signed-out page says; every other reason is the ordinary "you're
     * signed out".
     */
    let refused: { provider: AccessProviderId; refusal: AccessRefusal } | undefined =
      early && !early.result.ok ? { provider: early.provider.id, refusal: early.result } : undefined;
    /*
     * Set when the browser presented a session that is gone: the refusal then
     * expires its cookies, so it stops presenting them (and stops counting).
     */
    let forgetCookies = false;
    /*
     * The answer to a refused request: the signed-out page for a person
     * opening a page, the empty status for everything else (docs/web.md).
     * 401 is "signed out", 429 "too many tries from here", 503 "the provider
     * could not be asked; the session is still good, try again".
     */
    const refuse = async (status: 401 | 429 | 503 = 401): Promise<void> => {
      const headers: Record<string, string | string[]> = forgetCookies ? { 'Set-Cookie': expiredCookies(req) } : {};
      if (status === 429) headers['Retry-After'] = String(Math.max(1, Math.ceil(limiter.retryAfterMs(key, now) / 1000)));
      if (status === 503) headers['Retry-After'] = '5';
      if (!wantsSignedOutPage(req, method, url.pathname)) return sendEmpty(res, status, headers);
      return sendSignedOut(res, await signedOutFor(req, url.pathname, url.search, now, refused, key), headers, status);
    };
    /* A provider session this request ended: not a guess, so never a failed sign-in. */
    let revoked = false;

    /*
     * A provider session is re-confirmed on every single request.
     *
     * A cookie on its own would be a bearer token the provider's identity is
     * only loosely related to: it would outlive the setting being turned off,
     * the allowed login being changed, and the device being handed to somebody
     * else. So the provider is asked again — Tailscale's daemon (a whois
     * answer is reused for a minute), Cloudflare's JWT on this very request —
     * and the person it names now must be the one this session was minted
     * for. Anything else and the session is gone, not merely ignored.
     */
    if (session?.via === 'provider') {
      const confirmed = await access.confirm(session, req, now);
      if (confirmed.refusal) refused = { provider: session.provider as AccessProviderId, refusal: confirmed.refusal };
      /*
       * The provider could not be asked (a daemon busy or starting, keys that
       * could not be fetched). That is not an answer about anyone, so the
       * session is not ended for it and nothing is counted. This request waits.
       */
      if (confirmed.answer === 'unanswered') return refuse(503);
      /*
       * This request lacks the provider's proof (Cloudflare's header), but
       * the session is not ended for it: a stray request without the header
       * must not sign the owner out. Nothing is counted either.
       */
      if (confirmed.answer === 'refuse') return refuse(401);
      if (confirmed.answer === 'end') {
        const ended = session.id;
        // A hand this session was holding does not outlive the session.
        hand.revoke((lease) => lease === ended);
        await sessions.destroy(ended);
        session = undefined;
        revoked = true;
        forgetCookies = true;
        // The identity on this very request may still earn a new session below.
        refused = undefined;
      }
    }

    /*
     * Open on loopback: the request is on this machine and the server is bound
     * to this machine, so there is nothing left to authenticate. A session is
     * minted silently — the page gets its CSRF pair like any other, writes stay
     * gated by rule 5, and the owner is never shown an authentication step.
     * Minting rather than bypassing the store is what keeps one code path for
     * every request; the cookie is a detail of how CSRF works, not a login.
     */
    if (!session && openAccess && scope === 'local') {
      // Not stored: the next request mints another for free, so there is
      // nothing to keep across a restart and no row per cookie-less poll.
      // While a PIN is set a browser's new session starts locked: clearing the
      // cookie or opening a private window is not a way past the lock screen.
      //
      // Always a browser's session: `x-buddi-client` is a header anybody can
      // send, so here it earns nothing. Only a ticket from the installation
      // token (the exchange above) names a client the lock does not cover.
      const locked = await lock.startLocked('browser');
      session = sessions.create(scope, now, { via: 'local', client: 'browser' }, { persist: false, ...(locked ? { locked } : {}) });
      res.setHeader('Set-Cookie', sessionCookies(req, session));
    }

    /*
     * Signed in through a trusted access provider.
     *
     * Tailscale: the proxy runs on this machine and the daemon confirms who
     * is behind the forwarded address. Cloudflare Access: the JWT Access
     * signed verifies against the team's keys, for this application, naming
     * the allowed email, and it arrived on the ingress listener. When that
     * agrees with the person the owner allowed, the request gets a `remote`
     * session exactly as the ticket exchange would have minted one — same
     * cookies, same 12 hours, same CSRF on every write. Anything less falls
     * through to the 401 below. A provider identity signs in during a lockout.
     */
    if (!session) {
      const asked = early ?? await access.identify(req, now);
      if (asked && !asked.result.ok) refused = { provider: asked.provider.id, refusal: asked.result };
      if (asked?.result.ok) {
        const identity = asked.result.identity;
        limiter.reset(key);
        const locked = await lock.startLocked('browser');
        const capMs = Math.min(
          asked.provider.absoluteCapMs,
          identity.expiresAt ? Math.max(0, identity.expiresAt.getTime() - now.getTime()) : asked.provider.absoluteCapMs,
        );
        session = sessions.create('remote', now, {
          via: 'provider',
          provider: identity.provider,
          providerSubject: identity.subject,
          ...(identity.detail ? { providerDetail: identity.detail } : {}),
          absoluteCapMs: capMs,
        }, locked ? { locked } : {});
        res.setHeader('Set-Cookie', sessionCookies(req, session));
      }
    }

    if (!session) {
      // Rate-limit failed authentication, not authenticated traffic. A stale
      // tab behind the same proxy must not lock out a valid recovery ticket
      // or an already authenticated owner (nor direct local access).
      //
      // Only a request that presented a credential is an attempt. One with no
      // cookie at all (a reconnect check, a health probe) guessed nothing, and
      // the same stale cookie counts once however often it is sent: all tailnet
      // and tunnel traffic shares 127.0.0.1, so a forgotten tab must not be
      // able to lock the owner out of every way in.
      //
      // A provider's credential that failed (a Cloudflare assertion that does
      // not verify) is an attempt too, cookie or not, in the bucket the
      // provider names (per Cf-Connecting-Ip). No assertion at all, or keys
      // that could not be fetched, carry no attempt.
      const tried = refused?.refusal.attempt;
      if (!presentedSession && !tried) return refuse();
      if (tried) key = tried.bucket;
      if (presentedSession) forgetCookies = true;
      if (revoked) return refuse();
      if (limiter.blocked(key, now)) return refuse(429);
      if (tried) limiter.failCredential(key, tried.credential, now);
      if (presentedSession) limiter.failCredential(key, presentedSession, now);
      return refuse();
    }

    /*
     * Slide the browser's copy, not just the server's.
     *
     * `sessions.get` has already pushed the server-side expiry out; without
     * this the cookie itself would still die at the `Max-Age` it was minted
     * with, and someone who used the dashboard all day would be logged out
     * mid-sentence. The header is attached here rather than at each `send*`
     * so every route — JSON, static asset, event stream — carries it, and
     * `renewCookie` is what keeps it to roughly one response per half-life
     * instead of one per request.
     */
    if (sessions.renewCookie(session, now)) res.setHeader('Set-Cookie', sessionCookies(req, session));

    const mutating = method !== 'GET' && method !== 'HEAD';

    if (mutating) {
      const origin = requestOrigin(req);
      if (origin === undefined || !allowed().has(origin)) return sendEmpty(res, 403);
      const presented = req.headers[CSRF_HEADER];
      const header = Array.isArray(presented) ? presented[0] : presented;
      if (!SessionStore.csrfMatches(session, header)) return sendEmpty(res, 403);
      if (cookies[csrfCookieName(cookiePort(req))] !== session.csrf) return sendEmpty(res, 403);
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      /*
       * The lock screen's gate, after the session and its CSRF: a locked
       * session gets 423 for everything but what the lock screen itself
       * draws and the two ways off it (web/lock.ts).
       */
      const path = url.pathname.replace(/\/+$/, '') || '/api';
      if (!allowedWhileLocked(method, path) && (await lock.locked(session))) return sendJson(res, 423, LOCKED_BODY);
      return api(req, res, url, method, now, session);
    }
    if (mutating) return sendEmpty(res, 405);

    const served = await serveAsset(res, assetsDir, url.pathname);
    if (!served.served) sendText(res, 503, BUILD_MISSING);
  }

  /* ---------------------------------------------------------------- *
   * The API
   * ---------------------------------------------------------------- */

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    now: Date,
    session: Session,
  ): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || '/api';
    const q = url.searchParams;
    const browser = deps.browser ?? browserHost(deps.env ?? process.env);
    /** Everything the first-run routes need, resolved per request. */
    const onboardingDeps = (): OnboardingDeps => ({
      pool: deps.pool,
      catalog: deps.catalog,
      providerAccounts: deps.providerAccounts,
      agentsDir: agentSearchPath(deps.env ?? process.env).owner.dir,
      examplesDir: EXAMPLES_AGENTS_DIR,
      reload: () => (deps.catalog as { reload?: () => void }).reload?.(),
      registry: deps.registry,
      offers: (opts) => readTakeOnOffers({ env: deps.env ?? process.env, log }, opts),
    });
    /** What the backup routes need: the environment, and somewhere to log. */
    const backupDeps = (): { env: NodeJS.ProcessEnv; log: (line: string) => void } => ({
      env: deps.env ?? process.env,
      log,
    });
    /** Home's passphrase card: the backups, the words, and where "I saved it" is kept. */
    const noticeDeps = (): PassphraseNoticeDeps => ({
      pool: deps.pool,
      listBackups: () => listBackups(backupDeps()),
      passphrase: () => passphraseRoute(backupDeps(), 'GET'),
      now: deps.now,
      log,
    });
    /** What the plugin page routes need: the registry, and the owner's context. */
    const pagesDeps = (): PagesDeps => ({ registry: deps.registry, ctx: deps.ctx, now: deps.now, log });
    const agentOffersDeps = (): AgentOffersDeps => ({
      ...pagesDeps(),
      pool: deps.pool,
      agentIds: () => deps.catalog.list().map((a) => a.id),
      agentRoles: () => deps.catalog.list().flatMap((a) => a.roles ?? []),
      // Only a first run under way holds the offers back: an older install
      // that never ran it keeps them.
      firstRunDone: async () => (await getOnboarding(deps.pool)).state !== 'in-progress',
    });
    /** The Keys and secrets page (docs/owner-secrets.md §6): core's own queries and ownerOnly tools. */
    const secretsDeps = (): SecretsDeps => ({ pool: deps.pool, registry: deps.registry, ctx: deps.ctx, now: deps.now, ...(browser.logins ? { logins: browser.logins } : {}) });
    /** Talking to buddi on the dashboard: the speech plugin's two tools, as the owner. */
    const speechDeps = (): SpeechRouteDeps => ({ pool: deps.pool, registry: deps.registry, ctx: deps.ctx, now: deps.now, agents: () => deps.catalog.list() });
    /** The same, for the version and upgrade routes. */
    const versionDeps = (): VersionDeps => ({ env: deps.env ?? process.env, log, assetsDir });
    /** The same, for the plugin routes, plus the pool migrations and a purge need. */
    const pluginDeps = (): PluginsDeps => ({
      env: deps.env ?? process.env,
      log,
      pool: deps.pool,
      registry: deps.registry,
      requirements,
      ...(deps.plugins ? { engine: deps.plugins } : {}),
    });
    /**
     * The agent catalogue (catalogue.ts): the service the platform tools are
     * bound to when there is one, so the routes and Agent Father read the same
     * list; else one built here over the same market cache.
     */
    const catalogueDeps = (): CatalogueDeps => {
      const live = deps.registry as unknown as Partial<LiveRegistryShape>;
      const bound = catalogueBindingOf(deps.registry);
      const env = deps.env ?? process.env;
      const agentsDir = bound?.agentsDir ?? agentSearchPath(env).owner.dir;
      return {
        ...pagesDeps(),
        env,
        log,
        pool: deps.pool,
        service: bound?.service ?? createCatalogueService({ env, log, registry: deps.registry, ctx: deps.ctx, now: deps.now }),
        binding: bound ?? { catalog: deps.catalog as never, agentsDir, trashRoot: path_.join(path_.dirname(path_.resolve(agentsDir)), '.trash') },
        approve: (actionId) => decideApprovalFromWeb(writeDeps, actionId, 'approved'),
        reject: (actionId) => decideApprovalFromWeb(writeDeps, actionId, 'rejected'),
        ...(deps.plugins ? { engine: deps.plugins } : {}),
        ...(live.register && live.unregister && live.manifests ? { liveRegistry: deps.registry as never } : {}),
      };
    };
    /** The Skills page (skills.ts): the owner's folders, the catalog to check each write against. */
    const skillsDeps = (): SkillsDeps => {
      const bound = catalogueBindingOf(deps.registry);
      const search = agentSearchPath(deps.env ?? process.env);
      const agentsDir = bound?.agentsDir ?? search.owner.dir;
      return {
        catalog: deps.catalog as SkillsDeps['catalog'],
        agentsDir,
        skillsDir: search.owner.skillsDir,
        trashRoot: bound?.trashRoot ?? path_.join(path_.dirname(path_.resolve(agentsDir)), '.trash'),
        plugins: () => deps.registry.manifests().map((m) => m.name),
        now: deps.now,
        pool: deps.pool,
      };
    };
    /** Is a mailbox connected? The email plugin's own read, the one Home's offer asks. */
    const mailboxSet = async (): Promise<boolean> => {
      const answer = await runPageQuery(pagesDeps(), 'email', 'triage_offer', new URLSearchParams()).catch(() => null);
      return answer?.status === 200 && (answer.body as { data?: { wanted?: unknown } } | null)?.data?.wanted === true;
    };
    /** First run's chapter 3: the market, the plugin engine, the live registry, the mailbox. */
    const takeOnDeps = (): TakeOnDeps => {
      const live = deps.registry as unknown as Partial<LiveRegistryShape>;
      return {
        pool: deps.pool,
        env: deps.env ?? process.env,
        log,
        ...(deps.plugins ? { engine: deps.plugins } : {}),
        ...(live.register && live.unregister && live.manifests ? { registry: deps.registry as never } : {}),
        mailboxSet,
        agentIds: () => deps.catalog.list().map((a) => a.id),
        calendarLinked: async () => {
          const answer = await runPageQuery(pagesDeps(), 'calendar', 'settings', new URLSearchParams()).catch(() => null);
          return answer?.status === 200 && (answer.body as { data?: { hasCalendars?: unknown } } | null)?.data?.hasCalendars === true;
        },
      };
    };
    /** The weather at home in one line, for the hello, when the weather plugin answers. */
    const weatherAtHome = async (): Promise<string | null> => {
      const answer = await runPageQuery(pagesDeps(), 'weather', 'today', new URLSearchParams()).catch(() => null);
      const data = (answer?.body as { data?: Record<string, unknown> } | null)?.data;
      if (answer?.status !== 200 || !data || data.setUp !== true) return null;
      const parts = [data.now, data.sky, typeof data.highLow === 'string' && data.highLow !== '' ? `high / low ${data.highLow}` : '']
        .filter((part): part is string => typeof part === 'string' && part !== '');
      return parts.length === 0 ? null : `${typeof data.place === 'string' ? `${data.place}: ` : ''}${parts.join(', ')}`;
    };
    /**
     * May this installation still be restored over from the first-run screen?
     *
     * Only while nothing has been answered and the owner has no agent of their
     * own: after that a restore is a replacement and needs the typed-back
     * confirmation the ordinary route asks for.
     */
    const onboardingRestoreRefusal = async (): Promise<{ status: number; message: string } | null> => {
      const view = await readOnboarding(onboardingDeps());
      if (view.state !== 'pending') {
        return { status: 409, message: 'This buddi has already been set up. Restore from Settings, where it asks you to confirm.' };
      }
      // Any agent of the owner's, a teammate a plugin proposed included: it is
      // a private file a restore would overwrite. Wider than `needs.agent`.
      if (hasOwnerAgent(deps.catalog)) {
        return { status: 409, message: 'This buddi already has an agent. Restore from Settings, where it asks you to confirm.' };
      }
      return null;
    };
    /** What the two Telegram routes need. The environment is the live one. */
    const telegramDeps = (): TelegramWebDeps => ({
      pool: deps.pool,
      env: deps.env ?? process.env,
      ...(deps.telegram ? { telegram: deps.telegram } : {}),
    });

    // Tips: the stack the lightbulb on Home opens, and the pages seen (tips/route.ts).
    if (path === '/api/tips' || path.startsWith('/api/tips/')) {
      let body: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PUT') {
        try {
          const parsed = await readJsonBody(req);
          body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
          return sendJson(res, 400, { error: 'request body must be JSON' });
        }
      }
      const answer = await tipsRoute(
        {
          store: webSettingsStore(deps.pool),
          now: deps.now,
          timezone: deps.timezone,
          facts: () => readFacts({
            pool: deps.pool,
            now: deps.now,
            agents: () => deps.catalog.list(),
            plugins: () => deps.registry.manifests().map((m) => m.name),
            appsWithoutPlugin: () => {
              const apps = browser.status().routes?.find((route) => route.kind === 'apps');
              return apps !== undefined && apps.installed === false && apps.mode !== undefined && apps.mode !== 'off';
            },
            needsSetup: async () => {
              const out: Array<{ plugin: string; note?: string; route?: string }> = [];
              for (const manifest of deps.registry.manifests()) {
                if (manifest.setup === undefined) continue;
                const ready = await requirements.readiness.of(manifest.name);
                if (!ready || ready.ready) continue;
                const page = ready.page === undefined ? undefined : deps.registry.pages().find((p) => p.plugin === manifest.name && p.id === ready.page);
                const route = page === undefined
                  ? undefined
                  : page.place === 'settings'
                    ? `#/settings/p.${manifest.name}${page.id === manifest.name ? '' : `.${page.id}`}`
                    : `#/p/${encodeURIComponent(manifest.name)}/${encodeURIComponent(page.id)}`;
                out.push({ plugin: manifest.name, ...(ready.note ? { note: ready.note } : {}), ...(route ? { route } : {}) });
              }
              return out;
            },
            mailboxSet: async () => {
              const answer = await runPageQuery(pagesDeps(), 'email', 'triage_offer', new URLSearchParams()).catch(() => null);
              return answer?.status === 200 && (answer.body as { data?: { wanted?: unknown } } | null)?.data?.wanted === true;
            },
          }),
        },
        { method, path, body, preview: url.searchParams.get('preview'), peek: url.searchParams.get('peek') === '1' },
      );
      return sendJson(res, answer.status, answer.body);
    }

    // The lock screen: its state and data, Lock now, Unlock, the PIN, its settings and picture (web/lock.ts).
    if (path === '/api/lock' || path.startsWith('/api/lock/')) {
      let body: unknown = {};
      const upload = method === 'POST' && (path === '/api/lock/background' || path === '/api/lock/background/portrait');
      if ((method === 'POST' || method === 'PUT') && !upload) {
        try {
          body = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, { error: 'request body must be JSON' });
        }
      }
      const answer = await lock.route({
        method,
        path,
        body,
        session,
        query: url.searchParams,
        ...(upload ? {
          upload: async () => {
            const file = await readUpload(req, MAX_LOCK_IMAGE_BYTES);
            if (!file.ok) return { ok: false as const, status: file.status, error: file.status === 413 ? 'A picture can be at most 10 MB.' : file.error };
            try {
              return { ok: true as const, image: normaliseLockImage(file.file.bytes, file.file.mime) };
            } catch (err) {
              if (err instanceof LockImageRefusal) return { ok: false as const, status: err.status, error: err.message };
              throw err;
            }
          },
        } : {}),
      });
      if (answer === null) return sendJson(res, 404, { error: 'no such endpoint' });
      if ('image' in answer) {
        const etag = `"${answer.image.sha256}"`;
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (req.headers['if-none-match'] === etag) return sendEmpty(res, 304);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', String(answer.image.jpeg.length));
        res.statusCode = 200;
        res.end(method === 'HEAD' ? undefined : answer.image.jpeg);
        return;
      }
      if (answer.status === 204) return sendEmpty(res, 204);
      return sendJson(res, answer.status, answer.body);
    }

    // `/quiet` typed into the composer: the verb Telegram and the terminal answer, in their words (missions/engagement.ts).
    if (path === '/api/quiet' && method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'request body must be JSON' });
      }
      const raw = (body as { arg?: unknown } | null)?.arg;
      const arg = typeof raw === 'string' ? raw.trim().slice(0, 40) : '';
      const text = await createEngagementHooks({ pool: deps.pool, now: deps.now, timezone: deps.timezone, unavailableText: QUIET_UNAVAILABLE_TEXT }).quiet(arg);
      return sendJson(res, 200, { text });
    }

    // Home's widgets: the gallery, the owner's layout, each placed one's body (web/widgets.ts).
    if (path === '/api/widgets' || path.startsWith('/api/widgets/')) {
      let body: unknown = {};
      if (method === 'PUT' || (method === 'POST' && path === '/api/widgets/preview')) {
        try {
          body = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, { error: 'request body must be JSON' });
        }
      }
      const answer = await widgetsRoute(widgets, { method, path, body, query: url.searchParams });
      return sendJson(res, answer.status, answer.body);
    }

    // Settings → Connections: every method, one module (web/connections.ts).
    if (path === '/api/connections' || path.startsWith('/api/connections/')) {
      let body: Record<string, unknown> = {};
      if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
        try {
          const parsed = await readJsonBody(req);
          body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
          return sendJson(res, 400, { error: 'request body must be JSON' });
        }
      }
      const answer = await connectionsRoute(
        { service: deps.connections ?? connectionsOf(deps.registry.manifests()), registry: deps.registry, catalog: deps.catalog, pool: deps.pool, ownerId: deps.ctx.ownerId },
        { method, path, body, sessionId: session.id, origin: requestOrigin(req) },
      );
      return sendJson(res, answer.status, answer.body);
    }

    if (method === 'GET' || method === 'HEAD') {
      /*
       * The library: what the store holds, for a person (docs/files.md). Read
       * only, owner only, never an agent tool. Origin is what the row says.
       */
      /*
       * The two things the dashboard owns about a preview.
       *
       * `link` is the way in: this route is behind the dashboard's session
       * gate, and what it hands back is a URL on the *other* origin carrying
       * a single-use ticket. That exchange is the whole of how the owner's
       * authority reaches a preview — no dashboard cookie is ever honoured
       * there, so nothing else can.
       *
       * `check` is the plugin's own question — "is it being served, and does
       * it assume it owns a host?" — answered from what the proxy saw on the
       * first HTML response it forwarded. A warning for the owner that
       * `developer.preview` prints beside the link, never a gate.
       */
      const previewApi = parsePreviewApiPath(path);
      if (previewApi?.what === 'check') {
        return sendJson(res, 200, await previews.check(previewApi.plugin, previewApi.name));
      }
      if (previewApi?.what === 'link') {
        if (!previews.serves(previewApi.plugin)) return sendJson(res, 404, { error: 'no such preview' });
        const port = previews.port();
        if (port === null) {
          return sendJson(res, 503, { error: 'Previews are not being served: the preview port could not be bound.' });
        }
        if (previewLinks.blocked(session.id, now)) {
          return sendJson(res, 429, { error: 'Too many preview links just now. Try again in a minute.' });
        }
        previewLinks.fail(session.id, now);
        const ticket = previewTickets.mintTicket(previewApi.plugin, previewApi.name);
        /*
         * Where the link points is decided by where the owner *is*. A session
         * that came through the public origin is on another device, and
         * 127.0.0.1 there is that device, not this one; the preview's own
         * public origin — a second `tailscale serve` mapping, configured and
         * never inferred — is the only address such a link can name. Without
         * one, the loopback link is still handed out, and says nothing new.
         */
        const origin =
          session.scope === 'remote' && deps.config.previewPublicOrigin
            ? deps.config.previewPublicOrigin
            : `http://127.0.0.1:${port}`;
        return sendJson(res, 200, {
          url: `${origin}/preview/${previewApi.plugin}/${previewApi.name}/?ticket=${ticket}`,
        });
      }

      if (path === '/api/artifacts') {
        const origin = q.get('origin');
        const family = q.get('family');
        if (origin && !['uploaded', 'produced', 'unknown'].includes(origin)) return sendJson(res, 400, { error: '`origin` must be uploaded, produced or unknown' });
        if (family && !(FILE_FAMILIES as readonly string[]).includes(family)) return sendJson(res, 400, { error: `\`family\` must be one of ${FILE_FAMILIES.join(', ')}` });
        const limitRaw = q.get('limit');
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > LIBRARY_PAGE_MAX)) return sendJson(res, 400, { error: `\`limit\` must be 1 to ${LIBRARY_PAGE_MAX}` });
        const cursor = q.get('cursor');
        const filters = { ...(q.get('q') ? { q: q.get('q')!.slice(0, 200) } : {}), ...(origin ? { origin: origin as FileOrigin } : {}), ...(family ? { family: family as FileFamily } : {}) };
        // A cursor is bound to the filters it was issued under; with others it would skip rows.
        if (cursor && !decodeCursor(cursor, filterKey(filters))) return sendJson(res, 400, { error: '`cursor` is not one this listing issued for these filters' });
        const page = await listLibrary(deps.pool, {
          ...filters,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          knownAgentIds: deps.catalog.list().map((a) => a.id),
        });
        return sendJson(res, 200, page);
      }
      const libraryOne = /^\/api\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (libraryOne) {
        const offsetRaw = q.get('contexts');
        const offset = offsetRaw === null ? 0 : Number(offsetRaw);
        if (!Number.isInteger(offset) || offset < 0) return sendJson(res, 400, { error: '`contexts` must be a non-negative integer' });
        const found = await getLibraryEntry(deps.pool, libraryOne[1]!, deps.catalog.list().map((a) => a.id), offset);
        if (!found) return sendJson(res, 404, { error: 'no such file' });
        // The bytes may be gone while the row remains: say so, keep the metadata.
        const artifact = await getArtifact(deps.pool, found.entry.id);
        const available = artifact ? await artifactBytesExist(deps.env ?? process.env, artifact).catch(() => false) : false;
        return sendJson(res, 200, { ...found, available });
      }

      const exported = /^\/api\/artifacts\/([0-9a-f-]{36})\/export\/([a-z]{2,4})$/.exec(path);
      if (exported) {
        const artifact = await getArtifact(deps.pool, exported[1]!);
        if (!artifact) return sendEmpty(res, 404);
        const format = exported[2] as ExportFormat;
        // Only what this file offers: a Markdown document as PDF or Word, a table as Excel.
        if (!exportFormats(artifact.mime, artifact.filename).includes(format)) return sendJson(res, 415, { error: `this file cannot be downloaded as ${format}` });
        // The bytes may be gone while the row remains: say so rather than fail.
        if (!(await artifactBytesExist(deps.env ?? process.env, artifact).catch(() => false))) {
          return sendJson(res, 410, { error: 'the file’s contents are gone from disk' });
        }
        // The file as written is never converted, so it has no size limit; only a conversion does.
        const own = format === exportFormats(artifact.mime, artifact.filename)[0];
        if (!own && artifact.sizeBytes > MAX_EXPORT_SOURCE_BYTES) return sendJson(res, 413, { error: 'this file is too large to convert; download it as it is' });
        let bytes: Buffer | null;
        try {
          bytes = await runExport({ bytes: await readArtifactBytes(deps.env ?? process.env, artifact), mime: artifact.mime, filename: artifact.filename }, format);
        } catch (err) {
          if (!(err instanceof ExportRefused)) throw err;
          if (err.retryAfter !== undefined) res.setHeader('Retry-After', String(err.retryAfter));
          return sendJson(res, err.status, { error: err.message });
        }
        if (!bytes) return sendJson(res, 415, { error: `this file cannot be downloaded as ${format}` });
        res.setHeader('Content-Type', EXPORT_MIME[format]);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportName(artifact.filename, format)).replace(/'/g, '%27')}`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }

      const download = /^\/api\/artifacts\/([0-9a-f-]{36})\/(download|preview)$/.exec(path);
      if (download) {
        const artifact = await getArtifact(deps.pool, download[1]!);
        if (!artifact) return sendEmpty(res, 404);
        const preview = download[2] === 'preview';
        /*
         * What may be shown inline on our origin, and how:
         *  - passive raster images, as themselves;
         *  - PDFs, for the browser's own viewer, which the browser isolates —
         *    the sandbox directive here withholds scripts and plugins from any
         *    document content all the same;
         *  - text families, always as text/plain, so nothing in them is ever
         *    parsed as markup, and bounded to what a preview shows.
         * Everything else stays a download.
         */
        const kind = preview ? previewKind(artifact.mime, artifact.filename) : null;
        if (preview && kind === null) return sendEmpty(res, 415);
        // A text preview reads only its prefix from disk, on a character
        // boundary, and says whether the file went on; nothing else is loaded.
        let bytes: Buffer;
        let truncated = false;
        if (kind === 'text') {
          const prefix = await readArtifactPrefix(deps.env ?? process.env, artifact, PREVIEW_TEXT_BYTES);
          const decoder = new StringDecoder('utf8');
          bytes = Buffer.from(decoder.write(prefix.bytes), 'utf8');
          truncated = prefix.truncated;
        } else {
          bytes = await readArtifactBytes(deps.env ?? process.env, artifact);
        }
        res.setHeader('Content-Type', kind === 'text' ? 'text/plain; charset=utf-8' : preview ? artifact.mime : 'application/octet-stream');
        res.setHeader('Content-Disposition', `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.filename ?? 'download').replace(/'/g, '%27')}`);
        if (preview) res.setHeader('Content-Security-Policy', kind === 'pdf' ? "default-src 'none'; sandbox allow-same-origin" : "default-src 'none'; sandbox");
        if (kind === 'text') res.setHeader('X-Preview-Truncated', truncated ? '1' : '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      switch (path) {
        case '/api/host': {
          const host = hostService(deps.env ?? process.env);
          const agentId = q.get('agentId') ?? undefined;
          const conversationId = q.get('conversationId') ?? undefined;
          const permissions = (await listToolPermissions(deps.pool, deps.ctx.ownerId)).filter(p => p.tool === 'host.exec' && (!agentId || p.agentId === agentId) && (!conversationId || !p.conversationId || p.conversationId === conversationId));
          return sendJson(res, 200, { permissions, runs: host.runs(deps.ctx.ownerId, agentId, conversationId) });
        }
        case '/api/extension':
          return sendJson(res, 200, await extension.view());
        case '/api/browser':
          return sendJson(res, 200, q.has('conversationId') && q.has('agentId')
            ? browser.status({ agentId: q.get('agentId')!, conversationId: q.get('conversationId')! }) : browser.status());
        case '/api/browser/telemetry': {
          // Stops by cause, cards and routes over the last week: how flakiness is seen to fall.
          const summary = (browser as { telemetrySummary?: (days?: number) => unknown }).telemetrySummary?.(Number(q.get('days') ?? '7') || 7);
          return sendJson(res, 200, summary ?? { days: 7, tasks: 0, stops: 0, cards: 0, byCause: [], routes: {}, stopsPerTask: 0 });
        }
        case '/api/browser/screenshot': {
          const expectedSession = url.searchParams.get('sessionId');
          const current = browser.status(expectedSession !== null ? { sessionId: expectedSession } : undefined);
          const observation = url.searchParams.get('v');
          if ((expectedSession !== null && current.session?.id !== expectedSession) ||
              (observation !== null && current.page?.id !== observation)) return sendEmpty(res, 404);
          const bytes = browser.screenshot(expectedSession ?? undefined);
          if (!bytes) return sendEmpty(res, 404);
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          res.end(method === 'HEAD' ? undefined : bytes);
          return;
        }
        case '/api/session': {
          // How the owner reads times and dates: every page formats with it.
          const formats = await getOwnerProfile(deps.pool).catch(() => null);
          return sendJson(res, 200, {
            csrf: session.csrf,
            timezone: deps.timezone,
            timeFormat: formats?.timeFormat ?? null,
            dateFormat: formats?.dateFormat ?? null,
            host: deps.config.host,
            port: deps.config.port,
            // Where buddi runs: a page opened from another machine is still
            // about *this* one ("on this Mac" was wrong on a Linux server).
            platform: process.platform,
            // Restored from a backup and not yet checked over. The shell reads
            // this on every page, because the banner belongs on every page.
            recovery: await inRecovery(deps.pool),
            // Where this session was established and when it would lapse if
            // nothing touched it again. Said out loud so the model is legible
            // from the page rather than implied by a number in a source file.
            scope: session.scope,
            // How this browser got in. `local` is the open loopback mint,
            // `ticket` the five-minute ticket exchange, or the provider that
            // verified it (`tailscale`, `cloudflare-access`) — and then the
            // name to greet.
            signedInThrough: session.via === 'provider' ? session.provider : session.via,
            ...(session.via === 'provider' ? { provider: session.provider, providerSubject: session.providerSubject } : {}),
            ...(session.via === 'provider' && session.provider === 'tailscale'
              ? { tailscaleName: session.providerDetail?.name ?? session.providerSubject, tailscaleLogin: session.providerSubject }
              : {}),
            expiresAt: session.expiresAt.toISOString(),
            // What this gateway is running. The page keeps it across an
            // upgrade so that "it came back" can be told from "it is still
            // the old one" without a second route.
            version: await currentVersion(deps.env ?? process.env),
          });
        }
        /*
         * The Tailscale panel's whole payload: what is stored, whether a
         * daemon is here to ask, who this machine is signed in as (so the
         * field can be prefilled without the owner typing their login from
         * memory), and whether this very request came through the proxy —
         * which is what disables the switch on a tailnet browser.
         */
        // `/api/tailscale` stays one release as an alias (docs/api.md).
        case '/api/tailscale':
        case '/api/access/tailscale':
          return sendJson(res, 200, await tailscaleView(req, session));
        /*
         * "Sign in from elsewhere": every provider's row — its status in one
         * line — and whether this very request came through one, which makes
         * the whole block read-only.
         */
        case '/api/access':
          return sendJson(res, 200, await accessView(req, session));
        case '/api/access/cloudflare-access':
          return sendJson(res, 200, await cloudflareView(req, session));
        case '/api/access/cloudflare-access/setup':
          // The install line holds the tunnel's connector token: this machine only.
          if (session.via !== 'local') return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
          return sendJson(res, 200, await setupView());
        case '/api/overview':
          return sendJson(
            res,
            200,
            {
              ...(await readOverview({
                pool: deps.pool,
                registry: deps.registry,
                catalog: deps.catalog,
                ctx: deps.ctx,
                timezone: deps.timezone,
                now,
              })),
              // Every surface's runs (Telegram, the queue, the terminal), not only
              // this dashboard's; a chat send still being set up counts too.
              running: Math.max(runningAgentRuns(), chat?.runningCount ?? 0),
              // What needs the owner, by the one rule: Home's counts and the rail's badge.
              needsYou: await needsYou(),
            },
          );
        case '/api/events':
          return sendJson(
            res,
            200,
            await readEvents(deps.pool, {
              kind: q.get('kind') ?? undefined,
              q: q.get('q') ?? undefined,
              since: q.get('since') ?? undefined,
              before: q.get('before') ?? undefined,
              limit: boundedLimit(q.get('limit')),
            }),
          );
        case '/api/events/kinds':
          return sendJson(res, 200, { kinds: await readEventKinds(deps.pool) });
        case '/api/conversations':
          return sendJson(res, 200, {
            conversations: await readConversations(deps.pool, boundedLimit(q.get('limit'), 50)),
          });
        case '/api/missions':
          return sendJson(res, 200, { missions: await readMissions(deps.pool, now) });
        case '/api/jobs': {
          const state = q.get('state');
          return sendJson(
            res,
            200,
            await readJobs(deps.pool, {
              state: state && isJobState(state) ? (state as JobState) : undefined,
              kind: q.get('kind') ?? undefined,
              limit: boundedLimit(q.get('limit')),
              offset: Math.max(0, Math.min(Number(q.get('offset') ?? 0) || 0, 100_000)),
              failed: q.get('failed') === 'open' || q.get('failed') === 'dismissed' ? (q.get('failed') as 'open' | 'dismissed') : undefined,
              hideDismissed: q.get('dismissed') === '0',
            }),
          );
        }
        // Failed jobs grouped by what broke them: the ones still asking, and
        // the dismissed ones (by the owner, or quiet after 14 days) apart.
        case '/api/jobs/failures': {
          const names = new Map(deps.catalog.list().map((a) => [a.id, a.name]));
          return sendJson(res, 200, await readJobFailures(deps.pool, now, (id) => names.get(id) ?? null));
        }
        case '/api/approvals': {
          const approvals = await readApprovals(deps.pool, now, boundedLimit(q.get('limit'), 50));
          return sendJson(res, 200, { pending: approvals.pending.map(a => ({ ...a, ...approvalExtras(a) })),
            recent: approvals.recent.map(a => ({ ...a, ...approvalExtras(a) })) });
        }
        case '/api/offers':
          // The roster goes in so the read can lapse an offer whose agent is
          // gone. Nothing else about the catalog is read here.
          return sendJson(
            res,
            200,
            await readOffers(deps.pool, now, boundedLimit(q.get('limit')), {
              agentIds: deps.catalog.list().map((a) => a.id),
            }),
          );
        case '/api/proposals':
          return sendJson(res, 200, {
            ...(await readProposals(deps.pool, now, catalogSkillLookup(deps.catalog), registryChangeLookup(deps.registry))),
            // The weekly digest: the latest one for Home, and when the next runs.
            digest: {
              latest: await latestDigest(deps.pool),
              schedule: await readDigestSchedule(deps.pool, now, deps.timezone),
            },
          });
        case '/api/notifications':
          return reply(res, await listNotificationsRoute(deps.pool, q.get('limit'), { needs: q.get('needs') === '1', offset: q.get('offset') }));
        case '/api/notifications/settings':
          return reply(res, await notificationSettingsRoute(deps.pool, 'GET'));
        case '/api/notifications/focus':
          return reply(res, await focusRoute(deps.pool, { now: deps.now, timezone: deps.timezone }, 'GET'));
        case '/api/reminders':
          return sendJson(res, 200, {
            reminders: await readReminders(deps.pool, boundedLimit(q.get('limit'))),
          });
        case '/api/sentinels':
          return sendJson(
            res,
            200,
            await readSentinels(deps.pool, deps.registry, deps.now()),
          );
        case '/api/chat/agents':
          // With the commands the plugins add to the composer's `/` menu (web/composer.ts).
          return sendJson(res, 200, { ...readChatAgents(deps.catalog, await avatarVersions(deps.pool)), commands: pluginCommands(deps.registry) });
        // Which agents are waiting on the owner. One small query, and the only
        // definition of "waiting" in the installation — see attention.ts.
        case '/api/chat/attention':
          return sendJson(res, 200, await readAgentAttention(deps.pool, now));
        /*
         * The screens the installed plugins contribute, and nothing else: a
         * rail entry, a settings tab, and the tree of generic components each
         * is made of (docs/plugin-pages.md). Descriptors are data, like
         * views — no plugin code ever runs in the page.
         */
        case '/api/pages':
          return reply(res, listPageDescriptors(pagesDeps()));
        // Which plugin rail pages the owner hid (Settings → Appearance → In the rail).
        case '/api/rail':
          return sendJson(res, 200, await readRail(deps.pool));
        case '/api/agent-offers':
          // Agents a plugin offers on Home while nobody has them. Accepting
          // is the Plugins page's own accept route, below.
          return sendJson(res, 200, await readAgentOffers(agentOffersDeps()));
        /*
         * The agent catalogue: buddi's ready-made agents from withbuddi.com,
         * each with where it stands here. Fetched when stale, the copy offline.
         */
        case '/api/catalogue':
          return reply(res, await catalogueRoute(catalogueDeps(), url));
        case '/api/chat/views':
          // How the installed plugins want their tool output drawn. The page
          // owns the renderers and learns the domain mapping from here, so an
          // installation without a plugin serves none of that plugin's mapping.
          return sendJson(res, 200, { views: deps.registry.views() });
        case '/api/agents':
          return sendJson(res, 200, {
            agents: readAgents(deps.catalog, await avatarVersions(deps.pool)),
            // The engine half is read from the files, so a change made a
            // second ago shows even though this process still runs the
            // catalog it booted with — which `restartRequired` reports.
            engines: readAgentEngines(deps.catalog, deps.env ?? process.env),
            providers: readEngineOptions(deps.env ?? process.env),
            providerAccounts: deps.providerAccounts?.view(),
            // Which agent a chat that names nobody lands on, and whether the
            // files disagree about it. An installation fact, not a file flag.
            default: readDefaultAgent(deps.catalog),
            // Which agents came from the catalogue, with their drift against the
            // kept list, so an agent's page needs no catalogue fetch. Never fetches.
            catalogue: await agentsCatalogue(catalogueDeps()).catch(() => ({})),
          });
        case '/api/groups':
          // The list is read every few seconds, so it is also where a delete whose minute has passed is made final.
          await purgeGroups(deps.pool, deps.now(), log);
          return sendJson(res, 200, { groups: (await listGroups(deps.pool)).map(groupView) });
        /*
         * The supervisor, when there is one. A developer checkout has no
         * socket and therefore no service section on the Settings page: the
         * gateway is whatever started it, and it has nothing to report.
         */
        case '/api/service': {
          const env = deps.env ?? process.env;
          const socket = env.BUDDI_SUPERVISOR_SOCKET;
          if (!socket) {
            // `buddi service` runs serve.js straight under launchd, with no
            // control socket. launchd names its job in XPC_SERVICE_NAME, so
            // the gateway is supervised all the same; there is only nothing
            // here to stop or restart it with.
            if (env.XPC_SERVICE_NAME === LAUNCHD_LABEL) {
              return sendJson(res, 200, { supervised: true, supervisor: 'launchd', label: LAUNCHD_LABEL });
            }
            return sendJson(res, 200, { supervised: false });
          }
          try {
            const reply = await supervisorCall(socket, '/status', 'GET');
            if (reply.status !== 200) return sendJson(res, 502, { error: 'The supervisor refused to report its status.' });
            return sendJson(res, 200, { supervised: true, status: reply.body });
          } catch {
            return sendJson(res, 503, { error: 'The supervisor is not answering on its control socket. Run buddi in a terminal.' });
          }
        }
        /*
         * First run: where the record stands, and what the wizard still has to
         * ask for. A read, and only a read — an installation that has never
         * been asked anything must not acquire a row because a page loaded.
         */
        /*
         * Recovery: the checklist a restored installation has to get through.
         * Read-only, and it says `active: false` on an installation that was
         * never restored rather than 404 — the shell asks unconditionally.
         */
        case '/api/recovery':
          return sendJson(res, 200, await readRecoveryView({ pool: deps.pool, env: deps.env ?? process.env }, deps.ctx.ownerId));
        /*
         * What is running, and what upgrading has done before. Supervised,
         * this is the supervisor's answer; in a checkout it is the version
         * alone and the line saying that git, not this page, upgrades it.
         */
        case '/api/version':
          return reply(res, await versionRoute(versionDeps()));
        case '/api/backups':
          return reply(res, await listBackups(backupDeps()));
        case '/api/backups/schedule':
          return reply(res, await scheduleRoute(backupDeps(), 'GET'));
        case '/api/backups/passphrase': {
          // Behind the PIN when there is one: Settings → Backup reveals it with POST …/reveal.
          const allowed = await lock.verify(undefined);
          if (!allowed.ok) return sendJson(res, 403, { error: 'Type your PIN to see the passphrase.', needsPin: true });
          return reply(res, await passphraseRoute(backupDeps(), 'GET'));
        }
        /* Home's card after the first encrypted backup, until "I saved it" (web/passphrase-notice.ts). */
        /* The words, so from this computer only, and behind the PIN when there is one (the card then reveals with POST …/reveal). */
        case '/api/backups/passphrase/notice': {
          if (session.via !== 'local') return sendJson(res, 403, { error: 'The passphrase shows on the computer buddi runs on.' });
          const allowed = await lock.verify(undefined);
          return sendJson(res, 200, await passphraseNotice(noticeDeps(), { words: allowed.ok }));
        }
        /*
         * Plugins: what is installed, what is staged and waiting to be read,
         * and the trust sentence the page shows above the install field. A
         * read, and only a read — nothing is fetched by a page loading.
         */
        case '/api/plugins':
          return reply(res, await listPlugins(pluginDeps()));
        /*
         * The plugin list from withbuddi.com. Fetched here only when asked —
         * the Browse tab opening — and kept a day; never at start or on a timer.
         */
        case '/api/market':
          return reply(res, await marketRoute({ env: deps.env ?? process.env, log }, url));
        /*
         * A listing's screenshot, fetched from withbuddi.com/plugins/ and kept
         * beside the list: the page asks here and never the internet itself.
         */
        case '/api/market/asset': {
          const asset = await marketAssetRoute({ env: deps.env ?? process.env, log }, url);
          if (asset.bytes === undefined) return sendJson(res, asset.status, asset.body);
          res.statusCode = asset.status;
          res.setHeader('Content-Type', asset.type ?? 'application/octet-stream');
          res.setHeader('Content-Length', String(asset.bytes.length));
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          res.end(method === 'HEAD' ? undefined : asset.bytes);
          return;
        }
        /*
         * "A directory I built": the folders on this machine, under the
         * owner's home, for the picker beside the field. A read of names only.
         */
        case '/api/plugins/folders':
          return reply(res, pluginFoldersRoute(deps.env ?? process.env, url));
        case '/api/secrets':
          return reply(res, await listSecrets(secretsDeps()));
        case '/api/secrets/uses':
          return reply(res, await secretUses(secretsDeps(), url));
        case '/api/onboarding':
          return sendJson(res, 200, await readOnboarding(onboardingDeps(), { withOffers: true }));
        /*
         * Is Ollama running on this machine? Asked from here, never from the
         * page: the dashboard bundle reaches no host but its own, and the
         * answer is about the machine buddi runs on rather than the browser's.
         */
        // The assistant's persona, for the wizard's "change": what the purpose field shows.
        case '/api/onboarding/agent': {
          const persona = readFirstAgentPersona(onboardingDeps());
          return persona ? sendJson(res, 200, persona) : sendJson(res, 404, { error: 'There is no assistant of your own yet.' });
        }
        // With what the machine says: installed or not, how to install it, the
        // model the first run would fetch here, and a fetch already going.
        case '/api/onboarding/ollama':
          return sendJson(res, 200, { ...(await probeOllama()), machine: machine(), pull: ollamaPulls.read() });
        case '/api/onboarding/ollama/pull':
          return sendJson(res, 200, { pull: ollamaPulls.read() });
        // Is mlxh running here? The same question, asked the same way, of port 1060.
        case '/api/onboarding/mlxh':
          return sendJson(res, 200, await probeMlxh({ baseUrl: mlxhBaseUrl(deps.env ?? process.env) }));
        // Chapter 3's progress: per plugin, and what the handover card will say is waiting.
        case '/api/onboarding/take-on':
          return sendJson(res, 200, await readTakeOn(takeOnDeps()));
        case '/api/telegram':
          return sendJson(res, 200, await telegramStatus(telegramDeps()));
        // Settings → Telegram: which bot, and which phones talk to it.
        case '/api/telegram/bot':
          return sendJson(res, 200, await telegramBot(telegramDeps()));
        case '/api/telegram/devices':
          return sendJson(res, 200, await telegramDevices(telegramDeps()));
        case '/api/owner': {
          const profile = await getOwnerProfile(deps.pool);
          return sendJson(res, 200, { ...profile, places: await placesList(deps.pool), detectedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, zones: knownTimezones() });
        }
        // Settings → Memory → People, and Home's birthday card (web/people.ts).
        case '/api/memory/people':
        case '/api/owner/birthday': {
          const answered = await peopleRoute({ pool: deps.pool, catalog: deps.catalog, now: deps.now, log }, 'GET', path, {});
          return sendJson(res, answered!.status, answered!.body);
        }
        case '/api/memory': {
          try {
            // `?agent=` narrows it to what that agent sees: the agent sheet's tab.
            const agent = url.searchParams.get('agent') ?? undefined;
            return sendJson(res, 200, await listMemory(deps.pool, deps.now(), agent ? { agent } : {}));
          } catch (err) {
            return sendJson(res, 503, { error: `Memory is unavailable: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        // Settings → API tokens. A token is refused these by the table: it cannot list or make its kind.
        case '/api/api-tokens':
          return reply(res, await apiTokensRoute(deps.pool, { method, path, body: null, now }));
        case '/api/provider-accounts':
          if (!deps.providerAccounts) return sendJson(res, 503, { error: 'Provider accounts are unavailable in this process.' });
          await deps.providerAccounts.refresh();
          return sendJson(res, 200, deps.providerAccounts.view(session.id));
        case '/api/providers':
          if (!deps.providerSettings) return sendJson(res, 503, { error: 'Provider management is unavailable in this process.' });
          return sendJson(res, 200, deps.providerSettings.view());
        default:
          break;
      }

      /*
       * One plugin page query. The parameters are checked by the query's own
       * zod schema — 400 with the plugin's own sentence when they are wrong,
       * 404 when nothing contributes a query by that name.
       */
      const pageQuery = PAGE_ROUTE.exec(path);
      if (pageQuery) {
        const answered = await runPageQuery(pagesDeps(), pageQuery[1] as string, pageQuery[2] as string, q);
        if (answered.file) return sendPageFile(res, answered.file, method === 'HEAD');
        return reply(res, answered);
      }

      const upgradeJob = /^\/api\/upgrade\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (upgradeJob) return reply(res, withoutPassphrase(await upgradeJobRoute(versionDeps(), upgradeJob[1] as string)));

      const backupJob = /^\/api\/backups\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (backupJob) return reply(res, withoutPassphrase(await backupJobRoute(backupDeps(), backupJob[1] as string)));

      /* buddi.app's command line tool: whether it is installed, from this computer only. */
      if (path === '/api/system/cli') {
        if (session.via !== 'local') return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
        return reply(res, await cliToolRoute(deps.env ?? process.env, 'GET'));
      }
      /* Remove buddi from this Mac: the plan (with its token) and the last backup's job, from this computer only. */
      if (path === '/api/system/uninstall') {
        if (session.via !== 'local') return sendJson(res, 403, { error: 'Remove buddi from the computer it runs on.' });
        return reply(res, await uninstallPlanRoute({ env: deps.env ?? process.env, now: deps.now }, uninstallTokens));
      }
      const uninstallJob = /^\/api\/system\/uninstall\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (uninstallJob) {
        if (session.via !== 'local') return sendJson(res, 403, { error: 'Remove buddi from the computer it runs on.' });
        return reply(res, await uninstallJobRoute({ env: deps.env ?? process.env }, uninstallJob[1] as string));
      }

      const catalogueJob = /^\/api\/catalogue\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (catalogueJob) return reply(res, catalogueJobRoute(catalogueJob[1] as string));
      // What removing an agent does, before the owner says so: nothing changes.
      const removePreview = /^\/api\/agents\/([^/]+)\/remove$/.exec(path);
      if (removePreview) return reply(res, await removePreviewRoute(catalogueDeps(), decodeURIComponent(removePreview[1] as string)));
      const pluginJob = /^\/api\/plugins\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (pluginJob) return reply(res, pluginJobRoute(pluginDeps(), pluginJob[1] as string));

      const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
      if (conversation) {
        const transcript = await readConversation(deps.pool, decodeURIComponent(conversation[1] as string));
        if (!transcript) return sendJson(res, 404, { error: 'no such conversation' });
        return sendJson(res, 200, transcript);
      }

      // One action, whole: the envelope the approval is bound to and the
      // preview the *tool* rendered. The canvas draws it from this, so it can
      // show what would actually happen rather than a summary of a summary.
      /*
       * One agent, whole: its grant with every tool's tier, its engine, its
       * skills, its delegates. A read and only ever a read — a change to any of
       * it goes through the maker agent, where it becomes an approval.
       */
      /*
       * A plugin's asset (host API 1.27): a PNG core drew itself from what the
       * plugin fetched, at 64 or 128 px. Only behind a session, like every
       * other read here; never a file the plugin wrote byte for byte. Kept a
       * day by the browser — a logo changes once a month — and revalidated
       * by its bytes.
       */
      const asset = /^\/api\/plugin-assets\/([a-z][a-z0-9_-]{0,63})\/([^/]+)$/.exec(path);
      if (asset) {
        const key = decodeURIComponent(asset[2]!);
        const size = url.searchParams.get('size') === '64' ? 64 : 128;
        const png = isAssetKey(key) ? await readPluginAsset(asset[1]!, key, size, deps.env ?? process.env).catch(() => null) : null;
        if (!png) return sendEmpty(res, 404);
        const etag = `"${createHash('sha256').update(png).digest('hex').slice(0, 32)}"`;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        const presented = first(req.headers['if-none-match']);
        if (presented !== undefined && presented.split(',').some((tag) => tag.trim() === etag)) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('Content-Length', String(png.length));
        res.statusCode = 200;
        res.end(method === 'HEAD' ? undefined : png);
        return;
      }
      const avatar = /^\/api\/agents\/([^/]+)\/avatar$/.exec(path);
      if (avatar) {
        const agent = deps.catalog.get(decodeURIComponent(avatar[1]!));
        if (!agent) return sendEmpty(res, 404);
        /*
         * The uploaded picture first: a PNG this server encoded, with a strong
         * ETag of its bytes. The URL carries the version, so the browser may
         * keep it; a revalidation costs one 304.
         */
        const picture = await readAvatar(deps.pool, agent.id).catch(() => null);
        if (picture) {
          const etag = `"${picture.sha256}"`;
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('ETag', etag);
          res.setHeader('Cache-Control', 'private, no-cache');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          const presented = first(req.headers['if-none-match']);
          if (presented !== undefined && presented.split(',').some((tag) => tag.trim() === etag)) {
            res.statusCode = 304;
            res.end();
            return;
          }
          res.setHeader('Content-Length', String(picture.png.length));
          res.statusCode = 200;
          res.end(method === 'HEAD' ? undefined : picture.png);
          return;
        }
        const name = agent.avatar;
        if (!name || !AVATAR_IMAGE.test(name)) return sendEmpty(res, 404);
        const file = path_.join(path_.dirname(agent.file), name);
        let bytes: Buffer;
        try { bytes = readFileSync(file); } catch { return sendEmpty(res, 404); }
        const ext = name.toLowerCase().split('.').pop()!;
        res.setHeader('Content-Type', ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      const profile = /^\/api\/agents\/([^/]+)\/profile$/.exec(path);
      if (profile) {
        const view = readAgentProfile(
          { catalog: deps.catalog, registry: deps.registry },
          decodeURIComponent(profile[1] as string),
        );
        if (!view) return sendJson(res, 404, { error: 'no such agent' });
        return sendJson(res, 200, view);
      }
      // The Skills page: every skill, grouped, who holds each; one whole; one as its file.
      if (path === '/api/skills') return reply(res, listSkillsRoute(skillsDeps()));
      /*
       * A bundle's files, for the viewer: one file's text (or its size when
       * it is not text), and a picture's bytes for an <img>. The same for an
       * upload still waiting in the preview. A picture is served with a CSP
       * that runs nothing, so an SVG opened on its own cannot script the page.
       */
      const bundleRead = /^\/api\/skills\/(bundles\/)?([^/]+)\/(file|image)$/.exec(path);
      if (bundleRead) {
        const id = decodeURIComponent(bundleRead[2] as string);
        const rel = url.searchParams.get('path') ?? '';
        if (bundleRead[3] === 'file') {
          return reply(res, bundleRead[1] ? stagedFileRoute(skillsDeps(), id, rel) : skillFileRoute(skillsDeps(), id, rel));
        }
        const picture = bundleRead[1] ? stagedImage(skillsDeps(), id, rel) : skillImage(skillsDeps(), id, rel);
        if (!picture) return sendJson(res, 404, { error: `There is no picture "${rel}" in this bundle.` });
        res.statusCode = 200;
        res.setHeader('Content-Type', picture.type);
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.end(method === 'HEAD' ? undefined : picture.bytes);
        return;
      }
      const skillRead = /^\/api\/skills\/([^/]+)(\/download)?$/.exec(path);
      if (skillRead) {
        const id = decodeURIComponent(skillRead[1] as string);
        if (!skillRead[2]) return reply(res, skillDetailRoute(skillsDeps(), id));
        const file = skillDownload(skillsDeps(), id);
        if (!file) return sendJson(res, 404, { error: `There is no skill "${id}".` });
        if ('zip' in file) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
          res.setHeader('Cache-Control', 'no-store');
          res.end(method === 'HEAD' ? undefined : Buffer.from(file.zip));
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(method === 'HEAD' ? undefined : file.text);
        return;
      }
      // The Skills tab: every skill the agent loads, learned ones with their versions.
      const agentSkills = /^\/api\/agents\/([^/]+)\/skills$/.exec(path);
      if (agentSkills) {
        const view = readAgentSkills(deps.catalog, decodeURIComponent(agentSkills[1] as string));
        if (!view) return sendJson(res, 404, { error: 'no such agent' });
        return sendJson(res, 200, view);
      }
      /*
       * The agent's file as it is written: front matter and persona. A read,
       * for `buddi mcp`'s `buddi.agent_read`; nothing here serves it otherwise.
       */
      const agentFileRead = /^\/api\/agents\/([^/]+)\/file$/.exec(path);
      if (agentFileRead) {
        const id = decodeURIComponent(agentFileRead[1] as string);
        const agent = deps.catalog.get(id) ?? deps.catalog.byHandle(id);
        if (!agent) return sendJson(res, 404, { error: 'no such agent' });
        try {
          const parsed = parseAgentFile(readFileSync(agent.file, 'utf8'), { file: agent.file });
          return sendJson(res, 200, { id: agent.id, file: agent.file, frontmatter: parsed.frontmatter, persona: parsed.body });
        } catch (err) {
          return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      // Every installed tool, for the picker on the Setup tab. A read.
      const toolPicker = /^\/api\/agents\/([^/]+)\/tools$/.exec(path);
      if (toolPicker) {
        const view = readToolPicker(
          { catalog: deps.catalog, registry: deps.registry },
          decodeURIComponent(toolPicker[1] as string),
        );
        if (!view) return sendJson(res, 404, { error: 'no such agent' });
        return sendJson(res, 200, view);
      }

      const approval = /^\/api\/approvals\/([^/]+)$/.exec(path);
      if (approval) {
        const action = await getAction(deps.pool, decodeURIComponent(approval[1] as string));
        if (!action) return sendJson(res, 404, { error: 'no such action' });
        return sendJson(res, 200, { action: { ...toApprovalView(action), ...approvalExtras(action) } });
      }

      /* ---------------- chat ---------------- */

      const groupConversations = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/conversations$/i.exec(path);
      if (groupConversations) {
        const group = await getGroup(deps.pool, groupConversations[1]!);
        if (!group) return sendJson(res, 404, { error: 'no such group' });
        const rows = await listGroupConversations(deps.pool, group.id);
        // The same shape an agent's list has, so the page draws both alike.
        return sendJson(res, 200, {
          conversations: rows.map((row) => ({
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            startedAt: row.createdAt.toISOString(),
            lastMessageAt: row.lastAt?.toISOString() ?? null,
            messageCount: row.messages,
            ...(row.first ? { preview: row.first, opening: row.first } : {}),
          })),
        });
      }
      const groupOne = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (groupOne) {
        const group = await getGroup(deps.pool, groupOne[1]!);
        if (!group) return sendJson(res, 404, { error: 'no such group' });
        const latest = await latestGroupConversation(deps.pool, group.id);
        const open = latest ? await openGroupRequest(deps.pool, latest) : null;
        return sendJson(res, 200, {
          ...groupView(group),
          latestConversationId: latest,
          openRequest: open ? { id: open.id, state: open.state, awaitingAgentId: open.awaitingAgentId, budgetReserved: open.budgetReserved, budgetTotal: open.budgetTotal } : null,
          // What Clear history and Delete would take, for the sentence that asks first.
          history: await groupHistorySize(deps.pool, group.id),
        });
      }
      const chatConversations = /^\/api\/chat\/([^/]+)\/conversations$/.exec(path);
      if (chatConversations) {
        const agentId = decodeURIComponent(chatConversations[1] as string);
        if (!deps.catalog.get(agentId)) {
          return sendJson(res, 404, { error: `no such agent: ${agentId}` });
        }
        return sendJson(res, 200, {
          conversations: await readChatConversations(
            deps.pool,
            agentId,
            boundedLimit(q.get('limit'), CHAT_CONVERSATIONS_LIMIT),
          ),
        });
      }

      const transcript = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
      if (transcript) {
        const found = await readChatTranscript(
          deps.pool,
          decodeURIComponent(transcript[1] as string),
          deps.now(),
          (agentId) => idleRolloverMs(deps.catalog.get(agentId)?.idleRollover),
        );
        if (!found) return sendJson(res, 404, { error: 'no such conversation' });
        return sendJson(res, 200, found);
      }

      /*
       * The attention stream: the same event log, tailed without a conversation
       * filter, so a badge lights up for an agent the owner is *not* looking at.
       * It carries no payload — one frame means "ask `/api/chat/attention`
       * again" — which is what keeps the definition of waiting in one place.
       */
      if (path === '/api/chat/attention/stream') {
        const release = streams.take(session.id);
        if (release === null) return sendEmpty(res, 429);
        const let_go = holdStream(session, res);
        try {
          await streamAttention(req, res, {
            pool: deps.pool,
            since: resumeCursor(req, q.get('since')),
            now: deps.now,
          });
        } finally {
          let_go();
          release();
        }
        return;
      }

      const stream = /^\/api\/chat\/conversations\/([^/]+)\/stream$/.exec(path);
      if (stream) {
        const conversationId = decodeURIComponent(stream[1] as string);
        if ((await conversationAgent(deps.pool, conversationId)) === null) {
          return sendJson(res, 404, { error: 'no such conversation' });
        }
        // One page, many tabs, but not unboundedly many: each stream is a live
        // socket and a poll, and a leaked EventSource would be both forever.
        const release = streams.take(session.id);
        if (release === null) return sendEmpty(res, 429);
        const let_go = holdStream(session, res);
        try {
          await streamConversation(req, res, {
            pool: deps.pool,
            conversationId,
            since: resumeCursor(req, q.get('since')),
            now: deps.now,
            ...(chat ? { live: chat.live } : {}),
          });
        } finally {
          let_go();
          release();
        }
        return;
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    }

    /*
     * Changing a group the owner already has: its name, its coordinator, who
     * is in it.
     *
     * PATCH, because what the body leaves out is left exactly as it was — a
     * rename does not have to restate the membership. The rules are core's,
     * one copy, so this route and `platform.update_group` refuse the same
     * changes in the same words. The id never moves and the transcript is
     * never touched: a member taken out of the room keeps every turn it spoke
     * there.
     */
    if (method === 'PATCH') {
      const groupEdit = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (!groupEdit) return sendEmpty(res, 405);
      let patch: Record<string, unknown>;
      try {
        patch = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'request body must be JSON' });
      }
      if (patch.name !== undefined && typeof patch.name !== 'string') return sendJson(res, 400, { error: '`name` must be a string.' });
      if (patch.coordinator !== undefined && typeof patch.coordinator !== 'string') return sendJson(res, 400, { error: '`coordinator` must be an agent id.' });
      if (patch.members !== undefined && (!Array.isArray(patch.members) || patch.members.some((m) => typeof m !== 'string' || m.trim() === ''))) {
        return sendJson(res, 400, { error: '`members` must be a list of agent ids.' });
      }
      try {
        const group = await updateGroup(
          deps.pool,
          groupEdit[1]!,
          {
            ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
            ...(typeof patch.coordinator === 'string' ? { coordinator: patch.coordinator } : {}),
            ...(Array.isArray(patch.members) ? { members: patch.members as string[] } : {}),
          },
          groupRoster(deps.catalog),
        );
        if (!group) return sendJson(res, 404, { error: 'no such group' });
        return sendJson(res, 200, groupView(group));
      } catch (error) {
        if (error instanceof GroupRefusal) return sendJson(res, 400, { error: error.message });
        throw error;
      }
    }

    /*
     * The owner took a file back out of the composer. Only a web upload that no
     * message carries can go this way: a file already sent belongs to its
     * message, and a file a surface or an agent made is not the page's to drop.
     */
    if (method === 'DELETE') {
      // Forget the paired browser. The extension keeps running; it simply
      // stops being recognised, and its socket is closed as it is forgotten.
      if (path === '/api/extension/pair') {
        const forgotten = await extension.unpair();
        return sendJson(res, forgotten.status, forgotten.body);
      }
      // Delete a skill: the agents that asked for it stop, the file goes to the trash.
      const stagedGone = /^\/api\/skills\/bundles\/([^/]+)$/.exec(path);
      if (stagedGone) return reply(res, discardStaged(incomingDirFor(skillsDeps().skillsDir), decodeURIComponent(stagedGone[1] as string)));
      const skillGone = /^\/api\/skills\/([^/]+)$/.exec(path);
      if (skillGone) return reply(res, await deleteSkillRoute(skillsDeps(), decodeURIComponent(skillGone[1] as string)));
      // Revoke an API token: the next request carrying it is a 401.
      const tokenGone = /^\/api\/api-tokens\/([0-9a-f-]{36})$/i.exec(path);
      if (tokenGone) {
        const revoked = await apiTokensRoute(deps.pool, { method, path, body: null, now });
        return revoked.status === 204 ? sendEmpty(res, 204) : sendJson(res, revoked.status, revoked.body);
      }
      // A phone the owner no longer wants talking to their agents. Same as
      // `buddi telegram unpair <id>`, and as immediate.
      const phoneGone = /^\/api\/telegram\/devices\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (phoneGone) {
        try {
          await unpairTelegramDevice(telegramDeps(), phoneGone[1]!);
          return sendEmpty(res, 204);
        } catch (error) {
          if (error instanceof TelegramWebError) return sendJson(res, error.status, { error: error.message });
          throw error;
        }
      }
      /*
       * Delete a group: it leaves every list now, with whatever it was doing
       * stopped, and is removed for good — its history and what the room
       * remembered, never its agents — once GROUP_UNDO_MS has passed without
       * a restore. The answer says until when Undo works.
       */
      const groupGone = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (groupGone) {
        const at = deps.now();
        if (!(await getGroup(deps.pool, groupGone[1]!))) return sendJson(res, 404, { error: 'no such group' });
        await stopGroupWork(deps.pool, chat, groupGone[1]!, at, deps.ctx.ownerId);
        if (!(await deleteGroup(deps.pool, groupGone[1]!, at))) return sendJson(res, 404, { error: 'no such group' });
        await purgeGroups(deps.pool, at, log);
        return sendJson(res, 200, { undoUntil: new Date(at.getTime() + GROUP_UNDO_MS).toISOString() });
      }
      /*
       * The owner read the note a rollover carried into this conversation and
       * does not want it. It leaves the page and every later turn's context.
       */
      const carryGone = /^\/api\/chat\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/carry-over$/i.exec(path);
      if (carryGone) {
        // Idempotent: a note already gone is the state the owner asked for.
        await deleteCarryOver(deps.pool, carryGone[1]!);
        return sendEmpty(res, 204);
      }
      // The agent's uploaded picture goes; its icon is drawn again.
      const avatarGone = /^\/api\/agents\/([^/]+)\/avatar$/.exec(path);
      if (avatarGone) {
        const agent = deps.catalog.get(decodeURIComponent(avatarGone[1]!));
        if (!agent) return sendJson(res, 404, { error: 'no such agent' });
        if (await removeAvatar(deps.pool, agent.id)) deps.telegram?.pictureChanged?.(agent.id);
        return sendEmpty(res, 204);
      }
      const discard = /^\/api\/artifacts\/([0-9a-f-]{36})$/.exec(path);
      if (!discard) return sendEmpty(res, 405);
      const outcome = await discardUnreferencedUpload(deps.pool, discard[1]!, WEB_CHAT_SURFACE, deps.now());
      if (outcome === 'missing') return sendEmpty(res, 404);
      if (outcome === 'discarded') return sendEmpty(res, 204);
      return sendJson(res, 409, { error: outcome === 'referenced' ? 'This file was already sent with a message.' : 'This file did not come from the dashboard.' });
    }

    /*
     * The two settings a backup has that are edited rather than commanded. PUT
     * because they are a whole value replaced, not an action taken; the gate
     * above treats any non-GET as mutating, so they are CSRF-checked like
     * everything else.
     */
    if (method === 'PUT') {
      const puttable = ['/api/backups/schedule', '/api/backups/passphrase', '/api/version/check', '/api/tailscale', '/api/access/tailscale', '/api/access/cloudflare-access', '/api/notifications/settings', '/api/notifications/focus'];
      if (!puttable.includes(path)) return sendEmpty(res, 405);
      let put: Record<string, unknown>;
      try {
        put = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'request body must be JSON' });
      }
      if (path === '/api/access/cloudflare-access') {
        // Who may widen access: only a browser on this machine, as for Tailscale below.
        if (session.via !== 'local') {
          return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
        }
        const checked = validateCloudflareInput(put);
        if (!checked.ok) return sendJson(res, 400, { error: checked.error });
        await applyCloudflareSetting(checked.value);
        // On Save buddi fetches the team's keys once and says whether it worked.
        const test = checked.value.enabled ? await jwks.refresh(checked.value.teamDomain) : null;
        return sendJson(res, 200, { ...(await cloudflareView(req, session)), ...(test ? { test } : {}) });
      }
      if (path === '/api/tailscale' || path === '/api/access/tailscale') {
        /*
         * Who may widen access: only a browser that is already on this
         * machine.
         *
         * Said positively, because the negative version — refuse the requests
         * that look like Tailscale — can only ever list the shapes somebody
         * thought of. `via` is `local` exactly for a session minted from a
         * loopback request with no proxy metadata on it, and `sessions.get`
         * has already required *this* request to have arrived the same way. A
         * ticket session from the network and a session established through
         * Tailscale both get the sentence: a device someone walked off with
         * cannot add its own login or turn the switch on for somebody else.
         */
        if (session.via !== 'local') {
          return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
        }
        const enabled = put.enabled;
        if (typeof enabled !== 'boolean') return sendJson(res, 400, { error: '`enabled` must be true or false' });
        const login = typeof put.login === 'string' ? put.login.trim() : '';
        // A login is required to turn this on, and checked for shape whenever
        // one is given: turning it off with a typo left in the field is fine.
        if ((enabled || login !== '') && !plausibleLogin(login)) {
          return sendJson(res, 400, { error: 'That is not a Tailscale login. It is usually the email address you signed in to Tailscale with.' });
        }
        await writeWebSetting(deps.pool, TAILSCALE_SETTING_KEY, { enabled, login });
        /*
         * Every session this setting admitted goes, now.
         *
         * Each would die at its next request anyway — the daemon is asked
         * again and the setting is re-read every time — but "now" is what the
         * owner means when they turn the switch off, and a session nobody
         * makes a request with is exactly the one that should not be waiting
         * in a browser on the far side of the tailnet.
         */
        const forgotten = new Set<string>();
        await sessions.forget((s) => { const drop = s.via === 'provider' && s.provider === 'tailscale'; if (drop && s.id) forgotten.add(s.id); return drop; });
        // Including whichever of them had a hand on the owner's browser.
        hand.revoke((lease) => forgotten.has(lease), 'Tailscale access changed. Sign in again.');
        return sendJson(res, 200, await tailscaleView(req, session));
      }
      if (path === '/api/version/check') return reply(res, await versionCheckRoute(versionDeps(), 'PUT', put));
      if (path === '/api/notifications/settings') return reply(res, await notificationSettingsRoute(deps.pool, 'PUT', put));
      if (path === '/api/notifications/focus') return reply(res, await focusRoute(deps.pool, { now: deps.now, timezone: deps.timezone }, 'PUT', put));
      return reply(res, path === '/api/backups/schedule'
        ? await scheduleRoute(backupDeps(), 'PUT', put)
        : await passphraseRoute(backupDeps(), 'PUT', put));
    }

    if (method !== 'POST') return sendEmpty(res, 405);
    /*
     * "Test my setup": fetch the team's signing keys for the domain in the
     * form (saved or not) and say what came back. Nothing is stored. From
     * this machine only, like the setting itself: it makes this computer
     * fetch a URL the caller names part of.
     */
    /*
     * "Set it up for me": start a run (202, then poll GET …/setup), stop the
     * health wait, remove what buddi made, or forget the kept API token. From
     * this machine only, like the setting it fills in.
     */
    if (path === '/api/access/cloudflare-access/setup' || path === '/api/access/cloudflare-access/setup/stop' || path === '/api/access/cloudflare-access/setup/remove' || path === '/api/access/cloudflare-access/setup/forget-token') {
      if (session.via !== 'local') return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
      /*
       * Forget the token: drop the owner secret. Not while a run holds it.
       * Cloudflare still honours it until the owner revokes it there.
       */
      if (path.endsWith('/forget-token')) {
        const lease = claimSetupOperation('setup');
        if (!lease) return sendJson(res, 409, { error: setupBusySentence(setupOperation()) });
        try {
          try {
            await tokenStore().remove();
          } catch {
            return sendJson(res, 409, { error: 'The token could not be forgotten. Check that the vault is unlocked, then try again.' });
          }
          return sendJson(res, 200, await setupView());
        } finally {
          lease.release();
        }
      }
      /*
       * One operation at a time (cloudflare-setup's lock, claimed before the
       * first await and held to the end): a second setup or a removal while
       * one runs is a 409, and so is Stop while a removal runs.
       */
      if (path.endsWith('/stop')) {
        const going = setupOperation();
        if (going === 'remove') return sendJson(res, 409, { error: setupBusySentence(going) });
        const lease = going === null ? claimSetupOperation('setup') : null;
        try {
          setupRun?.abort.abort();
          await setupRun?.done;
          return sendJson(res, 200, await setupView());
        } finally {
          lease?.release();
        }
      }
      const lease = claimSetupOperation(path.endsWith('/remove') ? 'remove' : 'setup');
      if (!lease) return sendJson(res, 409, { error: setupBusySentence(setupOperation()) });
      let handedOff = false;
      try {
        const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
        const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
        const tokens = tokenStore();
        const pasted = str(body.token);
        if (path.endsWith('/remove')) {
          const token = pasted || await tokens.use().catch(() => null);
          if (!token) return sendJson(res, 400, { error: 'Paste the Cloudflare API token again: buddi needs it to remove what it made.' });
          const run: { progress: SetupProgress; abort: AbortController; done: Promise<void> } = {
            progress: { ...freshProgress(), state: 'removing', steps: [] }, abort: new AbortController(), done: Promise.resolve(),
          };
          setupRun = run;
          const progress = await removeCloudflareSetup({ ...setupDepsFor(token, lease), host: str(body.host) || undefined }, (p) => { run.progress = p; });
          run.progress = progress;
          // The token stays kept: the panel offers to forget it (…/setup/forget-token), and Set it up again reuses it.
          return sendJson(res, 200, await setupView());
        }
        const input = { host: str(body.host), email: str(body.email), zone: str(body.zone) || undefined, adopt: body.adopt === true, useSystemDaemon: body.useSystemDaemon === true };
        const invalid = checkSetupInput(input);
        if (invalid) return sendJson(res, 400, { error: invalid });
        if (pasted) {
          if (/\s/.test(pasted) || pasted.length < 20 || pasted.length > 400) return sendJson(res, 400, { error: 'That doesn’t look like a Cloudflare API token.' });
          try {
            await tokens.put(pasted);
          } catch {
            return sendJson(res, 409, { error: 'The token could not be kept in the vault. Check that the vault is unlocked, then try again.' });
          }
        }
        const token = pasted || await tokens.use().catch(() => null);
        if (!token) return sendJson(res, 400, { error: 'Paste a Cloudflare API token.' });
        const first = { ...freshProgress(input.host, input.email), state: 'running' as const };
        startSetup(lease, (onProgress, signal) => runCloudflareSetup(input, setupDepsFor(token, lease, signal), onProgress), first);
        handedOff = true;
        return sendJson(res, 202, await setupView());
      } finally {
        if (!handedOff) lease.release();
      }
    }
    /*
     * The setup form's domain choice: check the token and list the zones it
     * can see. The pasted token is only used for these two calls — keeping it
     * stays with setup — and never goes back out, not even in an error.
     */
    if (path === '/api/access/cloudflare-access/zones') {
      if (session.via !== 'local') return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
      const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
      const pasted = typeof body?.token === 'string' ? body.token.trim() : '';
      if (pasted && (/\s/.test(pasted) || pasted.length < 20 || pasted.length > 400)) return sendJson(res, 400, { error: 'That doesn’t look like a Cloudflare API token.' });
      const token = pasted || await tokenStore().use().catch(() => null);
      if (!token) return sendJson(res, 400, { error: 'Paste a Cloudflare API token.' });
      const api = createCloudflareApi({ token, transport: deps.cloudflare?.api?.transport, baseUrl: deps.cloudflare?.api?.baseUrl });
      try {
        if (await api.verifyToken() === 'inactive') return sendJson(res, 400, { error: 'Cloudflare says this API token is not active. Check that it has not expired or been turned off.' });
        const zones = await api.zones();
        return sendJson(res, 200, { zones: zones.map((z) => ({ id: z.id, name: z.name })) });
      } catch (error) {
        if (!(error instanceof CloudflareApiError)) throw error;
        const refused = error.status === 401 || error.permission !== undefined || (error.status >= 400 && error.status < 500 && error.status !== 429);
        return sendJson(res, refused ? 400 : 502, { error: error.message });
      }
    }
    if (path === '/api/access/cloudflare-access/test') {
      if (session.via !== 'local') return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
      const body = await readJsonBody(req).catch(() => ({} as Record<string, unknown>));
      const team = normalizeTeamDomain(typeof body.teamDomain === 'string' ? body.teamDomain : (await readCloudflareSetting()).teamDomain);
      if (!plausibleTeamDomain(team)) {
        return sendJson(res, 400, { error: 'That is not a Cloudflare team domain. It looks like yourteam.cloudflareaccess.com, under Zero Trust → Settings.' });
      }
      const result = await jwks.refresh(team);
      return sendJson(res, 200, {
        ...result,
        teamDomain: team,
        sentence: result.ok ? `${team} answered with ${result.keys} signing key${result.keys === 1 ? '' : 's'}.` : result.error,
        listening: ingress.port() !== null,
        ingressPort: ingress.port(),
      });
    }
    if (path === '/api/extension/pair') {
      // A six-digit code is worth guessing at scale, so a wrong one costs a
      // budget — this session's pairing budget, not the shared sign-in one.
      const pairKey = session.id;
      if (pairLimiter.blocked(pairKey, now)) return sendEmpty(res, 429);
      const body = await readJsonBody(req) as { code?: unknown } | null;
      const paired = await extension.pair(body?.code);
      if (paired.status >= 400) pairLimiter.fail(pairKey, now); else pairLimiter.reset(pairKey);
      return sendJson(res, paired.status, paired.body);
    }
    /*
     * Playwright's Chromium, for an install that shipped without one. Started
     * here and followed through `GET /api/browser`: it downloads about 150 MB,
     * far longer than a request should wait. Owner-only and CSRF-checked like
     * every other write: the gate above admits nobody else.
     */
    if (path === '/api/browser/install') {
      if (!browser.installBrowser) return sendJson(res, 409, { error: 'This host cannot install a browser.' });
      try { return sendJson(res, 202, browser.installBrowser()); }
      catch (error) { return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
    }
    /*
     * Does the agents' browser start here? Launched once and closed, headed or
     * headless as the machine dictates, after an install and before the
     * wizard says "Installed." — a binary on disk that cannot start for want
     * of a system library is not a browser the owner has.
     */
    if (path === '/api/browser/check') {
      if (!browser.checkLaunch) return sendJson(res, 200, { ok: true });
      try { return sendJson(res, 200, await browser.checkLaunch()); }
      catch (error) { return sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) }); }
    }
    if (path === '/api/browser/settings') {
      const body = await readJsonBody(req);
      try {
        if (!browser.configure) return sendJson(res, 409, { error: 'This host does not support changing control modes.' });
        return sendJson(res, 200, await browser.configure(body));
      } catch (error) {
        return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    /*
     * Pin one conversation to a route (the chip under the composer,
     * `/use browser:chrome`), or clear it with `auto`. A pin narrows; it never
     * allows a route the owner's switches forbid.
     */
    if (path === '/api/browser/pin') {
      const body = await readJsonBody(req) as { conversationId?: unknown; route?: unknown } | null;
      if (typeof body?.conversationId !== 'string' || typeof body.route !== 'string') return sendJson(res, 400, { error: 'Expected {conversationId: string, route: auto|own|chrome|apps}' });
      if (!browser.pin) return sendJson(res, 409, { error: 'This host cannot pin a route.' });
      try { return sendJson(res, 200, await browser.pin(body.conversationId, body.route)); }
      catch (error) { return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    /*
     * A tap on a browser card (Look, Keep going, Take over, Use my Chrome,
     * Resume) from a page that draws its own buttons: the same as the owner
     * sending the label in the chat, without a message.
     */
    if (path === '/api/browser/card') {
      const body = await readJsonBody(req) as { conversationId?: unknown; answer?: unknown } | null;
      if (typeof body?.conversationId !== 'string' || typeof body.answer !== 'string' || body.answer.length > 80) return sendJson(res, 400, { error: 'Expected {conversationId: string, answer: string}' });
      const answered = await browser.touch?.({ conversationId: body.conversationId, text: body.answer });
      return sendJson(res, 200, { ...(answered && 'answered' in answered ? answered : {}), status: browser.status({ conversationId: body.conversationId }) });
    }
    /*
     * "Save this login for amazon.com?" answered in the Page tab: Save, Not
     * now or Never for this site. The owner's session and CSRF, like every
     * write here; the body names the question, never a password — that is in
     * the browser host's keeper, which hands it to the owner-secret store on
     * Save and drops it otherwise.
     */
    if (path === '/api/browser/login') {
      const body = await readJsonBody(req) as { id?: unknown; decision?: unknown } | null;
      const decision = body?.decision;
      if (typeof body?.id !== 'string' || body.id.length > 80 || (decision !== 'save' && decision !== 'later' && decision !== 'never')) {
        return sendJson(res, 400, { error: 'Expected {id: string, decision: save|later|never}' });
      }
      if (!browser.logins) return sendJson(res, 409, { error: 'This host keeps no sign-ins.' });
      try {
        const answer = await browser.logins.decide(body.id, decision);
        return sendJson(res, 200, { outcome: answer.outcome, ...(answer.saved ? { saved: { name: answer.saved.name, site: answer.saved.site, username: answer.saved.username, savedAt: answer.saved.savedAt } } : {}) });
      } catch {
        // Never the error's own words: they are the store's, and the store had the password.
        return sendJson(res, 409, { error: 'buddi could not keep that login. Add it in Settings → Keys and secrets.' });
      }
    }
    const control = /^\/api\/browser\/(stop|takeover|resume|release)$/.exec(path);
    if (control) {
      const body = await readJsonBody(req) as { sessionId?: unknown; forever?: unknown } | null;
      if (body?.sessionId !== undefined && typeof body.sessionId !== 'string') return sendJson(res, 400, { error: 'sessionId must be a string' });
      const action = control[1] as 'stop' | 'takeover' | 'resume' | 'release';
      const sessionId = body?.sessionId as string | undefined;
      try {
        // Giving it back, releasing and stopping all end the take-over, so
        // they all end the hand — before the status is read, so a dashboard
        // still holding the socket is told rather than left clicking on a
        // frozen picture.
        if (action !== 'takeover') await hand.close(action === 'stop' ? undefined : sessionId, action === 'resume' ? 'You gave the screen back.' : 'That session was released.');
        // Stop agents' browsing expires (an hour by default); `forever` is "until I say".
        const status = await browser.control(action, sessionId, action === 'stop' && body?.forever === true ? { forever: true } : undefined);
        // Whether this screen can be driven from here at all. The dashboard
        // shows the mode's own sentence when it cannot.
        const taken = sessionId ?? status.session?.id;
        // A page in the owner's Chrome is taken over where it is: its tab came to the front there, so no frame will come.
        if (action === 'takeover' && status.held) return sendJson(res, 200, { ...status, hand: false });
        const offer = action === 'takeover' && taken ? browser.hand?.({ sessionId: taken }) : undefined;
        /*
         * "Your browser" with Chrome closed: the take-over itself succeeds (the
         * agent is paused), but there is no tab anywhere to show or drive. Said
         * as that, with a reason the dashboard offers its ways out on, rather
         * than the mode's "use this conversation's host tab".
         */
        if (offer && offer.supported && !offer.hand && (status.route === 'chrome' || status.mode === 'extension') && !extension.connected()) {
          return sendJson(res, 200, { ...status, hand: false, handReason: 'browser-offline', handMessage: 'Your browser isn’t connected.' });
        }
        return sendJson(res, 200, offer
          ? { ...status, hand: !!offer.hand, ...(offer.hand ? {} : { handMessage: offer.message }) }
          : status);
      } catch (error) {
        return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    /*
     * A restore from a file the owner picked on their own machine.
     *
     * Handled before the JSON body is read, for the same reason the chat
     * attachment is: `readJsonBody` caps at 64 KB and an archive is megabytes.
     * The bytes go straight to `<data>/incoming/` and the *path* the gateway
     * chose is what the supervisor is told — the browser's filename never
     * becomes a path. The passphrase and the typed-back confirmation travel as
     * headers rather than in the URL, so neither can end up in a log line.
     */
    if ((path === '/api/backups/restore' || path === '/api/onboarding/restore') &&
        !(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      if (path === '/api/onboarding/restore') {
        const refusal = await onboardingRestoreRefusal();
        if (refusal) return sendJson(res, refusal.status, { error: refusal.message });
      }
      const received = await receiveUpload(backupDeps(), req, first(req.headers['x-filename']));
      if ('status' in received) return reply(res, received);
      const out = await restoreRoute(backupDeps(), {
        path: received.path,
        ...(first(req.headers['x-backup-passphrase']) === undefined ? {} : { passphrase: first(req.headers['x-backup-passphrase']) }),
        ...(path === '/api/onboarding/restore' || first(req.headers['x-backup-confirm']) === undefined
          ? {}
          : { confirm: first(req.headers['x-backup-confirm']) }),
      });
      // A refused restore leaves nothing behind: the upload is the owner's
      // file, and keeping a copy of it after saying no would be a surprise.
      if (out.status >= 400) await discardUpload(received.path);
      return reply(res, out);
    }

    /*
     * A plugin tarball the owner has on their own machine, handed over the
     * same way a backup archive is: raw bytes, the filename in a header, and
     * `readJsonBody`'s 64 KB cap never in the way. What lands on disk is
     * staged exactly like a `.tgz` path they could have typed, and the upload
     * is deleted once staging has copied it.
     */
    /*
     * A skill bundle (.zip), handed over raw like a plugin tarball: streamed
     * to a temporary file under a cap, checked, unpacked into staging, and
     * answered with what is inside. Nothing in it runs, and nothing is kept
     * until the owner accepts it (`POST /api/skills/bundles/:staged`).
     */
    if (path === '/api/skills/bundles') {
      const incoming = incomingDirFor(skillsDeps().skillsDir);
      const filename = uploadLabel(first(req.headers['x-filename']));
      const received = await receiveBundleUpload(incoming, req, filename);
      if ('status' in received) return reply(res, received);
      return reply(res, stageBundle(incoming, received.path, filename, deps.now()));
    }

    if (path === '/api/plugins/upload') {
      const received = await receivePluginUpload(pluginDeps(), req, first(req.headers['x-filename']));
      if ('status' in received) return reply(res, received);
      return reply(res, uploadRoute(pluginDeps(), received));
    }

    /*
     * The upload is handled before the JSON body is read, and it is the only
     * other route that is: everything else on this server is a small object, and
     * `readJsonBody` caps at 64 KB for exactly that reason. A 20 MB statement
     * would be refused by that cap before the multipart parser ever saw it.
     */
    /*
     * The owner's picture for an agent: one PNG, GIF or SVG of at most 1 MB,
     * re-encoded to a square PNG before a byte is kept (`avatar-image.ts`).
     * The only write path there is — no agent tool and no MCP write reaches
     * it — and it never touches the agent file, so a shipped example can have
     * a picture too.
     */
    const avatarUpload = /^\/api\/agents\/([^/]+)\/avatar$/.exec(path);
    if (avatarUpload) {
      const agent = deps.catalog.get(decodeURIComponent(avatarUpload[1]!));
      if (!agent) return sendJson(res, 404, { error: 'no such agent' });
      const upload = await readUpload(req, MAX_AVATAR_INPUT_BYTES);
      if (!upload.ok) {
        return sendJson(res, upload.status, { error: upload.status === 413 ? 'A picture can be at most 1 MB.' : upload.error });
      }
      let picture: NormalisedAvatar;
      try {
        picture = await normaliseAvatar(upload.file.bytes, upload.file.mime);
      } catch (err) {
        if (err instanceof AvatarRefusal) return sendJson(res, err.status, { error: err.message });
        throw err;
      }
      await writeAvatar(deps.pool, agent.id, picture);
      deps.telegram?.pictureChanged?.(agent.id);
      return sendJson(res, 200, {
        picture: pictureUrl(agent.id, picture.sha256),
        side: picture.side,
        source: picture.source,
        ...(picture.source === 'gif' ? { note: 'A GIF keeps its first frame only.' } : {}),
      });
    }

    if (path === '/api/chat/attachments') {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (!deps.chat?.artifacts) return sendJson(res, 503, { error: ATTACHMENTS_UNAVAILABLE });
      const upload = await readUpload(req, MAX_UPLOAD_BYTES);
      if (!upload.ok) return sendJson(res, upload.status, { error: upload.error });
      const conversationId = url.searchParams.get('conversationId');
      const stored = await deps.chat.artifacts.save({
        bytes: upload.file.bytes,
        mime: upload.file.mime,
        filename: upload.file.filename,
        // The source names the surface and the conversation the file was
        // dropped into, which is what makes dedup per-chat rather than global:
        // the same statement dropped in two conversations is two artifacts.
        source: {
          surface: WEB_CHAT_SURFACE,
          chatId: conversationId && conversationId.trim() !== '' ? conversationId : 'web',
          messageId: randomUUID(),
        },
        createdBy: deps.ctx.ownerId,
        ...(conversationId && conversationId.trim() !== '' ? { conversationId } : {}),
      });
      return sendJson(res, 200, {
        artifactId: stored.id,
        filename: stored.filename ?? upload.file.filename,
        mime: stored.mime,
        kind: stored.kind,
        sizeBytes: stored.sizeBytes,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendJson(res, 413, { error: err.message });
      return sendJson(res, 400, { error: 'request body must be JSON' });
    }

    if (path === '/api/presence') return reply(res, await presenceRoute(deps.pool, body, deps.now()));
    if (path === '/api/api-tokens') return reply(res, await apiTokensRoute(deps.pool, { method, path, body, now }));
    if (path === '/api/notifications/test') return reply(res, await testChannelRoute(body, deps.now()));
    if (path === '/api/notifications/agent-mute') return reply(res, await agentMuteRoute(deps.pool, body));
    const seen = /^\/api\/notifications\/([^/]+)\/seen$/.exec(path);
    if (seen) return reply(res, await markSeenRoute(deps.pool, decodeURIComponent(seen[1] as string), deps.now()));

    const approval = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(path);
    if (approval) {
      const scope = body.permissionScope ?? 'once';
      if (!['once', 'conversation', 'always'].includes(String(scope)) || typeof scope !== 'string') return sendJson(res, 400, { error: 'Invalid permission scope.' });
      // What the owner set on the card's controls. The shape is checked here;
      // whether each key and value was *offered* is core's to say, against the
      // action it was declared on (`resolveOwnerChoices`).
      const choices = body.ownerChoices;
      if (choices !== undefined && (choices === null || typeof choices !== 'object' || Array.isArray(choices))) {
        return sendJson(res, 400, { error: '`ownerChoices` must be an object of key to value.' });
      }
      return finish(
        res,
        await decideApprovalFromWeb(
          writeDeps,
          decodeURIComponent(approval[1] as string),
          approval[2] === 'approve' ? 'approved' : 'rejected',
          scope as PermissionScope,
          choices as Record<string, unknown> | undefined,
        ),
      );
    }

    if (path === '/api/host/stop' || path === '/api/host/revoke') {
      const host = hostService(deps.env ?? process.env);
      if (path.endsWith('/revoke')) {
        if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return sendJson(res, 400, { error: 'Expected permission id.' });
        const permission = (await listToolPermissions(deps.pool, deps.ctx.ownerId)).find(p => p.id === body.id && p.tool === 'host.exec');
        if (!permission) return sendEmpty(res, 404);
        await revokeToolPermission(deps.pool, deps.ctx.ownerId, permission.id);
        host.stop(deps.ctx.ownerId, permission.agentId, permission.conversationId || undefined);
        return sendJson(res, 200, { revoked: true });
      }
      if (typeof body.agentId !== 'string' || typeof body.conversationId !== 'string') return sendJson(res, 400, { error: 'Expected agentId and conversationId.' });
      return sendJson(res, 200, { stopped: host.stop(deps.ctx.ownerId, body.agentId, body.conversationId) });
    }

    /*
     * Alerts (alerts.ts): the owner's verbs on what the watchers found. Snooze
     * one ("Not now" for a week with `days`, "Not needed" without), several at
     * once (Clear all, and its Undo), silence a subject or a kind, run what a
     * finding declared, or ask the agent that answers for it.
     */
    const alert = /^\/api\/alerts\/([^/]+)\/snooze$/.exec(path);
    if (alert) {
      if (typeof body.snoozed !== 'boolean') return sendJson(res, 400, { error: '`snoozed` must be true or false' });
      const days = typeof body.days === 'number' && Number.isFinite(body.days) && body.days > 0 && body.days <= 90 ? body.days : null;
      const until = body.snoozed && days !== null ? new Date(deps.now().getTime() + days * 86_400_000) : null;
      const finding = await snoozeFinding(deps.pool, decodeURIComponent(alert[1]!), body.snoozed, deps.now(), until);
      if (!finding) return sendJson(res, 404, { error: 'No open alert has that key.' });
      return sendJson(res, 200, {
        key: finding.key,
        snoozedAt: finding.snoozedAt ? finding.snoozedAt.toISOString() : null,
        snoozedUntil: finding.snoozedUntil ? finding.snoozedUntil.toISOString() : null,
      });
    }
    if (path === '/api/alerts/snooze') {
      const keys = Array.isArray(body.keys) ? body.keys.filter((k: unknown): k is string => typeof k === 'string').slice(0, 500) : null;
      if (keys === null || typeof body.snoozed !== 'boolean') return sendJson(res, 400, { error: 'Send `{ keys: string[], snoozed: boolean, days? }`.' });
      const days = typeof body.days === 'number' && Number.isFinite(body.days) && body.days > 0 && body.days <= 90 ? body.days : null;
      const until = body.snoozed && days !== null ? new Date(deps.now().getTime() + days * 86_400_000) : null;
      return sendJson(res, 200, { keys: await snoozeFindings(deps.pool, keys, body.snoozed, deps.now(), until) });
    }
    if (path === '/api/alerts/mute') return reply(res, await muteAlert(deps.pool, body, deps.now()));
    const unmute = /^\/api\/alerts\/mutes\/([^/]+)\/remove$/.exec(path);
    if (unmute) {
      const removed = await unmuteFindings(deps.pool, decodeURIComponent(unmute[1]!));
      return removed ? sendJson(res, 200, { removed: true }) : sendJson(res, 404, { error: 'Nothing is silenced under that id.' });
    }
    if (path === '/api/alerts/act') {
      if (actRateLimited(session.id, deps.now().getTime())) return sendJson(res, 429, { error: 'Too many writes from this page. Wait a moment and try again.' });
      return reply(res, await actOnAlerts({ pool: deps.pool, registry: deps.registry, ctx: deps.ctx, now: deps.now }, body, session));
    }
    if (path === '/api/alerts/ask') {
      const keys = Array.isArray(body.keys) ? body.keys.filter((k: unknown): k is string => typeof k === 'string') : [];
      const findings = await findingsForAsk(deps.pool, keys);
      if (findings.length === 0) return sendJson(res, 404, { error: 'No alert has those keys.' });
      if (!chat) return sendJson(res, 503, { error: 'Chat is not running in this process.' });
      // The agent that answers for them, else whoever runs the wake mission.
      const wake = (await listMissions(deps.pool)).find((m) => m.id === 'sentinel-wake');
      const agentId = findings.find((f) => f.agentId !== null && deps.catalog.get(f.agentId) !== undefined)?.agentId ?? wake?.agentId ?? null;
      if (agentId === null) return sendJson(res, 409, { error: 'No agent answers for this alert yet.' });
      const { label, prompt } = askPrompt(findings);
      const sent = await chat.send({ agentId, text: prompt, offer: { id: `alert:${findings[0]!.key}`.slice(0, 200), label, brief: true } });
      if (!sent.ok) return sendJson(res, sent.status, { error: sent.error });
      return sendJson(res, 200, { agentId, conversationId: sent.conversationId, runId: sent.runId });
    }

    /*
     * A watcher, switched off or back on. Off means it does not run: it raises
     * nothing and resolves nothing, so what it already found stays as it was.
     *
     * The id has to name a watcher this installation actually ships. The store
     * itself takes any id on purpose (a plugin mid-reinstall must not lose the
     * owner's decision), but the route is the outside world: an unknown id
     * there is a typo or a probe, and answering 200 to it would write a row
     * nothing will ever read and tell the caller it had switched something off.
     */
    const sentinelEnabled = /^\/api\/sentinels\/([^/]+)\/enabled$/.exec(path);
    if (sentinelEnabled) {
      if (typeof body.enabled !== 'boolean') {
        return sendJson(res, 400, { error: '`enabled` must be true or false' });
      }
      const sentinelId = decodeURIComponent(sentinelEnabled[1] as string);
      const installed = deps.registry
        .manifests()
        .flatMap((m) => m.sentinels ?? [])
        .some((s) => s.id === sentinelId);
      if (!installed) {
        return sendJson(res, 400, { error: `no watcher is installed with the id ${sentinelId}` });
      }
      const state = await setSentinelEnabled(deps.pool, sentinelId, body.enabled, deps.now());
      return sendJson(res, 200, { sentinelId: state.sentinelId, enabled: state.enabled });
    }

    /* One thing on Home closed until it changes (the digest's ×, a notice's Not now), or shown again. */
    if (path === '/api/home/dismiss') {
      const result = await setHomeDismissed(deps.pool, body.slot, body.token === undefined ? undefined : body.token);
      return sendJson(res, result.status, result.body);
    }

    /* One Home glance, hidden or shown again (Home's ×, Settings → Appearance). */
    const glanceHidden = /^\/api\/home\/glances\/([^/]+)\/hidden$/.exec(path);
    if (glanceHidden) {
      if (typeof body.hidden !== 'boolean') {
        return sendJson(res, 400, { error: '`hidden` must be true or false' });
      }
      const result = await setGlanceHidden(
        { pool: deps.pool, registry: deps.registry },
        decodeURIComponent(glanceHidden[1] as string),
        body.hidden,
      );
      return sendJson(res, result.status, result.body);
    }

    /* One plugin rail page, hidden from the rail or shown again (Settings → Appearance). */
    const railHidden = /^\/api\/rail\/pages\/([^/]+)\/([^/]+)\/hidden$/.exec(path);
    if (railHidden) {
      if (typeof body.hidden !== 'boolean') {
        return sendJson(res, 400, { error: '`hidden` must be true or false' });
      }
      const result = await setRailPageHidden(
        { pool: deps.pool, registry: deps.registry },
        decodeURIComponent(railHidden[1] as string),
        decodeURIComponent(railHidden[2] as string),
        body.hidden,
      );
      return sendJson(res, result.status, result.body);
    }

    if (path === '/api/pause') {
      const paused = body.paused;
      if (typeof paused !== 'boolean') {
        return sendJson(res, 400, { error: '`paused` must be true or false' });
      }
      return finish(res, await setPausedFromWeb(writeDeps, paused));
    }

    const missionEnabled = /^\/api\/missions\/([^/]+)\/enabled$/.exec(path);
    if (missionEnabled) {
      const enabled = body.enabled;
      if (typeof enabled !== 'boolean') {
        return sendJson(res, 400, { error: '`enabled` must be true or false' });
      }
      return finish(
        res,
        await setMissionEnabledFromWeb(
          writeDeps,
          decodeURIComponent(missionEnabled[1] as string),
          enabled,
        ),
      );
    }

    const missionKeep = /^\/api\/missions\/([^/]+)\/keep$/.exec(path);
    if (missionKeep) return finish(res, await keepMissionFromWeb(writeDeps, decodeURIComponent(missionKeep[1] as string)));

    const missionStillUseful = /^\/api\/missions\/([^/]+)\/still-useful$/.exec(path);
    if (missionStillUseful) {
      const answer = body.answer;
      if (answer !== 'keep' && answer !== 'stop') return sendJson(res, 400, { error: "`answer` must be 'keep' or 'stop'" });
      return finish(res, await answerStillUsefulFromWeb(writeDeps, decodeURIComponent(missionStillUseful[1] as string), answer));
    }

    const missionSchedule = /^\/api\/missions\/([^/]+)\/schedule$/.exec(path);
    if (missionSchedule) {
      return finish(
        res,
        await setScheduleFromWeb(writeDeps, decodeURIComponent(missionSchedule[1] as string), {
          cron: typeof body.cron === 'string' ? body.cron : undefined,
          timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
          misfirePolicy: typeof body.misfirePolicy === 'string' ? body.misfirePolicy : undefined,
          deadlineMinutes:
            body.deadlineMinutes === null
              ? null
              : typeof body.deadlineMinutes === 'number'
                ? body.deadlineMinutes
                : undefined,
        }),
      );
    }

    const anthropicRoute = /^\/api\/provider-accounts\/([^/]+)\/anthropic\/(login|complete-login|cancel-login|logout)$/.exec(path);
    const ollamaRoute = /^\/api\/provider-accounts\/([^/]+)\/ollama\/(connect|poll|disconnect)$/.exec(path);
    const accountRoute = /^\/api\/provider-accounts\/([^/]+)\/(test|remove|login|cancel-login|logout|models)$/.exec(path);
    const accountAssignment = /^\/api\/agents\/([^/]+)\/account$/.exec(path);
    if (path === '/api/provider-accounts/save' || path === '/api/provider-accounts/probe-models' || accountRoute || accountAssignment || anthropicRoute || ollamaRoute) {
      if (!deps.providerAccounts) return sendJson(res, 503, { error: 'Provider accounts are unavailable in this process.' });
      try {
        const result = path === '/api/provider-accounts/probe-models'
          ? await deps.providerAccounts.probeModels(body)
          : ollamaRoute
          ? await deps.providerAccounts.ollamaAction(decodeURIComponent(ollamaRoute[1]!), ollamaRoute[2] as 'connect' | 'poll' | 'disconnect', body, session.id)
          : anthropicRoute
          ? await deps.providerAccounts.anthropicAction(decodeURIComponent(anthropicRoute[1]!), anthropicRoute[2] as 'login' | 'complete-login' | 'cancel-login' | 'logout', body, session.id)
          : accountAssignment
          ? await deps.providerAccounts.assign(decodeURIComponent(accountAssignment[1]!), body)
          : accountRoute ? accountRoute[2] === 'models'
            ? await deps.providerAccounts.models(decodeURIComponent(accountRoute[1]!), body.refresh === true)
            : accountRoute[2] === 'test'
            ? await deps.providerAccounts.test(decodeURIComponent(accountRoute[1]!), { reuseWithinMs: ACCOUNT_TEST_COOLDOWN_MS })
            : accountRoute[2] === 'remove'
              ? await deps.providerAccounts.remove(decodeURIComponent(accountRoute[1]!), body.revision as number)
              : await deps.providerAccounts.codexAction(decodeURIComponent(accountRoute[1]!), accountRoute[2] as 'login' | 'cancel-login' | 'logout', body.revision)
          : await deps.providerAccounts.save(body);
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error instanceof ProviderAccountError ? error.status : 500,
          { error: error instanceof ProviderAccountError ? error.message : 'Account operation failed. Check vault and database availability.' });
      }
    }
    const providerSettingsRoute = /^\/api\/providers\/(anthropic|openai)\/(settings|test)$/.exec(path);
    const credentialRoute = /^\/api\/providers\/credentials\/([^/]+)\/(save|remove)$/.exec(path);
    if (providerSettingsRoute || credentialRoute) {
      if (deps.providerAccounts) return sendJson(res, 410, { error: 'Global credentials have been replaced by named provider accounts. Reload the dashboard.' });
      if (!deps.providerSettings) return sendJson(res, 503, { error: 'Provider management is unavailable in this process.' });
      try {
        const result = providerSettingsRoute
          ? providerSettingsRoute[2] === 'test' ? await deps.providerSettings.test(providerSettingsRoute[1]!) : await deps.providerSettings.configure(providerSettingsRoute[1]!, body)
          : await deps.providerSettings.credential(credentialRoute![1]!, credentialRoute![2] as 'save' | 'remove', body);
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error instanceof ProviderSettingsError ? error.status : 500,
          { error: error instanceof ProviderSettingsError ? error.message : 'Provider settings could not be applied. Check vault access and database availability, then retry.' });
      }
    }

    /*
     * Backups, and leaving recovery.
     *
     * Every one of these is forwarded to the supervisor when there is one and
     * run in this process when there is not; `backups.ts` is where that fork
     * lives, so the routes here are the gate and nothing else.
     */
    /*
     * Plugins.
     *
     * Staging is a job because fetching and installing dependencies takes as
     * long as it takes; approving is separate and carries back the integrity
     * the owner was shown, so a click can only ever approve the thing that was
     * read about. `plugins.ts` holds every one of those decisions.
     */
    if (path === '/api/plugins/stage') return reply(res, stageRoute(pluginDeps(), body));
    const stagedApprove = /^\/api\/plugins\/staged\/([A-Za-z0-9._-]{1,128})\/(approve|reject|opened)$/.exec(path);
    if (stagedApprove) {
      const id = stagedApprove[1] as string;
      if (stagedApprove[2] === 'opened') return reply(res, openedRoute(pluginDeps(), id));
      return reply(res, stagedApprove[2] === 'approve'
        ? await approveRoute(pluginDeps(), id, body)
        : rejectRoute(pluginDeps(), id));
    }
    /*
     * Accepting an agent a plugin proposes, from the page that lists it. It
     * is the owner invoking the same gated tool Agent Father invokes, and the
     * owner's click is the approval: the action is recorded, then decided
     * through the card's own decide in the same request.
     */
    const offerDismissed = /^\/api\/agent-offers\/([^/]+)\/([^/]+)\/dismiss$/.exec(path);
    if (offerDismissed) {
      return reply(res, await dismissAgentOffer(
        agentOffersDeps(),
        decodeURIComponent(offerDismissed[1] as string),
        decodeURIComponent(offerDismissed[2] as string),
      ));
    }
    /*
     * The agent catalogue's writes: a plan writes nothing; install answers a
     * job; update and remove are the owner's click as the approval, like the
     * accept route below.
     */
    const catalogueConfirm = /^\/api\/catalogue\/jobs\/([0-9a-f-]{36})\/confirm$/i.exec(path);
    if (catalogueConfirm) {
      return reply(res, await catalogueConfirmJobRoute(catalogueDeps(), catalogueConfirm[1] as string, (body ?? {}) as Record<string, unknown>));
    }
    const catalogueWrite = /^\/api\/catalogue\/([a-z][a-z0-9-]{0,39})\/(plan|install|update\/plan|update)$/.exec(path);
    if (catalogueWrite) {
      const name = catalogueWrite[1] as string;
      const verb = catalogueWrite[2] as string;
      const input = (body ?? {}) as Record<string, unknown>;
      if (verb === 'plan') return reply(res, await cataloguePlanRoute(catalogueDeps(), name, input));
      if (verb === 'install') return reply(res, await catalogueInstallRoute(catalogueDeps(), name, input));
      if (verb === 'update/plan') return reply(res, await catalogueUpdatePlanRoute(catalogueDeps(), name, input));
      return reply(res, await catalogueUpdateRoute(catalogueDeps(), name, input));
    }
    const removeAgent = /^\/api\/agents\/([^/]+)\/remove$/.exec(path);
    if (removeAgent) return reply(res, await removeAgentRoute(catalogueDeps(), decodeURIComponent(removeAgent[1] as string)));
    const acceptAgent = /^\/api\/plugins\/([^/]+)\/agents\/([^/]+)\/accept$/.exec(path);
    if (acceptAgent) {
      return reply(res, await acceptAgentRoute(
        {
          ...pagesDeps(),
          agents: () => deps.catalog.list(),
          approve: (actionId) => decideApprovalFromWeb(writeDeps, actionId, 'approved'),
          pendingAccept: async (plugin, agentId) => {
            const pending = await listPendingActions(deps.pool, { now: deps.now() }).catch(() => []);
            return pending.find((action) => isPendingAccept(action, plugin, agentId))?.id ?? null;
          },
        },
        decodeURIComponent(acceptAgent[1] as string),
        decodeURIComponent(acceptAgent[2] as string),
      ));
    }
    const pluginAction = /^\/api\/plugins\/([^/]+)\/(update|uninstall|disable|enable)$/.exec(path);
    if (pluginAction) {
      const name = decodeURIComponent(pluginAction[1] as string);
      const verb = pluginAction[2] as string;
      if (verb === 'disable' || verb === 'enable') {
        return reply(res, await toggleRoute(pluginDeps(), name, verb === 'enable'));
      }
      return reply(res, verb === 'update'
        ? updateRoute(pluginDeps(), name, body)
        : await uninstallRoute(pluginDeps(), name, body));
    }

    /*
     * The version check, and the upgrade itself. Both are the supervisor's
     * work; an upgrade answers with a job and then takes this gateway down,
     * which is why the page follows the job until it stops answering and then
     * waits for `/api/session` to come back with a different version.
     */
    if (path === '/api/version/check') return reply(res, await versionCheckRoute(versionDeps(), 'POST'));
    if (path === '/api/upgrade') return reply(res, await upgradeRoute(versionDeps(), body));

    if (path === '/api/backups') return reply(res, await createBackupRoute(backupDeps(), body));
    if (path === '/api/backups/passphrase/notice') return sendJson(res, 200, await acknowledgePassphrase({ pool: deps.pool, now: deps.now }));
    if (path === '/api/system/cli') {
      if (session.via !== 'local') return sendJson(res, 403, { error: 'Change this from the computer buddi runs on.' });
      return reply(res, await cliToolRoute(deps.env ?? process.env, 'POST'));
    }
    if (path === '/api/system/uninstall/backup' || path === '/api/system/uninstall') {
      if (session.via !== 'local') return sendJson(res, 403, { error: 'Remove buddi from the computer it runs on.' });
      const uninstallDeps = { env: deps.env ?? process.env, now: deps.now };
      return reply(res, path === '/api/system/uninstall/backup'
        ? await uninstallBackupRoute(uninstallDeps, uninstallTokens, body)
        : await removeBuddiRoute(uninstallDeps, uninstallTokens, body));
    }
    if (path === '/api/backups/passphrase/reveal') {
      const allowed = await lock.verify((body as { pin?: unknown }).pin);
      if (!allowed.ok) return sendJson(res, allowed.status, allowed.body);
      return reply(res, await passphraseRoute(backupDeps(), 'GET'));
    }
    if (path === '/api/backups/verify') return reply(res, await verifyBackupRoute(backupDeps(), body));
    if (path === '/api/backups/restore') {
      return reply(res, await restoreRoute(backupDeps(), {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.passphrase === 'string' ? { passphrase: body.passphrase } : {}),
        ...(typeof body.confirm === 'string' ? { confirm: body.confirm } : {}),
      }));
    }
    /*
     * First run, restoring instead of starting: the one restore that needs no
     * typed-back confirmation, because there is nothing here to lose yet. That
     * is also exactly what is checked — a pending onboarding and no agent of
     * the owner's own. The moment either is false this is an ordinary restore
     * and goes through `/api/backups/restore`, confirmation and all.
     */
    if (path === '/api/onboarding/restore') {
      const refusal = await onboardingRestoreRefusal();
      if (refusal) return sendJson(res, refusal.status, { error: refusal.message });
      return reply(res, await restoreRoute(backupDeps(), {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.passphrase === 'string' ? { passphrase: body.passphrase } : {}),
      }));
    }
    if (path === '/api/recovery/leave') {
      if (body.dropPending !== undefined && typeof body.dropPending !== 'boolean') {
        return sendJson(res, 400, { error: '`dropPending` must be true or false' });
      }
      const keep = body.keepGrants;
      if (keep !== undefined && (!Array.isArray(keep) || keep.some((id) => typeof id !== 'string'))) {
        return sendJson(res, 400, { error: '`keepGrants` must be a list of grant ids' });
      }
      /*
       * The loops are decided once, at startup (see `serve.ts`), so leaving
       * recovery is finished by a restart rather than by flipping anything
       * live — and a row cleared without that restart is an installation that
       * says it has recovered while every loop it needs is still off.
       *
       * So the supervisor is *asked whether it is there* first, and nothing is
       * dropped or cleared when it is not: the owner is told where the button
       * is instead. The restart itself is asked for only once the reply is on
       * the wire, because it kills this process — ordering it before the work
       * meant the SIGTERM landed in the middle of dropping the pending jobs,
       * with the pool ending under the request that was clearing the row. In a
       * checkout there is no supervisor to ask and the loops start the next
       * time `buddi serve` is started by whoever started this.
       */
      const socket = (deps.env ?? process.env).BUDDI_SUPERVISOR_SOCKET;
      if (socket) {
        try {
          const reachable = await supervisorCall(socket, '/status', 'GET');
          if (reachable.status >= 300) throw new Error(`the supervisor answered ${reachable.status}`);
        } catch (err) {
          log(`web: supervisor restart after leaving recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          return sendJson(res, 502, {
            error: 'Recovery is finished but the service could not be restarted; use Settings → Service → Restart',
          });
        }
      }
      const outcome = await leaveRecoveryMode(
        { pool: deps.pool, env: deps.env ?? process.env, log },
        deps.ctx.ownerId,
        { dropPending: body.dropPending !== false, keepGrants: keep as string[] | undefined },
        now,
      );
      if (socket) {
        goingAway = 'restart';
        res.once('finish', () => {
          void supervisorCall(socket, '/restart', 'POST').catch((err: unknown) => {
            goingAway = undefined;
            log(`web: supervisor restart after leaving recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
      }
      return sendJson(res, socket ? 202 : 200, { ...outcome, restarting: socket !== undefined });
    }

    /*
     * Start, stop or restart the gateway through the supervisor.
     *
     * Behind the same session, Origin and CSRF gate as every other write, and
     * nothing more: the socket is owner-only already.
     *
     * `start` is answered with the supervisor's new status, because the
     * gateway answering is the one that stays up. `stop` and `restart` are
     * not: the supervisor's very next act is to kill this process, and
     * `serve`'s shutdown destroys open connections, so a reply composed after
     * the action would never reach the browser. They are therefore accepted
     * first and performed once the reply is on the wire. The page warns that
     * it is about to close itself, and `buddi` from a terminal is the way back
     * from a gateway that is down — a stopped gateway cannot serve its own
     * Start button.
     */
    const serviceAction = /^\/api\/service\/(start|stop|restart)$/.exec(path);
    if (serviceAction) {
      const socket = (deps.env ?? process.env).BUDDI_SUPERVISOR_SOCKET;
      if (!socket) return sendJson(res, 404, { error: 'This gateway is not run by a supervisor; there is nothing to control.' });
      const action = serviceAction[1]!;
      if (action === 'start') {
        try {
          const reply = await supervisorCall(socket, '/start', 'POST');
          if (reply.status !== 200) return sendJson(res, 502, { error: 'The supervisor refused that action.' });
          return sendJson(res, 200, { supervised: true, status: reply.body });
        } catch {
          return sendJson(res, 503, { error: 'The supervisor is not answering on its control socket. Run buddi in a terminal.' });
        }
      }
      goingAway = action === 'stop' ? 'stop' : 'restart';
      res.once('finish', () => {
        void supervisorCall(socket, `/${action}`, 'POST').catch((err: unknown) => {
          goingAway = undefined;
          log(`web: supervisor ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      return sendJson(res, 202, { supervised: true, pending: action });
    }

    /* Groups: create one, send to one, stop its current request. */
    if (path === '/api/groups') {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const coordinator = typeof body.coordinator === 'string' ? body.coordinator.trim() : '';
      if (!Array.isArray(body.members) || body.members.some((m) => typeof m !== 'string' || m.trim() === '')) return sendJson(res, 400, { error: '`members` must be a list of agent ids.' });
      const members = (body.members as string[]).map((m) => m.trim());
      if (name === '' || name.length > 80) return sendJson(res, 400, { error: 'A group needs a name, up to 80 characters.' });
      if (!deps.catalog.get(coordinator)) return sendJson(res, 400, { error: 'Pick a coordinator from the installed agents.' });
      const unknown = members.filter((m) => !deps.catalog.get(m));
      if (unknown.length > 0) return sendJson(res, 400, { error: `Not installed: ${unknown.join(', ')}` });
      if (new Set([coordinator, ...members]).size < 2) return sendJson(res, 400, { error: 'A group needs at least one member besides the coordinator.' });
      const group = await createGroup(deps.pool, { name, coordinator, members });
      return sendJson(res, 200, groupView(group));
    }
    const groupMessages = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/messages$/i.exec(path);
    if (groupMessages) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (typeof body.text !== 'string') return sendJson(res, 400, { error: '`text` must be a string' });
      if (body.conversationId !== undefined && typeof body.conversationId !== 'string') return sendJson(res, 400, { error: '`conversationId` must be a string' });
      const ids = body.attachmentIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) return sendJson(res, 400, { error: '`attachmentIds` must be an array of artifact ids' });
      const sent = await chat.sendToGroup({
        groupId: groupMessages[1]!,
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        text: body.text,
        ...(ids ? { attachmentIds: ids as string[] } : {}),
      });
      if (!sent.ok) return sendJson(res, sent.status, { error: sent.error });
      return sendJson(res, 202, { conversationId: sent.conversationId, runId: sent.runId, requestId: sent.requestId, ...(sent.rolledOver ? { rolledOver: true } : {}) });
    }
    const groupNewConversation = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/conversations$/i.exec(path);
    if (groupNewConversation) {
      const group = await getGroup(deps.pool, groupNewConversation[1]!);
      if (!group) return sendJson(res, 404, { error: 'no such group' });
      return sendJson(res, 200, { conversationId: await createGroupConversation(deps.pool, group) });
    }
    const groupArchive = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/archive$/i.exec(path);
    if (groupArchive) {
      return (await archiveGroup(deps.pool, groupArchive[1]!, deps.now())) ? sendEmpty(res, 204) : sendEmpty(res, 404);
    }
    // Undo a delete, while the minute lasts. Too late: 410, and the page says so.
    const groupRestore = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/restore$/i.exec(path);
    if (groupRestore) {
      const back = await restoreGroup(deps.pool, groupRestore[1]!, deps.now());
      return back ? sendJson(res, 200, groupView(back)) : sendJson(res, 410, { error: 'Too late to undo: that group is gone for good.' });
    }
    // Clear the history, keep the group: its conversations go, its members and memory stay.
    const groupClear = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/clear$/i.exec(path);
    if (groupClear) {
      const group = await getGroup(deps.pool, groupClear[1]!);
      if (!group) return sendJson(res, 404, { error: 'no such group' });
      await stopGroupWork(deps.pool, chat, group.id, deps.now(), deps.ctx.ownerId);
      return sendJson(res, 200, { conversations: await clearGroupHistory(deps.pool, group.id) });
    }

    /*
     * First run, from the dashboard.
     *
     * Four writes against the one record core already owns. `complete` and
     * `skip` both close the machine, and closing it is what keeps the Telegram
     * interview and its nudge arc from ever opening for an owner who did this
     * here instead.
     */
    if (path === '/api/onboarding/step') {
      const step = typeof body.step === 'string' ? body.step.trim() : '';
      if (!(WEB_ONBOARDING_STEPS as readonly string[]).includes(step)) {
        return sendJson(res, 400, { error: `\`step\` must be one of ${WEB_ONBOARDING_STEPS.join(', ')}` });
      }
      // A step may carry the two facts the step name cannot: which
      // conversation the handover opened, and which account the owner chose.
      // Both are provenance a reload reads back, and both are refused as
      // anything but a string.
      for (const key of ['conversationId', 'accountId'] as const) {
        if (body[key] !== undefined && typeof body[key] !== 'string') {
          return sendJson(res, 400, { error: `\`${key}\` must be a string` });
        }
      }
      // Chapter 4 carries which of its rows were done: yes or no, nothing else.
      const reachKeys = ['phone', 'mailbox', 'app', 'browser'] as const;
      if (
        body.reach !== undefined &&
        (body.reach === null || typeof body.reach !== 'object' || Array.isArray(body.reach) ||
          Object.entries(body.reach as Record<string, unknown>).some(
            ([key, value]) => !(reachKeys as readonly string[]).includes(key) || typeof value !== 'boolean',
          ))
      ) {
        return sendJson(res, 400, { error: '`reach` must say yes or no for phone, mailbox, app and browser' });
      }
      // The first step recorded is also what starts the record, with this
      // surface's name on it. Already in progress, done or skipped: unchanged.
      await beginOnboarding(deps.pool, WEB_ONBOARDING_SURFACE);
      await markStepDone(deps.pool, step);
      await setOnboardingDetails(deps.pool, {
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
        ...(body.reach !== undefined ? { reach: body.reach as Record<string, boolean> } : {}),
      });
      return sendJson(res, 200, await readOnboarding(onboardingDeps()));
    }
    /*
     * Chapter 3: what buddi takes on. Records the tiles and starts the By-buddi
     * installs in the background; answers at once with a job per plugin.
     */
    /*
     * Fetch a model into the local Ollama, for the first run's "on this
     * computer". Answers at once; GET the same path for the progress.
     */
    if (path === '/api/onboarding/ollama/pull') {
      try {
        return sendJson(res, 202, { pull: ollamaPulls.start(typeof body.model === 'string' ? body.model : '') });
      } catch (error) {
        if (error instanceof PullRefusal) return sendJson(res, error.status, { error: error.message });
        throw error;
      }
    }
    if (path === '/api/onboarding/take-on') {
      try {
        return sendJson(res, 202, await startTakeOn(takeOnDeps(), body.tiles));
      } catch (error) {
        if (error instanceof TakeOnRefusal) return sendJson(res, error.status, { error: error.message });
        throw error;
      }
    }
    if (path === '/api/onboarding/complete' || path === '/api/onboarding/skip') {
      if (path.endsWith('/skip')) {
        // The explicit bypass. It records that the owner declined, and it is
        // allowed from anywhere in the wizard — that is what makes it a skip.
        await skipOnboarding(deps.pool, 'the owner skipped the dashboard wizard');
        return sendJson(res, 200, await readOnboarding(onboardingDeps()));
      }
      const before = await readOnboarding(onboardingDeps());
      // "Done" has to mean done. An installation with no model account or no
      // agent cannot answer anything, and recording it as finished would close
      // the first run — on both surfaces — over an install that does not work.
      const missing = [
        ...(before.needs.model ? ['a model account'] : []),
        ...(before.needs.agent ? ['an agent of your own'] : []),
      ];
      if (missing.length > 0) {
        return sendJson(res, 409, {
          error: `Setup is not finished: this installation still needs ${missing.join(' and ')}. Go back and add it, or set up later.`,
          needs: before.needs,
        });
      }
      await completeOnboarding(deps.pool, WEB_ONBOARDING_SURFACE);
      return sendJson(res, 200, await readOnboarding(onboardingDeps()));
    }
    if (path === '/api/onboarding/agent') {
      try {
        const created = await createFirstAgent(onboardingDeps(), {
          name: typeof body.name === 'string' ? body.name : '',
          handle: typeof body.handle === 'string' ? body.handle : '',
          description: typeof body.description === 'string' ? body.description : '',
          ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
          ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
          ...(typeof body.accountId === 'string' && body.accountId.trim() !== ''
            ? { accountId: body.accountId.trim() }
            : {}),
        });
        const view = readAgents(deps.catalog).find((agent) => agent.id === created.id);
        return sendJson(res, 200, {
          agent: view ?? null,
          id: created.id,
          handle: created.handle,
          file: created.file,
          live: created.live,
          accountId: created.assigned,
        });
      } catch (error) {
        if (error instanceof OnboardingRefusal) {
          return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
        }
        return sendJson(res, 500, { error: error instanceof Error ? error.message : 'The agent could not be written.' });
      }
    }

    /*
     * The brain, changed after the assistant exists.
     *
     * Its own route because two things have to move together: the assistant
     * onto the account the thread has just tested, and the shipped maker that
     * was following it. Doing that from the page would be two calls with a
     * rule between them, and the rule belongs on this side.
     */
    if (path === '/api/onboarding/brain') {
      if (typeof body.accountId !== 'string' || typeof body.model !== 'string') {
        return sendJson(res, 400, { error: '`accountId` and `model` must be strings' });
      }
      try {
        return sendJson(res, 200, await rebindBrain(onboardingDeps(), { accountId: body.accountId, model: body.model }));
      } catch (error) {
        if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: error instanceof Error ? error.message : 'That account could not be given to your assistant.' });
      }
    }

    /*
     * "Change either, or keep them" — after the assistant exists.
     *
     * Writing a *first* agent is refused once there is one, and the thread
     * promises the owner can still change its name, face and purpose. Same
     * file, same writer, reloaded in place: no second agent appears.
     */
    if (path === '/api/onboarding/agent/update') {
      try {
        const changed = updateFirstAgent(onboardingDeps(), {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
          ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
        });
        const view = readAgents(deps.catalog).find((agent) => agent.id === changed.id);
        return sendJson(res, 200, { agent: view ?? null, ...changed, accountId: null });
      } catch (error) {
        if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: error instanceof Error ? error.message : 'The assistant could not be changed.' });
      }
    }

    /*
     * Telegram, without a terminal: the token BotFather gave the owner, and
     * then a pairing code for the phone. Both behind the same session, Origin
     * and CSRF gate as every other write — this is the owner acting on their
     * own installation.
     */
    if (path === '/api/telegram/token' || path === '/api/telegram/pairing') {
      try {
        return sendJson(
          res,
          200,
          path === '/api/telegram/token'
            ? await saveTelegramToken(telegramDeps(), body.token)
            : await telegramPairing(telegramDeps()),
        );
      } catch (error) {
        if (error instanceof TelegramWebError) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: 'Telegram could not be set up from here.' });
      }
    }

    /*
     * A write from a plugin's page: `{ tool, args }`, invoked as the owner
     * through the registry. An `auto` tool executes and answers with its
     * result; a `gated` one answers `{ approvalId }` and the page draws the
     * approval card in place. Behind the same session, Origin and CSRF gate as
     * every other write.
     */
    /*
     * A write asked for through `buddi mcp`. Never applied here: it becomes an
     * approval whose envelope is the exact change (see `mcp/requests.ts`), and
     * the client polls `/api/approvals/:id` for the owner's decision.
     */
    if (path === '/api/mcp/request') {
      const answered = await requestThroughMcp(
        { registry: deps.registry, ctx: deps.ctx, now: deps.now, pool: deps.pool, askApproval: deps.askApproval, log },
        body,
      );
      return sendJson(res, answered.status, answered.body);
    }

    const pageAct = /^\/api\/pages\/([a-z][a-z0-9_-]{0,39})\/act$/.exec(path);
    if (pageAct) {
      const acted = await actOnPage(pagesDeps(), pageAct[1] as string, body, session);
      /*
       * A write that made one of this plugin's agents wanted (the first
       * mailbox saved) raises its approval at once, before the page reads
       * again: the card is there when the drawer closes. Once per agent.
       */
      if (acted.status === 200 && (acted.body as { result?: unknown }).result !== undefined) {
        await raiseAgentOffers({ ...agentOffersDeps(), askApproval: deps.askApproval, log }, pageAct[1] as string)
          .catch((err: unknown) => log(`agent offers: ${err instanceof Error ? err.message : String(err)}`));
      }
      return reply(res, acted);
    }

    /*
     * The Keys and secrets page's writes (owner-secrets §6): core's own
     * ownerOnly tools, invoked as the owner — the same atomic transition the
     * act route runs, behind the same rate limit, with the value crossing one
     * boundary into the tool that stores it.
     */
    if (path === '/api/secrets/act') {
      return reply(res, await secretsAct(secretsDeps(), body, session));
    }

    /*
     * Talking to buddi (docs/dashboard.md): the composer's microphone and the
     * speaker toggle, through the speech plugin's tools by name, as the owner.
     * They count against the plugin's daily caps like any use.
     */
    if (path === '/api/speech/transcribe') return reply(res, await transcribeRoute(speechDeps(), body));
    if (path === '/api/speech/say') return reply(res, await sayRoute(speechDeps(), body));

    /*
     * The owner's own profile. What an agent may write through owner.set_profile
     * the owner may write here directly; the same validation, the same row.
     */
    if (path === '/api/owner') {
      // The same checks as owner.set_profile and buddi.profile_update (owner-profile-edit.ts).
      const checked = checkProfilePatch(body);
      if (!checked.ok) return sendJson(res, 400, { error: checked.error });
      const patch = checked.patch;
      // The zone applies at once; schedules kept in the old one move with it.
      const { profile, zoneChange } = await saveOwnerProfile(deps.pool, patch, deps.env ?? process.env);
      // The birthday greeting follows the new day at once (missions/dates.ts).
      if (patch.birthday !== undefined) {
        await syncDateMissions({ pool: deps.pool, catalog: deps.catalog, now: deps.now, log }).catch((err: unknown) => log(`dates: ${err instanceof Error ? err.message : String(err)}`));
      }
      if (zoneChange) log(`owner: timezone ${zoneChange.from} → ${zoneChange.to}${zoneChange.missions.length > 0 ? `; moved ${zoneChange.missions.join(', ')}` : ''}`);
      return sendJson(res, 200, { ...profile, places: await placesList(deps.pool), detectedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, zones: knownTimezones() });
    }

    /* The owner's places beside the timezone: find one, save one, remove one (web/places.ts). */
    if (path.startsWith('/api/owner/places')) {
      const answered = await placesRoute({ pool: deps.pool, log, ...(deps.placesHttp ? { http: deps.placesHttp } : {}) }, path, body);
      if (answered) {
        // Plugins that read the places answer their setup again now.
        requirements.readiness.forget();
        return sendJson(res, answered.status, answered.body);
      }
    }

    /* People, the owner's side: add, change, forget, bring back (web/people.ts). */
    if (path.startsWith('/api/memory/people')) {
      const answered = await peopleRoute({ pool: deps.pool, catalog: deps.catalog, now: deps.now, log }, 'POST', path, body);
      if (answered) return sendJson(res, answered.status, answered.body);
    }

    /* Memory, the owner's side: correct a preference, retire one, edit or forget a note. */
    if (path === '/api/memory/preferences') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'shared';
      if (!/^[a-z0-9_]{1,120}$/.test(key)) return sendJson(res, 400, { error: 'A preference key is lower_snake_case, up to 120 characters.' });
      if (value === '' || value.length > 2000) return sendJson(res, 400, { error: 'A preference needs a value, up to 2,000 characters.' });
      if (scope !== 'shared' && !deps.catalog.list().some((agent) => agent.id === scope)) return sendJson(res, 400, { error: 'The scope must be shared or an agent id.' });
      return sendJson(res, 200, await setPreference(deps.pool, { key, value, scope, now: deps.now() }));
    }
    if (path === '/api/memory/preferences/forget') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'shared';
      if (key === '') return sendJson(res, 400, { error: '`key` is required' });
      const forgotten = await forgetPreference(deps.pool, { key, scope, now: deps.now() });
      return forgotten ? sendEmpty(res, 204) : sendEmpty(res, 404);
    }
    const noteRoute = /^\/api\/memory\/notes\/([0-9a-f-]{36})(\/forget)?$/.exec(path);
    if (noteRoute) {
      const id = noteRoute[1]!;
      if (noteRoute[2]) {
        return (await forgetNote(deps.pool, { id, now: deps.now() })) ? sendEmpty(res, 204) : sendEmpty(res, 404);
      }
      const change: { content?: string; scope?: string; kind?: string } = {};
      if (body.content !== undefined) {
        if (typeof body.content !== 'string' || body.content.trim() === '' || body.content.length > 2000) return sendJson(res, 400, { error: 'A note is one to 2,000 characters.' });
        change.content = body.content.trim();
      }
      if (body.scope !== undefined) {
        if (typeof body.scope !== 'string' || (body.scope !== 'shared' && !deps.catalog.list().some((agent) => agent.id === body.scope))) return sendJson(res, 400, { error: 'The scope must be shared or an agent id.' });
        change.scope = body.scope;
      }
      if (body.kind !== undefined) {
        if (body.kind !== 'fact' && body.kind !== 'observation' && body.kind !== 'todo') return sendJson(res, 400, { error: '`kind` must be fact, observation or todo' });
        change.kind = body.kind;
      }
      const updated = await updateNote(deps.pool, { id, ...change });
      return updated ? sendJson(res, 200, updated) : sendEmpty(res, 404);
    }

    /*
     * Which agent is the default, recorded for the installation.
     *
     * Not `/api/agents/:id/...`: the default is a property of the installation
     * and the body names whom it moves to, so one route records it however
     * many agents there are.
     */
    if (path === '/api/agents/default') {
      return finish(
        res,
        await setDefaultAgentFromWeb(
          {
            catalog: deps.catalog,
            record: (agentId) => writeDefaultAgentRecord(deps.pool, agentId),
          },
          body.agentId,
        ),
      );
    }

    /*
     * The front matter the runtime reads, edited in place.
     *
     * The same validation `platform.update_agent` runs — it *is* that code —
     * so a handle two agents would answer to, a tool this installation does
     * not have, and an edit that would leave a file the loader refuses come
     * back with the loader's own sentence. What the owner clicks Save on is
     * the approval; there is no second one.
     */
    const agentFile = /^\/api\/agents\/([^/]+)\/file$/.exec(path);
    if (agentFile) {
      const parsed = ownerEditableInput.safeParse({
        ...body,
        id: decodeURIComponent(agentFile[1] as string),
      });
      if (!parsed.success) {
        return sendJson(res, 400, {
          error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        });
      }
      try {
        return sendJson(res, 200, await updateAgentFromOwner(deps.registry, parsed.data));
      } catch (err) {
        if (err instanceof PlatformRefusal) {
          return sendJson(res, 400, { error: err.message, detail: { code: err.code } });
        }
        return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const delegatesRoute = /^\/api\/agents\/([^/]+)\/delegates$/.exec(path);
    if (delegatesRoute) {
      const search = agentSearchPath(deps.env ?? process.env);
      return finish(
        res,
        await setDelegatesFromWeb(
          { catalog: deps.catalog, agentsDir: search.owner.dir, examplesDir: EXAMPLES_AGENTS_DIR, reload: () => (deps.catalog as { reload?: () => void }).reload?.() },
          decodeURIComponent(delegatesRoute[1] as string),
          body.delegates,
        ),
      );
    }

    const engine = /^\/api\/agents\/([^/]+)\/engine$/.exec(path);
    if (engine) {
      if (deps.providerAccounts && (body.provider !== undefined || body.model !== undefined)) {
        return sendJson(res, 400, { error: 'Choose the account and model using the account selector; global provider choices are no longer used.' });
      }
      const change = engineChangeFromBody(body);
      if (typeof change === 'string') return sendJson(res, 400, { error: change });
      return finish(
        res,
        setAgentEngineFromWeb(
          { catalog: deps.catalog, env: deps.env ?? process.env },
          decodeURIComponent(engine[1] as string),
          change,
        ),
      );
    }

    // Failed jobs in bulk — by ids, by cause group, or every one still asking.
    // Dismiss keeps them on record and out of the footer's count.
    if (path === '/api/jobs/dismiss') return finish(res, await dismissJobsFromWeb(writeDeps, body));
    if (path === '/api/jobs/undismiss') return finish(res, await undismissJobsFromWeb(writeDeps, body));
    if (path === '/api/jobs/retry') return finish(res, await retryJobsFromWeb(writeDeps, body));

    const job = /^\/api\/jobs\/([^/]+)\/(retry|cancel)$/.exec(path);
    if (job) {
      const jobId = decodeURIComponent(job[1] as string);
      return finish(
        res,
        job[2] === 'retry'
          ? await retryJobFromWeb(writeDeps, jobId)
          : await cancelJobFromWeb(writeDeps, jobId),
      );
    }

    /*
     * Saying no. Same session, Origin and CSRF gate as every other write,
     * because it is the owner acting on their own installation — and the
     * weakest write there is: it starts nothing, and the row stays.
     */
    if (path === '/api/offers/dismiss-all') {
      return finish(
        res,
        await dismissOffersFromWeb(
          writeDeps,
          Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [],
        ),
      );
    }

    const dismissed = /^\/api\/offers\/([^/]+)\/dismiss$/.exec(path);
    if (dismissed) {
      return finish(
        res,
        await dismissOfferFromWeb(writeDeps, decodeURIComponent(dismissed[1] as string)),
      );
    }

    const offer = /^\/api\/offers\/([^/]+)\/take$/.exec(path);
    if (offer) {
      /*
       * `conversationId` is the thread the page has open, and it decides one
       * thing only: whether the take runs here, in front of the owner, or goes
       * on the queue. It can never redirect a run — the turn is sent on the
       * *offer's* conversation, with the *offer's* prompt, and a mismatch just
       * means the owner is looking somewhere else.
       */
      return finish(
        res,
        await takeOfferFromWeb(writeDeps, decodeURIComponent(offer[1] as string), {
          ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
          ...(chat
            ? {
                send: (input) =>
                  chat.send({
                    agentId: input.agentId,
                    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
                    text: input.prompt,
                    offer: input.offer,
                  }),
              }
            : {}),
        }),
      );
    }

    /* The weekly digest's day and hour: a new revision of its mission's schedule. */
    if (path === '/api/proposals/digest-schedule') {
      const day = Number(body.day);
      const hour = Number(body.hour);
      try {
        await setDigestSchedule(deps.pool, { day, hour }, deps.timezone);
      } catch (err) {
        if (err instanceof RangeError) return sendJson(res, 400, { error: err.message });
        throw err;
      }
      return sendJson(res, 200, { schedule: await readDigestSchedule(deps.pool, deps.now(), deps.timezone) });
    }

    /* Keep all: one owner action over a group of open rule cards (see proposals.ts). */
    if (path === '/api/proposals/keep-all') {
      const ids = Array.isArray(body.ids) ? body.ids.map((id: unknown) => String(id)) : [];
      return finish(res, await keepAllProposalsFromWeb(writeDeps, ids));
    }

    /*
     * Keeping or discarding what an agent proposed. The same gate as every
     * other write; what keeping does is the kind's own apply (see proposals.ts).
     */
    const proposal = /^\/api\/proposals\/([^/]+)\/(keep|discard)$/.exec(path);
    if (proposal) {
      const id = decodeURIComponent(proposal[1] as string);
      return finish(
        res,
        proposal[2] === 'keep'
          ? await keepProposalFromWeb(writeDeps, id, typeof body.text === 'string' ? body.text : undefined, {
              catalog: deps.catalog,
              reload: () => (deps.catalog as { reload?: () => void }).reload?.(),
              env: deps.env ?? process.env,
            })
          : await discardProposalFromWeb(writeDeps, id, typeof body.reason === 'string' ? body.reason : undefined),
      );
    }

    /* The Skills page's writes (skills.ts): each checked by reloading the catalog. */
    if (path === '/api/skills') return reply(res, createSkillRoute(skillsDeps(), body));
    const bundleAccept = /^\/api\/skills\/bundles\/([^/]+)$/.exec(path);
    if (bundleAccept) return reply(res, acceptBundleRoute(skillsDeps(), decodeURIComponent(bundleAccept[1] as string), body));
    const skillWrite = /^\/api\/skills\/([^/]+)\/(text|grants|trust)$/.exec(path);
    if (skillWrite) {
      const id = decodeURIComponent(skillWrite[1] as string);
      if (skillWrite[2] === 'text') return reply(res, editSkillRoute(skillsDeps(), id, body));
      if (skillWrite[2] === 'grants') return reply(res, grantSkillRoute(skillsDeps(), id, body));
      return reply(res, trustSkillRoute(skillsDeps(), id));
    }

    /*
     * "Remove this skill": a learned skill's current file goes, its versions
     * stay, and the proposal it came from counts as discarded from now.
     */
    const removeSkill = /^\/api\/agents\/([^/]+)\/skills\/([^/]+)\/remove$/.exec(path);
    if (removeSkill) {
      const result = await removeLearnedSkillFromWeb(
        {
          pool: deps.pool,
          catalog: deps.catalog,
          now: deps.now,
          reload: () => (deps.catalog as { reload?: () => void }).reload?.(),
        },
        decodeURIComponent(removeSkill[1] as string),
        decodeURIComponent(removeSkill[2] as string),
      );
      return result.ok ? sendJson(res, 200, result) : sendJson(res, result.status, { error: result.error });
    }

    const reminder = /^\/api\/reminders\/([^/]+)\/cancel$/.exec(path);
    if (reminder) {
      return finish(
        res,
        await cancelReminderFromWeb(
          writeDeps,
          decodeURIComponent(reminder[1] as string),
          typeof body.reason === 'string' ? body.reason : '',
        ),
      );
    }

    /* ---------------- chat ---------------- */

    const newConversation = /^\/api\/chat\/([^/]+)\/conversations$/.exec(path);
    if (newConversation) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      const created = await chat.newConversation(decodeURIComponent(newConversation[1] as string));
      if (!created.ok) return sendJson(res, created.status, { error: created.error });
      return sendJson(res, 200, { conversationId: created.conversationId });
    }

    const messages = /^\/api\/chat\/([^/]+)\/messages$/.exec(path);
    if (messages) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (typeof body.text !== 'string') {
        return sendJson(res, 400, { error: '`text` must be a string' });
      }
      if (body.conversationId !== undefined && typeof body.conversationId !== 'string') {
        return sendJson(res, 400, { error: '`conversationId` must be a string' });
      }
      const ids = body.attachmentIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
        return sendJson(res, 400, { error: '`attachmentIds` must be an array of artifact ids' });
      }
      /*
       * The one turn first run sends on the owner's behalf.
       *
       * Claimed against the onboarding record before it is queued, so a reload
       * mid-handover rejoins the conversation it already started instead of
       * opening a second one and having the assistant introduce itself twice.
       * It needs a conversation to claim, so it is refused without one.
       */
      if (body.opening === true) {
        if (typeof body.conversationId !== 'string') {
          return sendJson(res, 400, { error: '`opening` needs the conversation it opens' });
        }
        try {
          await claimOpeningTurn(onboardingDeps(), body.conversationId);
        } catch (error) {
          if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
          throw error;
        }
      }
      if (body.client !== undefined && (typeof body.client !== 'string' || body.client.trim() === '' || body.client.length > 80)) {
        return sendJson(res, 400, { error: '`client` must be a short string naming the MCP client' });
      }
      const sent = await chat.send({
        agentId: decodeURIComponent(messages[1] as string),
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        ...(typeof body.client === 'string' ? { client: body.client.trim() } : {}),
        text: body.opening === true
          ? await withFirstRunFacts(onboardingDeps(), body.text, {
              weatherAtHome,
              mailboxSet,
              installed: async () => (await readTakeOn(takeOnDeps())).plugins.filter((p) => p.state === 'ready').map((p) => p.title),
              now: deps.now,
            })
          : body.text,
        ...(ids ? { attachmentIds: ids as string[] } : {}),
        ...(body.opening === true ? { opening: true } : {}),
      });
      if (!sent.ok) return sendJson(res, sent.status, { error: sent.error });
      // 202: the turn is *accepted*, not answered. What happens next is on the
      // stream, which is where a run that takes forty seconds belongs.
      return sendJson(res, 202, {
        conversationId: sent.conversationId,
        runId: sent.runId,
        // The agent was already working and took this as an interjection. The
        // page draws it as added while working rather than as a turn of its
        // own, and keeps its own copy under the pending row's id until the
        // transcript carries the words.
        ...(sent.queued ? { queued: true } : {}),
        ...(sent.pendingId ? { pendingId: sent.pendingId } : {}),
      });
    }

    const questionAnswer = /^\/api\/chat\/questions\/([^/]+)\/answer$/.exec(path);
    if (questionAnswer) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      const skipped = body.skipped === true;
      if (!skipped && (typeof body.answer !== 'string' || body.answer.trim() === '')) {
        return sendJson(res, 400, { error: '`answer` must be a non-empty string' });
      }
      if (body.optionId !== undefined && typeof body.optionId !== 'string') {
        return sendJson(res, 400, { error: '`optionId` must be a string' });
      }
      const answered = await chat.answer({
        id: decodeURIComponent(questionAnswer[1] as string),
        answer: typeof body.answer === 'string' ? body.answer : '',
        ...(typeof body.optionId === 'string' ? { optionId: body.optionId } : {}),
        ...(skipped ? { skipped: true } : {}),
      });
      if (!answered.ok) return sendJson(res, answered.status, { error: answered.error });
      return sendJson(res, 202, answered);
    }

    const cancel = /^\/api\/chat\/conversations\/([^/]+)\/cancel$/.exec(path);
    if (cancel && chat && (await conversationGroup(deps.pool, decodeURIComponent(cancel[1]!)).catch(() => null))) {
      await chat.stopGroupRequest(decodeURIComponent(cancel[1]!));
      return sendJson(res, 200, { stopped: true });
    }
    if (cancel) {
      hostService(deps.env ?? process.env).stop(deps.ctx.ownerId, undefined, decodeURIComponent(cancel[1]!));
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      return sendJson(res, 200, {
        cancelled: chat.cancel(decodeURIComponent(cancel[1] as string)),
      });
    }

    return sendJson(res, 404, { error: 'no such endpoint' });
  }

  function finish(res: ServerResponse, result: WriteResult<unknown>): void {
    sendJson(res, result.status, result.body);
  }
}

/**
 * Start the dashboard. The token is resolved (and created on first run) before
 * the socket is bound, so a process that cannot keep a secret never listens.
 */
export async function startWebServer(
  deps: Omit<WebServerDeps, 'token'> & { token?: string },
): Promise<WebServer> {
  const token = deps.token ?? (await ensureWebToken()).token;
  // The zone stays a getter through the spread: Settings → Profile can change it.
  const server = createWebApp({ ...deps, token, get timezone() { return deps.timezone; } });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.port, deps.config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? deps.config.port;
  const previews = previewAppOf(server);
  const previewPort = previews ? await listenForPreviews(previews.server, port, deps) : null;
  /*
   * Publish it. Plugins are loaded into this process and a plugin with
   * `previews` needs the number to build a URL of its own — the developer
   * plugin's `tailscale serve` target is the case in hand, and it used to
   * guess "the dashboard plus one", which is wrong the moment that port was
   * taken. The environment is the gateway's own (`serve` passes `process.env`),
   * and `CoreToolContext.previewPort` reads the same value.
   */
  if (previewPort !== null) publishPreviewPort(deps.env ?? process.env, previewPort);
  // The ingress listener, after the previews have taken their port: bound
  // now when Cloudflare Access is on, and from then on as the setting changes.
  const ingress = ingressOf(server) as Ingress;
  await ingress.sync();
  /*
   * An approval nobody decides expires, and a delegation waiting on one is
   * handed the expiry as its failure: the approval's own lifetime is the
   * longest an agent waits on a colleague. Once a minute is plenty for a
   * bound measured in hours; unref'd so it never holds the process open.
   */
  const sweepChat = webChatOf(server);
  const expirySweep = sweepChat
    ? setInterval(() => {
        void sweepChat.sweepExpiredDelegations().catch((err) => (deps.log ?? console.log)(`web chat: expiring approvals failed: ${err instanceof Error ? err.message : String(err)}`));
      }, EXPIRY_SWEEP_MS)
    : null;
  expirySweep?.unref?.();
  return {
    server,
    port,
    previewPort,
    ingress,
    url: webUrl({ host: deps.config.host, port }),
    chat: webChatOf(server),
    close: async () => {
      if (expirySweep) clearInterval(expirySweep);
      // Said before anything closes, while the streams can still carry it.
      await CLOSING_SAYS.get(server)?.();
      // Both listeners, both awaited. A preview socket still open is a port
      // still held, and the next thing to want it — the next test, the
      // gateway coming back up — finds it taken.
      await Promise.all([
        ingress.close(),
        new Promise<void>((resolve) => {
          if (!previews || previewPort === null) return resolve();
          previews.server.closeAllConnections?.();
          previews.server.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
      ]);
    },
  };
}

/**
 * Bind the preview listener, on loopback, beside the dashboard.
 *
 * The port is the dashboard's plus one — so an owner who knows where their
 * dashboard is knows where its previews are — or whatever
 * `BUDDI_PREVIEW_PORT` says. A port already in use is tried again a few doors
 * along with a line in the log, rather than taking the dashboard down: a
 * gateway that will not start because a *preview* port is busy is a bad trade.
 * An ephemeral dashboard (`port: 0`, which is every test) gets an ephemeral
 * preview port, because "plus one" means nothing when the OS chose the one.
 */
/**
 * Ports this process has published into an environment.
 *
 * Read back by `listenForPreviews` so that our own publication is never
 * mistaken for the owner *configuring* a port: a second gateway in the same
 * process would otherwise find `BUDDI_PREVIEW_PORT` set to the first one's
 * port, fail to bind it, and serve no previews at all.
 */
const PUBLISHED_PREVIEW_PORTS = new Set<number>();

function publishPreviewPort(env: NodeJS.ProcessEnv, port: number): void {
  PUBLISHED_PREVIEW_PORTS.add(port);
  env.BUDDI_PREVIEW_PORT = String(port);
}

async function listenForPreviews(
  server: Server,
  dashboardPort: number,
  deps: Omit<WebServerDeps, 'token'>,
): Promise<number | null> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const raw = (deps.env ?? process.env).BUDDI_PREVIEW_PORT?.trim();
  const asked = raw === undefined || raw === '' ? null : Number(raw);
  // Our own echo is not a request. See `PUBLISHED_PREVIEW_PORTS`.
  const configured = asked !== null && PUBLISHED_PREVIEW_PORTS.has(asked) ? null : asked;
  const bind = (port: number): Promise<number | null> =>
    new Promise((resolve) => {
      const onError = (): void => resolve(null);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const address = server.address() as AddressInfo | null;
        resolve(address?.port ?? port);
      });
    });

  if (configured !== null && Number.isInteger(configured) && configured >= 0 && configured <= 65535) {
    const bound = await bind(configured);
    if (bound !== null) return bound;
    log(`web: BUDDI_PREVIEW_PORT ${configured} could not be bound; previews are not being served`);
    return null;
  }
  if (deps.config.port === 0) return bind(0);

  for (let offset = 1; offset <= PREVIEW_PORT_ATTEMPTS; offset += 1) {
    const port = dashboardPort + offset;
    if (port > 65535) break;
    const bound = await bind(port);
    if (bound === null) {
      log(`web: port ${port} is in use; trying the next one for previews`);
      continue;
    }
    if (offset > 1) log(`web: previews are on ${bound}, not ${dashboardPort + 1}, which was taken`);
    return bound;
  }
  log(`web: no free port near ${dashboardPort + 1}; previews are not being served`);
  return null;
}
