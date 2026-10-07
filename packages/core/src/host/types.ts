/**
 * `ctx.buddi`: the one surface a plugin reaches core through
 * (docs/plugin-host-api.md).
 *
 * The rest of a context is the *call* — who called, in which conversation,
 * under which approval. This is the *host*: everything a plugin reaches beyond
 * its own arguments, in areas. Seven are always present because they reach
 * nothing beyond the plugin itself; the rest exist only when the manifest
 * declares them in `uses`, and the owner read that list on the install card.
 *
 * Every method is async or plain, and takes and returns plain data, so that a
 * later move of plugins out of this process can put an RPC surface here
 * without a plugin noticing (§6). Types only: this file is part of
 * `@buddi/core/plugin`.
 */
import type { OwnerPlace } from '../places.js';
import type { PluginAsset } from '../plugin/assets.js';
import type { OAuthProvider, OAuthSignInRequest, OAuthSignInStart, OAuthSignInStatus } from '../plugin/sign-in.js';
import type { Vault } from '../vault/types.js';
import type { ToolPermission } from '../actions/permissions.js';
import type { ArtifactKind, ArtifactRow, ArtifactSource } from '../artifacts/store.js';
import type { ProposePolicyInput } from '../learning/policies.js';
import type { CreateProposalResult, TrackRecord } from '../learning/store.js';
import type { Proposal } from '../learning/types.js';
import type { ResolvedProvider } from '../provider.js';
import type { CodexImage, CodexImageOptions, CodexProfile, ProviderAccountListing } from '../provider-accounts.js';
import type { ToolContext, ToolDefinition } from '../tools.js';
import type { OnnxRuntimeState, OnnxSession, OnnxSessionOptions } from '../runtimes/onnx.js';
import type { ModelRequest, ModelState } from '../runtimes/models.js';
import type { EnsureModel } from '../runtimes/consent.js';

/** The host, bound to one plugin. See the file comment. */
export interface BuddiHost {
  /** `major.minor`, `HOST_API_VERSION`. A plugin asks for it as `buddi.hostApi`. */
  readonly version: string;
  /** This plugin's name: the manifest's `name`. */
  readonly plugin: string;
  /** An operational log line, prefixed with the plugin's name. Never the owner's channel. */
  log(line: string): void;
  /**
   * Replace any stored value a text contains with `‹secret:NAME›`
   * (docs/owner-secrets.md §5) — buddi's own keys included, under their
   * own names. Never the reverse, and never a read: the only thing a plugin
   * learns is *that* a value was there, which is exactly what it must refuse
   * to store. Always present, like `log`.
   */
  scrub(text: string): string;
  owner: OwnerArea;
  clock: ClockArea;
  db: DbArea;
  dir: DirArea;
  approvals: ApprovalsArea;
  pages: PagesArea;
  /** This plugin's own tools, added and removed while buddi runs. Since 1.6. */
  tools: ToolsArea;
  /** The hosts this plugin talks to that it learns while buddi runs. Since 1.7. */
  network: NetworkArea;
  /** Declared as `http`. */
  http?: HttpArea;
  /** Declared as `accounts`. */
  accounts?: AccountsArea;
  /** Declared as `files`, or `files:library` for the whole library. */
  files?: FilesArea;
  /** Declared as `memory`. A type only in 1.0: never present yet. */
  memory?: MemoryArea;
  /** Declared as `proposals`. */
  proposals?: ProposalsArea;
  /** Declared as `schedule`. */
  schedule?: ScheduleArea;
  /** Declared as `secrets`. */
  secrets?: SecretsArea;
  /** Declared as `owner:channel`. Since 1.3. */
  channels?: ChannelsArea;
  /** Present when the manifest declares `requires` (1.18) or `optional` (1.27). */
  plugins?: PluginsArea;
  /** Declared as `assets`. Since 1.27. */
  assets?: AssetsArea;
  /** Declared as `onnx`: buddi's one local-model engine. Since 1.32. */
  onnx?: OnnxArea;
  /** Declared as `onnx`: models kept once for every plugin. Since 1.32. */
  models?: ModelsArea;
}

/* ------------------------------------------------------------------ *
 * Always present
 * ------------------------------------------------------------------ */

/** Who this installation belongs to, and what they said about themselves. */
export interface OwnerArea {
  readonly id: string;
  /** The owner's IANA zone. */
  readonly timezone: string;
  /** The first runnable agent holding a role, or undefined when nobody does. */
  agentForRole(role: string): string | undefined;
  /**
   * Whether an agent with this id is installed. `true` where the host has no
   * roster to ask (a one-shot CLI process), so a caller never stops on a guess.
   * Since 1.1.
   */
  hasAgent(id: string): boolean;
  /** Directories no plugin may write into, whatever it was granted. */
  readonly protectedPaths: readonly string[];
  /**
   * The language the owner asked to be answered in (the profile's "Answer me
   * in"), as a tag: "fr", "pt-BR". Undefined when they left it blank or wrote
   * something that is not a language. Since 1.5.
   */
  language(): Promise<string | undefined>;
  /**
   * How the owner reads times and dates (Settings → Profile): `12h` or `24h`,
   * and `short` (Thu, Oct 1), `long` (Thursday, 1 October) or `iso`; null is
   * Auto — the reader's own taste. Since 1.19; absent before.
   */
  formats?(): Promise<{ time: '12h' | '24h' | null; date: 'short' | 'long' | 'iso' | null }>;
  /**
   * Tell the owner something (docs/notifications.md). Declared as
   * `owner:notify`; absent otherwise. Core picks the channel, never the
   * plugin; the row carries the plugin's name. Since 1.2.
   */
  notify?(message: PluginOwnerMessage): Promise<{ id: string }>;
  /**
   * The owner's places — Home, Work and any other they named on Settings →
   * Profile — each with its label, address, coordinates and zone, in their
   * order. Read-only. Declared as `owner:places`; absent otherwise. Since 1.18.
   */
  places?(): Promise<OwnerPlace[]>;
}

/**
 * `ctx.buddi.plugins` (since 1.18): the narrow road between plugins. Present
 * when the manifest declares `requires`. A plugin may call only the named
 * read-only exports of a plugin it requires, on the read-only pool, within a
 * few seconds; never a tool, never another schema.
 */
export interface PluginsArea {
  /**
   * Call `plugin`'s export `name` with `args`, validated by the export's own
   * parameters. Refused — a `PluginCallRefusal` naming why — when `plugin` is
   * not in this manifest's `requires` or `optional`, is not loaded, is outside
   * the range, or exports no such name. A write inside it fails as a page
   * query's does.
   */
  call<T = unknown>(plugin: string, name: string, args?: unknown): Promise<T>;
  /**
   * Whether `plugin` — one this manifest names in `requires` or `optional` —
   * is loaded now, at a version in the range. False for any other name. For a
   * plugin that adapts to another being there ("Needs Speech"). Since 1.27;
   * absent before.
   */
  has?(plugin: string): boolean;
}

/**
 * Small images this plugin fetched — an outlet's logo — kept by core and
 * served by buddi (since 1.27), so a page or a widget draws them without the
 * dashboard reaching the host they came from. Declared as `assets`.
 *
 * `put` takes PNG, JPEG, GIF (its first frame) or ICO, at most 256 KB, and
 * refuses SVG; core decodes it and keeps PNGs it drew itself, 64 and 128
 * pixels square plus an aspect-preserving variant up to 768 pixels, served session-gated at `/api/plugin-assets/<plugin>/<key>`.
 * 20 MB per plugin; everything is removed with the plugin. Refusals are
 * thrown with the sentence why.
 */
export interface AssetsArea {
  /** Keep `bytes` under `key` (lower case, digits, `.`, `_`, `-`), replacing what was there. */
  put(key: string, bytes: Buffer, mime: string): Promise<PluginAsset>;
  /** Delete one. False when there was none. */
  delete(key: string): Promise<boolean>;
  /** Every asset this plugin keeps. */
  list(): Promise<PluginAsset[]>;
}

/**
 * buddi's ONNX engine (1.32): downloaded on first need, for this platform
 * only, after the owner's yes, and shared by every plugin that declares
 * `onnx`. See `runtimes/onnx.ts`.
 */
export interface OnnxArea {
  /** Where the engine stands: absent, downloading, ready or failed, its version and size. */
  state(): Promise<OnnxRuntimeState>;
  /**
   * Ask for the engine, and the model it will run in the same card. Answers
   * at once with the state; when something is missing, `pending` is the card
   * raised (or the one already raised for the same thing), and nothing is
   * fetched before the owner approves it. Once the engine is here, a model the
   * plugin fetches itself asks nothing more.
   */
  ensure(req: { reason: string; model?: EnsureModel }): Promise<OnnxRuntimeState>;
  /**
   * A session over a model in this plugin's directory or in the shared models,
   * on the one engine. Loaded on its first `run`, unloaded after it sat idle.
   * Throws `OnnxUnavailable` when the engine is not ready.
   */
  createSession(modelPath: string, opts?: OnnxSessionOptions): Promise<OnnxSession>;
}

/** Shared models (1.32): one folder per id, one download across plugins. */
export interface ModelsArea {
  /** A model's state, with its folder once it is ready. */
  state(id: string): Promise<ModelState>;
  /** Ask for a model: one card, then one download, checked file by file. Answers at once. */
  ensure(req: ModelRequest & { reason: string; name?: string }): Promise<ModelState>;
}

/**
 * What a plugin may say to the owner: an urgency, a title, a few lines, a
 * dashboard link, a key that collapses repeats. The kind is always `plugin`
 * and the channel is the owner's choice.
 */
export interface PluginOwnerMessage {
  urgency: 'now' | 'today' | 'digest';
  /** One line: the whole message on a small channel. */
  title: string;
  /** A few lines, markdown-light. */
  text?: string;
  /** A dashboard place: `#/chat/…`, `#/settings/…`. */
  link?: { route: string };
  /** "This thing, again": collapses with an unsent message under the same key, this plugin's keys only. */
  dedupeKey?: string;
  /** The agent this is about, when there is one. */
  agentId?: string;
  /**
   * What the owner is asked to do, in a few words ("Renew the card?"), at most
   * 80 characters once trimmed. With it the message waits in Needs you and
   * counts on every badge until the owner deals with it; without it the
   * message is information. Since 1.24; an older buddi ignores it.
   */
  action?: string;
}

/** The clock. Never read the wall clock directly. */
export interface ClockArea {
  now(): Date;
  /** The owner's local date, `YYYY-MM-DD`. */
  today(): string;
}

/** A statement's answer. */
export interface DbResult<R> {
  rows: R[];
  /** How many rows the statement touched, as Postgres counts them; null when it counts none. */
  rowCount: number | null;
}

/** What a transaction's callback is handed: statements on one connection. */
export interface DbTransaction {
  query<R = any>(sql: string, params?: unknown[]): Promise<DbResult<R>>;
}

/** The database, never a raw pool: a plugin cannot `connect()` and change role. */
export interface DbArea {
  query<R = any>(sql: string, params?: unknown[]): Promise<DbResult<R>>;
  /** One connection, `begin`, the plugin's schema first on `search_path`, then commit or rollback. */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

/** A directory of the plugin's own: `<data>/plugins-data/<plugin>`. */
export interface DirArea {
  /** Absolute, created on first read. Never the data directory itself. */
  readonly path: string;
  /**
   * `<data>/<plugin>`, where the built-in browser and host plugins kept the
   * owner's profile and workspaces before `plugins-data` existed; undefined
   * for every other plugin. Not created.
   */
  readonly legacyPath: string | undefined;
}

/**
 * What a manifest's `register` hook is handed: the parts of the host that need
 * no call — the version, the plugin's name and its directory — for a plugin
 * that fixes something (a profile's place) before any context exists.
 */
export type RegisterHost = Pick<BuddiHost, 'version' | 'plugin' | 'dir' | 'channels' | 'tools' | 'network'>;

/**
 * Tools added and removed while buddi runs (since 1.6), for a plugin whose
 * tools are not known at boot: a connection made at 3pm brings its tools
 * without a restart (buddi-planning/specs/mcp-client.md §7).
 *
 * Every name must be in the plugin's own namespace (`<plugin>.<what>`), and a
 * plugin removes only what it added here, never a tool of its manifest. The
 * registry's checks are the ones a manifest's tools get: name shape, tier,
 * `untrusted`, the input schema, and no name registered twice. A batch is all
 * or nothing. Agents' `tools:` grants are resolved again on their next turn,
 * so `mcp.github.*` covers a tool registered after the agent was loaded.
 */
export interface ToolsArea {
  register(definitions: ToolDefinition<any, any>[]): void;
  unregister(names: string[]): void;
  /** The names this plugin has registered at runtime and not removed, in order. */
  registered(): string[];
}

/**
 * Hosts declared while buddi runs (since 1.7), beside the manifest's `network`:
 * a plugin that learns where it talks at 3pm (a connection the owner made)
 * says so here, and the "what leaves your machine" list on the Plugins page
 * shows it from that moment. The same egress policy reads both: `http`
 * treats a runtime host exactly as a manifest one.
 *
 * A host is a name (`mcp.notion.com`, or `*.example.com`), never a URL, a
 * port or an address; `why` is one line the owner can weigh. Declaring a host
 * the manifest already names changes nothing; declaring one again replaces its
 * `why`. `undeclare` removes only what `declare` added.
 */
export interface NetworkArea {
  declare(uses: ReadonlyArray<{ host: string; why: string }>): void;
  undeclare(hosts: readonly string[]): void;
  /** Everything declared: the manifest's first, then the runtime ones, in the order they came. */
  declared(): Array<{ host: string; why: string; runtime: boolean }>;
}

/** The owner's decisions about this plugin's own tools. */
export interface ApprovalsArea {
  /** Live owner settings authorize this tool in this exact executor run; never inherited by delegates. Since 1.33. */
  configuredForRun?(tool: string): Promise<boolean>;
  /** Throw unless `envelope` is the effect the owner approved on this call. */
  assert(ctx: ToolContext, envelope: unknown): void;
  /** The standing permission that answers for one of this plugin's tools on this call, or null. */
  standing(tool: string): Promise<ToolPermission | null>;
  /** Whether the owner approved this plugin's `tool` in a conversation or a delegation from it. */
  approvedInConversation(tool: string, conversationId: string): Promise<boolean>;
  /**
   * The owner's cards on this plugin's `tool` in a conversation or a delegation
   * from it, oldest first: what each was about (its envelope), where its
   * approval stands, and what the owner picked on it. For a tool that asks
   * once per subject — "this app, in this conversation" — and must not ask
   * again after a yes or a no. Since 1.4.
   */
  decisionsInConversation(tool: string, conversationId: string): Promise<ConversationDecision[]>;
}

/** One card, as `ApprovalsArea.decisionsInConversation` returns it. */
export interface ConversationDecision {
  /** The envelope the tool's `describe` recorded. */
  envelope: unknown;
  /** `pending`, `approved`, `rejected`, `expired`, `executing`, `succeeded`, `failed`, `refused` or `unknown`. */
  state: string;
  /** What the owner picked, by choice key, when the card declared choices and was decided. */
  choices?: Record<string, string>;
}

/** What a query or a tool asks of the host about its pages and previews. */
export interface PagesArea {
  /** The port previews are served on, or undefined when they are not. */
  previewPort(): number | undefined;
  /** `http://127.0.0.1:<port>/preview/<plugin>/<name>/`, or undefined with no preview port. */
  previewUrl(name: string): string | undefined;
}

/* ------------------------------------------------------------------ *
 * Declared
 * ------------------------------------------------------------------ */

/** One outbound request. The shape of `@buddi/runtime`'s transport, with the URL in it. */
export interface HttpRequest {
  url: string;
  /** `GET` when absent. */
  method?: string;
  headers?: Record<string, string>;
  /**
   * A secret goes into one header of this request (docs/owner-secrets.md
   * §3, `http.header`): core reads the secret by name, finds the binding that
   * names this request's host and header, applies the rule, and inserts the
   * header itself after the address checks — the value never passes through
   * the caller's hands. HTTPS only; `header` is `Authorization` when absent.
   *
   * `as: 'url'` (since 1.9): the secret *is* the address, as a calendar's
   * private ICS link is (`http.url`). `url` then names only the host the
   * caller expects (`https://calendar.google.com/`); core fetches the stored
   * address instead, once it is HTTPS on that same host and passes the
   * address rules. GET only, no body, no `header`; the binding names this
   * plugin and the host, so no other plugin can fetch it.
   *
   * `as: 'basic'` (since 1.26): the secret is a password (`http.basic`), and
   * core sends `Authorization: Basic base64(username:password)` with the
   * `username` the caller names — a CalDAV account's app-specific password.
   * HTTPS only; GET, HEAD, OPTIONS, PROPFIND, REPORT, PUT or DELETE; a body
   * of at most 256 KiB; an answer of at most 10 MB; 120 requests a minute per
   * secret. The binding names this plugin and the host (or `*.` a domain),
   * so no other plugin can sign in with it.
   *
   * `as: 'bearer'` (since 1.28): the secret is an OAuth sign-in core made
   * with `secrets.signIn` (`http.bearer`), and core sends `Authorization:
   * Bearer <access token>`, refreshing the token at the provider first when
   * it is about to expire, and once more — then sending again — when the
   * answer is 401. HTTPS only, to the host the binding names; GET, HEAD,
   * POST, PUT, PATCH or DELETE; a body of at most 256 KiB; an answer of at
   * most 10 MB; 300 requests a minute per secret. When the provider refuses
   * the refresh (revoked, expired), the request throws `SignInExpiredError`
   * (`code: 'sign-in-expired'`): the owner signs in again.
   */
  auth?: { secret: string; header?: string; as?: 'header' | 'url' | 'basic' | 'bearer'; username?: string };
  body?: string | Buffer;
  signal?: AbortSignal;
  /** How long the request may go silent. */
  idleTimeoutMs?: number;
  /** The most bytes the response may be, refused while it arrives. */
  maxBytes?: number;
}

/** The slice of a response a plugin reads. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Web requests, on the one transport every long-lived caller shares. */
export interface HttpArea {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** The owner's model accounts, as far as they bound them to this plugin. */
export interface AccountsArea {
  /** Every account, no keys. */
  list(): ProviderAccountListing[];
  /** An HTTP account's endpoint and key. Refused for an account not bound to this plugin. */
  resolve(accountId: string, model: string, signal?: AbortSignal): Promise<ResolvedProvider>;
  /**
   * Run `use` with a Codex account staged. Refused for an account not bound to this plugin.
   * @deprecated Since host API 1.8: a plugin that only needs a picture calls `generateCodexImage`.
   */
  withCodexProfile<T>(accountId: string, use: (profile: CodexProfile) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * One picture from a Codex account's ChatGPT subscription, drawn by the
   * Responses API's hosted image tool; the token never reaches the plugin.
   * Refused for an account not bound to this plugin. Since host API 1.8.
   */
  generateCodexImage(accountId: string, options: CodexImageOptions): Promise<CodexImage>;
  /** Bind an account to this plugin. Only from the owner's own call (an `ownerOnly` tool). */
  bind(accountId: string): Promise<void>;
}

/** A file in the Files library, as a plugin sees it: no path on disk. */
export interface FileRow extends Omit<ArtifactRow, 'storagePath'> {
  /** The conversation it was handed into or made in, when that conversation exists. */
  conversationId: string | null;
}

/** The Files library, scoped to what this plugin saved and what its conversation was handed. */
export interface FilesArea {
  /**
   * Save bytes into Files. The same bytes again are the file that already
   * held them: it comes back with `existed: true` and nothing new is written.
   *
   * `version` (since 1.25) names a document by its title: the host gives it
   * the next version among every file of the calling conversation —
   * `base.ext`, then `base (v2).ext`, … — counted and saved under one lock, so
   * two writes at once never share a name. `filename` is then ignored inside a
   * conversation; outside one the name is `base.ext`.
   */
  save(input: {
    bytes: Buffer;
    mime: string;
    filename?: string;
    caption?: string;
    source?: ArtifactSource;
    version?: { base: string; ext: string };
  }): Promise<FileRow & { existed?: boolean; version?: number }>;
  get(id: string): Promise<FileRow | null>;
  read(id: string): Promise<Buffer>;
  list(opts?: {
    since?: Date;
    before?: Date;
    kind?: ArtifactKind;
    /** Only files with these bytes. */
    sha256?: string;
    /** Only files handed in by this surface (`email`, `telegram`, …). */
    surface?: string;
    limit?: number;
  }): Promise<FileRow[]>;
}

/** One remembered note. */
export interface MemoryNote {
  id: string;
  text: string;
  createdAt: string;
}

/** Memory, as the calling agent and under its scope rules. A type only in 1.0. */
export interface MemoryArea {
  recall(query: string, opts?: { limit?: number }): Promise<MemoryNote[]>;
  note(text: string, opts?: { kind?: string }): Promise<{ id: string }>;
}

/** Rules this plugin proposes on the owner's inbox. */
export interface ProposalsArea {
  /** Core's `proposePolicy`, with the plugin's name and the clock filled in. */
  proposePolicy(
    ctx: Pick<ToolContext, 'agentId' | 'conversationId' | 'toolUseId' | 'provenance'> | null,
    input: Omit<ProposePolicyInput, 'plugin'>,
    /** A `db.transaction`'s handle, for a proposal that must commit with the plugin's own rows. */
    within?: DbTransaction,
    /** `announce: false` for a proposal this plugin keeps itself in the same transaction. Since 1.14. */
    opts?: { announce?: boolean },
  ): Promise<CreateProposalResult>;
  /** How many of this plugin's policy proposals are open. */
  countOpen(): Promise<number>;
  /** This plugin's open policy proposals, oldest first. Since 1.14. */
  listOpen(): Promise<Proposal[]>;
  /**
   * Keep one of this plugin's open policy proposals itself, recorded as
   * decided by `auto`, after the plugin wrote the rule (in `within`, so both
   * commit or neither). Only for what the plugin's own rule allows without
   * asking (docs/learning.md §4). Null when it is not open, not a policy, or
   * not this plugin's. Since 1.14.
   */
  keepItself(id: string, within?: DbTransaction): Promise<Proposal | null>;
  /** The owner's track record with this plugin's policies of one kind. Since 1.14. */
  trackRecord(kind: string): Promise<TrackRecord>;
  /**
   * The owner took back a kept policy of this plugin's (an Undo on its page):
   * the proposal becomes the owner's discard as of now, so the same rule is
   * not proposed again for 90 days and the kind's track record starts over.
   * Since 1.14.
   */
  takeBack(id: string, opts?: { reason?: string; within?: DbTransaction }): Promise<Proposal | null>;
}

/** A run to start, as a source hands it over. */
export interface EnqueueRunInput {
  agentId: string;
  prompt: string;
  dedupKey: string;
  conversationHint?: string;
}

/** Work that starts by itself, and the reminders already promised. */
export interface ScheduleArea {
  /** Start an agent run. Idempotent on `dedupKey`. */
  enqueueRun(input: EnqueueRunInput): Promise<void>;
  /** Which (value, day) pairs already have a pending reminder whose context names the value. */
  remindersFor(
    key: { contextKey: string; values: string[] },
    days: string[],
  ): Promise<Array<{ value: string; day: string }>>;
}

/* ------------------------------------------------------------------ *
 * Secrets (docs/owner-secrets.md §2, §3)
 * ------------------------------------------------------------------ */

/**
 * How often the owner is asked before a bound secret goes to its target,
 * strictest first. A destination states the loosest it allows (`maxRule`); a
 * use runs under the stricter of that and the binding's own.
 */
export type SecretRule = 'every-time' | 'first-time' | 'pre-approved';

/** Where one of the owner's secrets may go: a destination kind, a target in it, and the rule. */
export interface SecretBinding {
  /** A destination kind, e.g. `email.account`. */
  kind: string;
  /** The exact place within that kind, as the destination checks it. Plain JSON. */
  target: unknown;
  rule: SecretRule;
}

/** A secret's name and bindings, and when it was last used. Never its value. */
export interface SecretListing {
  name: string;
  totp: boolean;
  bindings: Array<SecretBinding & {
    /** When the owner approved the first use under a `first-time` rule. */
    firstApprovedAt: string | null;
    /**
     * True for an account kind (`<plugin>.account`): the plugin's process holds
     * the value for as long as its connection lives — the one stated exception
     * to "never held" (owner-secrets §4).
     */
    heldByPlugin: boolean;
  }>;
  /** The last use, whatever came of it; null when it was never used. */
  lastUse: {
    at: string;
    kind: string;
    target: unknown;
    agentId: string | null;
    outcome: SecretUseOutcome;
  } | null;
}

/** What became of one use, as `core.secret_uses` records it. */
export type SecretUseOutcome = 'delivered' | 'held' | 'pending' | 'refused' | 'failed';

/** What a destination's own code is handed besides the value. */
export interface SecretDeliveryContext {
  /** This use's id: `SecretsArea.use` answers with the same one. */
  use: string;
  /** The host of the plugin that registered the destination. */
  buddi: BuddiHost;
}

/**
 * A place a secret can be delivered, registered by the plugin that owns it
 * (owner-secrets §3). `deliver` is the only code that ever receives a value,
 * and only for a binding that names its own kind.
 */
export interface SecretDestination {
  /** `<plugin>.<what>`, in the registering plugin's own namespace. */
  kind: string;
  /**
   * Whether the target a use asks for is the one the binding names, checked
   * against the live world where that means something (the account exists,
   * the frame's origin is the bound one). Never the caller's claim.
   */
  checkTarget(target: unknown, bound: unknown, buddi: BuddiHost): boolean | Promise<boolean>;
  /** One line for the approval card and the Settings row: where this target is. */
  describe(target: unknown): string;
  /** Put the value where it goes. Keep it no longer than the use needs. */
  deliver(value: string, target: unknown, ctx: SecretDeliveryContext): void | Promise<void>;
  /** The loosest rule this kind allows. */
  maxRule: SecretRule;
}

/** What asking for a use came to. Never a value. */
export type SecretUseResult =
  | { done: true; use: string }
  | { pending: string }
  | { refused: string };

/**
 * The owner's secrets, used and never read (docs/owner-secrets.md).
 * There is no `get`: a value reaches a plugin only through one of its own
 * destinations' `deliver`.
 */
export interface SecretsArea {
  /** Register one of this plugin's destinations. The kind must start with `<plugin>.`. */
  registerDestination(destination: SecretDestination): void;
  /**
   * Deliver the secret `name` into `target` of this plugin's destination
   * `kind`. Core finds the binding, has the destination check the target,
   * applies the rule, reads the vault and calls `deliver`. `pending` is the
   * approval the owner was asked; ask again once it is decided.
   */
  use(name: string, kind: string, target: unknown): Promise<SecretUseResult>;
  /** Secrets with a binding to one of this plugin's kinds: names, bindings, last use. */
  list(): Promise<SecretListing[]>;
  /**
   * Store a secret the owner typed, with its bindings, which must name this
   * plugin's own kinds; replaces the value of one this plugin already holds.
   * Only from the owner's own call (an `ownerOnly` tool).
   */
  put(name: string, value: string, bindings: SecretBinding[]): Promise<void>;
  /** Owner only. Rename a secret bound only to this plugin's kinds. */
  rename(name: string, to: string): Promise<boolean>;
  /** Owner only. Replace a secret's bindings (this plugin's kinds only). */
  rebind(name: string, bindings: SecretBinding[]): Promise<boolean>;
  /** Owner only. Delete a secret bound only to this plugin's kinds, value and all. */
  delete(name: string): Promise<boolean>;
  /**
   * Owner only (1.28; with `http` declared). Start an OAuth sign-in to one of
   * core's providers (`OAUTH_PROVIDERS`): PKCE and a state, core listening on
   * a loopback port for the provider's answer. The tokens never reach the
   * plugin: core keeps them as the owner secret `secret`, bound to
   * `http.bearer` for this plugin and `host`, and sends them with `auth: {
   * secret, as: 'bearer' }`. Signing in again under the same secret replaces
   * the tokens and keeps the name. Absent on an older buddi.
   */
  signIn?(req: OAuthSignInRequest): Promise<OAuthSignInStart>;
  /** Where one of this plugin's sign-ins stands; `expired` once it is gone. */
  signInStatus?(id: string): Promise<OAuthSignInStatus>;
  /**
   * Owner only. Finish a sign-in with what the owner pasted: the address the
   * provider sent the browser to (when that browser is on another computer,
   * the loopback page does not load) or the code alone.
   */
  signInFinish?(id: string, pasted: string): Promise<OAuthSignInStatus>;
  /** Owner only. Drop a sign-in that is still waiting. */
  signInCancel?(id: string): Promise<void>;
}

/**
 * How core runs a plugin's OAuth sign-in and keeps its tokens fresh: the
 * loopback listener, PKCE, the code exchange and the refresh. Built by the
 * composition root over `@buddi/runtime`'s OAuth pieces (core may not import
 * the runtime) and handed in with `configurePluginHost({ signIns })`. Never a
 * plugin's surface: the `secrets` area scopes every call to its plugin, and
 * `save` is core writing the owner secret.
 */
export interface PluginSignInService {
  begin(input: {
    plugin: string;
    provider: OAuthProvider;
    clientId: string;
    clientSecret?: string;
    scopes: readonly string[];
    /** Keep the envelope (JSON): core writes it as the owner secret. */
    save(envelope: string): Promise<void>;
  }): Promise<{ id: string; authorizeUrl: string; redirectUri: string; expiresAt: number }>;
  status(plugin: string, id: string): OAuthSignInStatus | undefined;
  finish(plugin: string, id: string, pasted: string): Promise<OAuthSignInStatus>;
  cancel(plugin: string, id: string): void;
  /**
   * The access token under vault entry `ref`, refreshed first when it expires
   * within five minutes, or when `rejected` is the token stored (a 401
   * answered it). Throws `SignInExpiredError` when the provider refuses the
   * refresh. `refreshed` says the entry changed (the scrubber rebuilds).
   */
  fresh(
    vault: Pick<Vault, 'get' | 'set'>,
    ref: string,
    secret: string,
    opts?: { rejected?: string },
  ): Promise<{ accessToken: string; refreshed: boolean }>;
}

/* ------------------------------------------------------------------ *
 * Channels (docs/notifications.md)
 * ------------------------------------------------------------------ */

/**
 * A way to reach the owner that this plugin carries: its mail account, a
 * chat of its own. Declared as `owner:channel`. The owner picks it in
 * Settings → Notifications like any channel; a plugin never picks where a
 * message goes, only what carrying one means.
 */
export interface ChannelsArea {
  /**
   * Add one of this plugin's channels, kind `<plugin>.<what>`. Registering the
   * same kind again replaces it; the returned function removes it. A plugin's
   * channel is never the default over Telegram or this machine's.
   */
  register(channel: PluginChannel): () => void;
}

/** A plugin's channel. Both calls are handed this plugin's host. */
export interface PluginChannel {
  /** `<plugin>.<what>`, like `email.self`. */
  kind: string;
  /**
   * What Settings shows: a label and where it goes. Null when there is
   * nothing to carry a message now (no account): the channel is then neither
   * listed nor picked.
   */
  describe(buddi: BuddiHost): Promise<{ label: string; where?: string } | null>;
  can: { offers: boolean; attachments: boolean; markdown: boolean };
  /** Carry one message. `{ refused }` says why it did not; the sentence is kept on the message. */
  deliver(message: PluginChannelMessage, buddi: BuddiHost): Promise<{ id: string } | { refused: string }>;
}

/** What a plugin's channel is handed: the message as stored, never an approval's id or an offer's prompt. */
export interface PluginChannelMessage {
  /** The notification's id; `today:<date>` for the end-of-day message; `test:<ms>` for "Send a test". */
  id: string;
  kind: string;
  urgency: 'now' | 'today' | 'digest';
  title: string;
  text?: string;
  /** A dashboard route, and its full URL when the dashboard has a public origin. */
  link?: { route: string; url?: string };
  /** The offers' labels, for a channel that can only list them. */
  offers?: { label: string }[];
}
