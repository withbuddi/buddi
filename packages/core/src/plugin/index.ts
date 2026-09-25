/**
 * `@buddi/core/plugin`: what a plugin imports from core
 * (docs/plugin-host-api.md §3).
 *
 * The contract's types, and the pure helpers a plugin needs beside `ctx.buddi`
 * — a date in the owner's zone, a hash, a page's file answer, a URL check.
 * Nothing here has state or does I/O, and `plugin-entry.test.ts` holds it to
 * that by walking what this module imports. Everything a plugin *reaches* is
 * on `ctx.buddi`, not here.
 */

/* Values: pure. */
export { localDateString } from '../time.js';
export { sha256Of } from './hash.js';
export { QueryRefusal, pageFile, isPageFile } from './page-file.js';
export { parseViewDescriptors } from '../views.js';
export {
  ALLOWED_PORTS,
  ALLOWED_SCHEMES,
  BlockedError,
  DEFAULT_POLICY,
  blockedAddress,
  blockedV4,
  blockedV6,
  checkUrl,
  isBlockedHostname,
} from './url.js';
export { AGENT_ONLY_FIELD, ToolRefusal, isToolRefusal } from '../tools.js';
export { HOST_API_VERSION, hostApiProblem } from './version.js';
export { NATIVE_BACKEND_ID, SEARCH_BACKEND_VAR, parseSearchBackend } from './search.js';
export {
  PLUGIN_USES,
  PLUGIN_USE_WORDS,
  isPluginUse,
  parsePluginUses,
  pluginUsesChange,
  pluginUsesMismatch,
} from './uses.js';

/* Types. */
export type { AddressPolicy, BlockReason, CheckedUrl } from './url.js';
export type { PageFile } from './page-file.js';
export type { PluginUse } from './uses.js';
export type { NativeSearchEvent, NativeSearchRecord, SearchBackendChoice } from './search.js';
export type {
  EffectDescription,
  GroupContext,
  NetworkUse,
  OwnerChoice,
  PluginManifest,
  PreviewProvider,
  Source,
  SourceContext,
  SuggestedAgent,
  SuggestedMission,
  SuggestedSkill,
  Tier,
  ToolContext,
  ToolDefinition,
} from '../tools.js';
export type {
  Finding,
  Sentinel,
  SentinelContext,
  SentinelReport,
  SentinelResult,
  Severity,
} from '../sentinels/types.js';
export type { ViewDescriptor, ViewMap, RendererName } from '../views.js';
export type {
  Component,
  Field,
  OptionsFrom,
  PageDescriptor,
  PageIcon,
  PageQuery,
  QueryRef,
  WorkspaceFiles,
} from '../pages.js';
export type { HomeBlock, HomeContribution, HomeRow, HomeStat } from '../home.js';
export type { MetricDefinition, MetricDirection, MetricReading, MetricUnit } from '../metrics.js';
export type {
  PolicyApplyResult,
  PolicyHandler,
  PolicyHandlerContext,
  Proposal,
  RunProvenance,
  UntrustedKind,
  UntrustedSource,
} from '../learning/types.js';
export type { ProposePolicyInput } from '../learning/policies.js';
export type { CreateProposalResult } from '../learning/store.js';
export type { CodexProfile, ProviderAccountListing, ProviderAccountsAccess } from '../provider-accounts.js';
export type { ResolvedProvider } from '../provider.js';
export type { SurfaceProfile } from '../surfaces.js';
export type { ArtifactKind, ArtifactSource } from '../artifacts/store.js';
export type { ToolPermission } from '../actions/permissions.js';
export type { MisfirePolicy } from '../scheduler/types.js';
export type {
  AccountsArea,
  ApprovalsArea,
  BuddiHost,
  ClockArea,
  DbArea,
  DbResult,
  DbTransaction,
  DirArea,
  EnqueueRunInput,
  FileRow,
  FilesArea,
  HttpArea,
  HttpRequest,
  HttpResponse,
  MemoryArea,
  MemoryNote,
  OwnerArea,
  PagesArea,
  ProposalsArea,
  RegisterHost,
  ScheduleArea,
  SecretBinding,
  SecretDeliveryContext,
  SecretDestination,
  SecretListing,
  SecretRule,
  SecretUseOutcome,
  SecretUseResult,
  SecretsArea,
} from '../host/types.js';
