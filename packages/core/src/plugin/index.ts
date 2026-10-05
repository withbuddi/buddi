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
export { validDayMonth, daysUntil, isOnDay, turning, dayMonthText, yearlyCron, daysBefore, occurrenceIn, MONTH_NAMES } from '../day-month.js';
export type { DayMonth } from '../day-month.js';
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
export { AGENT_ONLY_FIELD, REPORT_MAX_DEFAULT, REPORT_MAX_LIMIT, ToolRefusal, isToolRefusal } from '../tools.js';
export { HOST_API_VERSION, hostApiProblem } from './version.js';
export { PROVIDED_ROUTE_KINDS, routeProviderProblem } from '../routes.js';
export type { ProvidedRouteKind, RegisteredRouteProvider, RouteCommand, RouteHealth, RoutePage, RouteProvider, RouteReach, RouteTarget } from '../routes.js';
export { OAUTH_PROVIDERS, SignInExpiredError, isSignInExpired, oauthHostCovered } from './sign-in.js';
export type { OAuthProvider, OAuthSignInRequest, OAuthSignInStart, OAuthSignInStatus } from './sign-in.js';
export { NATIVE_BACKEND_ID, SEARCH_BACKEND_VAR, parseSearchBackend } from './search.js';
export { AUTHOR_NAME_MAX, authorOfPackageJson, parsePluginAuthor, pluginAuthorMismatch } from './author.js';
export {
  ASSET_INPUT_MAX,
  ASSET_INPUT_TYPES,
  ASSET_KEY,
  ASSET_QUOTA_BYTES,
  ASSET_ROUTE,
  ASSET_SIZES,
  AssetRefusal,
  assetInputProblem,
  assetPath,
  isAssetKey,
} from './assets.js';
export type { AssetImageCodec, AssetSize, PluginAsset } from './assets.js';
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
export type { PluginExport, PluginReadiness, PluginSetup } from './requires.js';
export { PluginCallRefusal } from './requires.js';
export type { PluginAuthor } from './author.js';
export type { NativeSearchEvent, NativeSearchRecord, SearchBackendChoice } from './search.js';
export type {
  CarryOverContributor,
  CarryOverRequest,
  EffectDescription,
  GroupContext,
  MissionContext,
  NetworkUse,
  OwnerChoice,
  PluginManifest,
  PreviewProvider,
  Source,
  SourceContext,
  SourceWatch,
  SuggestedAgent,
  SuggestedAgentMission,
  SuggestedMission,
  SuggestedSkill,
  Tier,
  ToolContext,
  ToolDefinition,
  ZodToolDefinition,
  JsonSchemaToolDefinition,
} from '../tools.js';
export type { JSONSchema7 } from '../json-schema.js';
export type { IdleRollover } from '../agents/idle-rollover.js';
export type {
  Finding,
  FindingAction,
  Sentinel,
  SentinelContext,
  SentinelReport,
  SentinelResult,
  Severity,
} from '../sentinels/types.js';
export type { ViewDescriptor, ViewMap, RendererName, TilesMap, TileIcon, TileLink } from '../views.js';
export { TILE_ICONS } from '../views.js';
export type {
  CalendarMap,
  ChartSeries,
  Component,
  Field,
  FieldAction,
  ImageList,
  ImageRef,
  ListItem,
  OptionsFrom,
  RouteRef,
  PageDescriptor,
  PagePlay,
  PageIcon,
  PageQuery,
  PageTab,
  QueryRef,
  RowAction,
  RowActionForm,
  SeriesPanelSeries,
  SeriesPanelTiles,
  TabsPick,
  TilesLayout,
  WorkspaceFiles,
} from '../pages.js';
export type { HomeBlock, HomeBlockContribution, HomeContribution, HomeGlance, HomeGlanceCard, HomeGlanceContribution, HomeRow, HomeStat } from '../home.js';
export { HOME_CARD_LINE_MAX, HOME_CARD_TREND_MAX, HOME_CARD_VALUE_MAX, HOME_GLANCE_MAX } from '../home.js';
export type { MetricDefinition, MetricDirection, MetricReading, MetricUnit } from '../metrics.js';
export type {
  WidgetBody,
  WidgetBodyKind,
  WidgetDefinition,
  WidgetList,
  WidgetListRow,
  WidgetProgress,
  WidgetRequest,
  WidgetSize,
  WidgetStat,
  WidgetStrip,
  WidgetStripItem,
  WidgetText,
  WidgetSurface,
} from '../widgets.js';
export type {
  WidgetMultiselectField,
  WidgetPlace,
  WidgetPlaceField,
  WidgetSelectField,
  WidgetSettingField,
  WidgetSettingKind,
  WidgetSettingOption,
  WidgetSettingOptions,
  WidgetSettings,
  WidgetTextField,
  WidgetTimeFormatField,
  WidgetToggleField,
} from '../widget-settings.js';
export { WIDGET_OPTIONS_MAX, WIDGET_PLACES_MAX, WIDGET_SETTING_KINDS, WIDGET_SETTINGS_MAX } from '../widget-settings.js';
export { WIDGET_BODY_KINDS, WIDGET_ITEMS_MAX, WIDGET_LINE_MAX, WIDGET_ROWS_MAX, WIDGET_SIZES, WIDGET_TEXT_MAX, WIDGET_TITLE_MAX, WIDGET_TREND_MAX, WIDGET_VALUE_MAX } from '../widgets.js';
export type {
  PolicyApplyResult,
  PolicyHandler,
  PolicyHandlerContext,
  Proposal,
  ProposalDecider,
  RunProvenance,
  UntrustedKind,
  UntrustedSource,
} from '../learning/types.js';
export type { ProposePolicyInput } from '../learning/policies.js';
export type { CreateProposalResult, TrackRecord } from '../learning/store.js';
export type { AccountCapabilities, CodexImage, CodexImageOptions, CodexProfile, ProviderAccountListing, ProviderAccountsAccess } from '../provider-accounts.js';
export type { ResolvedProvider } from '../provider.js';
export type { SurfaceProfile } from '../surfaces.js';
export type { ArtifactKind, ArtifactSource } from '../artifacts/store.js';
export type { ToolPermission } from '../actions/permissions.js';
export type { MisfirePolicy } from '../scheduler/types.js';
export type {
  AccountsArea,
  ApprovalsArea,
  AssetsArea,
  ConversationDecision,
  BuddiHost,
  ChannelsArea,
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
  PluginChannel,
  PluginChannelMessage,
  PluginOwnerMessage,
  PagesArea,
  PluginsArea,
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
  ToolsArea,
  NetworkArea,
} from '../host/types.js';
export type { OwnerPlace } from '../places.js';

// Widget declarations are checked the way the host checks them; plugin tests use this.
export { parseWidgets } from '../widgets.js';
