/**
 * `ctx.buddi`: the one surface a plugin reaches core through
 * (docs/specs/plugin-host-api.md).
 *
 * The rest of a context is the *call* — who called, in which conversation,
 * under which approval. This is the *host*: everything a plugin reaches beyond
 * its own arguments, in areas. Six are always present because they reach
 * nothing beyond the plugin itself; the rest exist only when the manifest
 * declares them in `uses`, and the owner read that list on the install card.
 *
 * Every method is async or plain, and takes and returns plain data, so that a
 * later move of plugins out of this process can put an RPC surface here
 * without a plugin noticing (§6). Types only: this file is part of
 * `@buddi/core/plugin`.
 */
import type { ToolPermission } from '../actions/permissions.js';
import type { ArtifactKind, ArtifactRow, ArtifactSource } from '../artifacts/store.js';
import type { ProposePolicyInput } from '../learning/policies.js';
import type { CreateProposalResult } from '../learning/store.js';
import type { ResolvedProvider } from '../provider.js';
import type { CodexProfile, ProviderAccountListing } from '../provider-accounts.js';
import type { ToolContext } from '../tools.js';

/** The host, bound to one plugin. See the file comment. */
export interface BuddiHost {
  /** `major.minor`, `HOST_API_VERSION`. A plugin asks for it as `buddi.hostApi`. */
  readonly version: string;
  /** This plugin's name: the manifest's `name`. */
  readonly plugin: string;
  /** An operational log line, prefixed with the plugin's name. Never the owner's channel. */
  log(line: string): void;
  owner: OwnerArea;
  clock: ClockArea;
  db: DbArea;
  dir: DirArea;
  approvals: ApprovalsArea;
  pages: PagesArea;
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
  /** Directories no plugin may write into, whatever it was granted. */
  readonly protectedPaths: readonly string[];
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
export type RegisterHost = Pick<BuddiHost, 'version' | 'plugin' | 'dir'>;

/** The owner's decisions about this plugin's own tools. */
export interface ApprovalsArea {
  /** Throw unless `envelope` is the effect the owner approved on this call. */
  assert(ctx: ToolContext, envelope: unknown): void;
  /** The standing permission that answers for one of this plugin's tools on this call, or null. */
  standing(tool: string): Promise<ToolPermission | null>;
  /** Whether the owner approved this plugin's `tool` in a conversation or a delegation from it. */
  approvedInConversation(tool: string, conversationId: string): Promise<boolean>;
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
  /** Run `use` with a Codex account staged. Refused for an account not bound to this plugin. */
  withCodexProfile<T>(accountId: string, use: (profile: CodexProfile) => Promise<T>, signal?: AbortSignal): Promise<T>;
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
  save(input: { bytes: Buffer; mime: string; filename?: string; caption?: string; source?: ArtifactSource }): Promise<FileRow>;
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
  ): Promise<CreateProposalResult>;
  /** How many of this plugin's policy proposals are open. */
  countOpen(): Promise<number>;
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
 * Secrets (docs/specs/owner-secrets.md §2, §3)
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
 * The owner's secrets, used and never read (docs/specs/owner-secrets.md).
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
}
