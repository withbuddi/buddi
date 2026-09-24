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
  /** Declared as `secrets`. A type only in 1.0: never present yet. */
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
}

/** What a transaction's callback is handed: statements on one connection. */
export interface DbTransaction {
  query<R = Record<string, any>>(sql: string, params?: unknown[]): Promise<DbResult<R>>;
}

/** The database, never a raw pool: a plugin cannot `connect()` and change role. */
export interface DbArea {
  query<R = Record<string, any>>(sql: string, params?: unknown[]): Promise<DbResult<R>>;
  /** One connection, `begin`, the plugin's schema first on `search_path`, then commit or rollback. */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T>;
}

/** A directory of the plugin's own: `<data>/plugins-data/<plugin>`. */
export interface DirArea {
  /** Absolute, created on first read. Never the data directory itself. */
  readonly path: string;
}

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
export type FileRow = Omit<ArtifactRow, 'storagePath'>;

/** The Files library, scoped to what this plugin saved and what its conversation was handed. */
export interface FilesArea {
  save(input: { bytes: Buffer; mime: string; filename?: string; source?: ArtifactSource }): Promise<FileRow>;
  get(id: string): Promise<FileRow | null>;
  read(id: string): Promise<Buffer>;
  list(opts?: { since?: Date; before?: Date; kind?: ArtifactKind; limit?: number }): Promise<FileRow[]>;
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
  proposePolicy(ctx: ToolContext, input: Omit<ProposePolicyInput, 'plugin'>): Promise<CreateProposalResult>;
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

/** Where one of the owner's secrets is bound: a destination of this plugin's, and its target. */
export interface SecretBinding {
  destination: string;
  target: unknown;
}

/** A secret's name and bindings. Never its value. */
export interface SecretListing {
  name: string;
  bindings: SecretBinding[];
}

/** The owner's secrets, used and never read. A type only in 1.0; built in step 3. */
export interface SecretsArea {
  use(
    ctx: ToolContext,
    req: { name: string; destination: string; target: unknown },
  ): Promise<{ done: true } | { pending: string } | { refused: string }>;
  list(): Promise<SecretListing[]>;
  store(name: string, value: string, binding: SecretBinding): Promise<void>;
  remove(name: string): Promise<boolean>;
}
