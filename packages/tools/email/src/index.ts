/**
 * `@buddi/tool-email` — the first plugin to prove *both* contracts at once.
 *
 * An IMAP **source** originates work with no agent in the loop (mail arrives ->
 * a triage run), and an SMTP **effect tool** is agent-proposed and owner-gated
 * (`email.send`). Everything else in the family — listing, reading, searching,
 * recording a triage decision, writing a draft — is a read or a write over this
 * plugin's own schema, so it sits at tier `auto`.
 *
 * The plugin owns the `email` Postgres schema and ships its own migrations.
 * Core never references these tables; deleting this directory leaves core
 * booting, with one schema and one registry entry to drop.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginManifest, Source, Vault } from '@buddi/core';
import { imapflowFactory } from './imap/imapflow-client.js';
import { smtpFactory } from './smtp/nodemailer-client.js';
import { emailMetrics } from './metrics.js';
import { emailSentinels } from './sentinels/index.js';
import { createInboxPollSource } from './sources/inbox-poll.js';
import { createRetentionSource } from './sources/retention.js';
import { draftNew, draftReply, readDraft } from './tools/drafts.js';
// --- email step 6b: search and attachments ---
import { createFetchAttachmentTool } from './tools/attachments.js';
// --- end step 6b ---
import { listRecent, readMessage, search } from './tools/read.js';
import { senderProfile } from './tools/sender.js';
import { listThreads, muteThread, readThread } from './tools/threads.js';
import { createSendTool } from './tools/send.js';
import { listPolicies, revokeEmailPolicy, setPolicy } from './tools/policies.js';
import { getSettings, setSettings } from './tools/settings.js';
import { triageRecord } from './tools/triage.js';
import { emailPages, emailPageTools, emailQueries } from './pages/index.js';
import type { EnvLike } from './config.js';
import type { ImapClientFactory, SmtpClientFactory } from './ports.js';

/** Absolute path to this plugin's migrations, resolved from the built file. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export interface EmailPluginOptions {
  /** How IMAP clients are made. Defaults to the real `imapflow` adapter. */
  connect?: ImapClientFactory;
  /** How SMTP clients are made. Defaults to the real `nodemailer` adapter. */
  send?: SmtpClientFactory;
  /**
   * Where named secrets are read from. Defaults to `process.env`, read lazily
   * at poll/send time — never at import, and never by the adapters themselves.
   */
  env?: EnvLike;
  /**
   * Where a mailbox's password is kept. Defaults to this machine's vault,
   * resolved lazily inside `email.add_account` — never at import. Injected by
   * a test, so adding an account never touches the owner's keychain.
   */
  vault?: Vault;
}

/**
 * The sources this plugin ships.
 *
 * `PluginManifest.sources` is where the gateway reads them from; this export is
 * the convenience for a caller that wants to drive one poll itself (a test, a
 * one-shot CLI) without going through a manifest.
 */
export function createEmailSources(opts: EmailPluginOptions = {}): Source[] {
  return [
    createInboxPollSource({
      connect: opts.connect ?? imapflowFactory,
      ...(opts.env ? { env: opts.env } : {}),
    }),
    // Housekeeping, not ingest: it originates no run and wakes nobody. It
    // rides the source contract only for the period ledger — see
    // `sources/retention.ts`.
    createRetentionSource(),
  ];
}

export function createEmailManifest(
  opts: EmailPluginOptions = {},
): PluginManifest {
  return {
    name: 'email',
    version: '0.1.0',
    schema: 'email',
    migrationsDir: MIGRATIONS_DIR,
    tools: [
      listRecent,
      readMessage,
      search,
      senderProfile,
      listThreads,
      readThread,
      muteThread,
      triageRecord,
      draftReply,
      draftNew,
      readDraft,
      getSettings,
      setSettings,
      listPolicies,
      setPolicy,
      revokeEmailPolicy,
      createSendTool({
        send: opts.send ?? smtpFactory,
        ...(opts.env ? { env: opts.env } : {}),
      }),
      // --- email step 6b: attachments on request (docs/specs/email.md §10).
      // It talks to IMAP, so it takes the same client factory the source does.
      createFetchAttachmentTool({
        connect: opts.connect ?? imapflowFactory,
        ...(opts.env ? { env: opts.env } : {}),
      }),
      // --- end step 6b ---
      /*
       * What the owner's own screens write through (docs/specs/plugin-pages.md).
       * Every one of them is `ownerOnly`: the registry never lists them to a
       * model, and `invoke` refuses them for anyone but the owner's own path.
       */
      ...emailPageTools({
        connect: opts.connect ?? imapflowFactory,
        ...(opts.vault ? { vault: opts.vault } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      }),
    ],
    // The Mail place and the Email settings tab, and the reads they make.
    pages: emailPages(),
    queries: emailQueries(),
    sources: createEmailSources(opts),
    // The number a goal can watch: what is waiting on the owner. Read-only,
    // and measured on core's schedule (`metrics.ts`, which says why an unread
    // count is not here yet).
    metrics: emailMetrics,
    // The watchers (docs/specs/email.md §7). All six of them, as of step 6:
    // they read this plugin's own schema, decide nothing, and speak to nobody.
    sentinels: emailSentinels,
  };
}

/** The installed manifest: real transports, secrets read from `process.env`. */
export const manifest: PluginManifest = createEmailManifest();

/** The installed sources, for a gateway that wires `poll()` itself. */
export const emailSources: Source[] = manifest.sources ?? [];

export default manifest;

export { emailMetrics, stalestSync, waitingOnMe as waitingOnMeMetric } from './metrics.js';
export { listRecent, readMessage, search } from './tools/read.js';
// --- email step 6b: search and attachments ---
export {
  booleanFilter,
  bounded,
  buildSearch,
  isCalendarDate,
  likeNeedle,
  narrows,
  qualify,
  searchColumns,
  toSearchRow,
  validateFilters,
  windowNote,
  DATE_PATTERN,
  DEFAULT_WINDOW_DAYS,
  MIN_QUERY_CHARS,
  WHEN,
  type BuiltSearch,
  type SearchFilters,
  type SearchOptions,
  type SearchRow,
} from './search.js';
export {
  createFetchAttachmentTool,
  markFetched,
  pickAttachment,
  resolveAgainstFresh,
  MAX_ATTACHMENT_BYTES,
  type FetchAttachmentInput,
  type FetchAttachmentOptions,
  type FetchAttachmentResult,
} from './tools/attachments.js';
export {
  bareMime,
  bytesRefusal,
  declaredRefusal,
  extensionOf,
  inspectZip,
  isPartId,
  looksLikeZip,
  mimeToStore,
  safeFilename,
  sniffMime,
  zipEntryNames,
  type ZipInspection,
  MAX_FILENAME,
  PART_PATTERN,
  REFUSED_EXTENSIONS,
  REFUSED_MIMES,
} from './attachments/safety.js';
// --- end step 6b ---
export { senderProfile } from './tools/sender.js';
export {
  listThreads,
  muteThread,
  readThread,
  renderMutePreview,
  threadView,
  DEFAULT_THREAD_MESSAGES,
  STATE_WORDS,
  type MuteEnvelope,
} from './tools/threads.js';
export {
  findThread,
  joinThread,
  listThreadRows,
  participantsOverflowOf,
  participantsTotalOf,
  participantsTotals,
  setThreadState,
  threadKeyOf,
  threadMessages,
  threadOfMessage,
  toThread,
  THREAD_COLUMNS,
  THREAD_STATES,
  type JoinThreadInput,
  type ListThreadsFilter,
  type ThreadMessage,
  type ThreadRecord,
  type ThreadState,
} from './threads.js';
export {
  leafOf,
  planFolders,
  sentConfidence,
  sentFolderOf,
  isInbox,
  FOLDER_KINDS,
  GMAIL_SENT,
  type FolderKind,
  type FolderPlan,
} from './folders.js';
export * from './drafts.js';
export { triageRecord } from './tools/triage.js';
export { getSettings, setSettings } from './tools/settings.js';
export {
  listPolicies,
  policiesView,
  policyLists,
  threadChoices,
  renderPolicyPreview,
  revokeEmailPolicy,
  setPolicy,
  viewOf,
  THREAD_CHOICES,
  type PolicyEnvelope,
  type PolicyView,
  type ThreadChoice,
} from './tools/policies.js';
export {
  applyPolicies,
  describeDecision,
  domainOf,
  isLive,
  isUnimplementedAction,
  matches,
  POLICY_ACTIONS,
  POLICY_ORIGINS,
  POLICY_SCOPES,
  UNIMPLEMENTED_ACTIONS,
  type GateDecision,
  type MessageHeader,
  type PolicyAction,
  type PolicyOrigin,
  type PolicyParams,
  type PolicyRecord,
  type PolicyScope,
} from './policies/gate.js';
export {
  bulkPolicies,
  createPolicy,
  findPolicy,
  keepPolicy,
  loadPolicies,
  normalizeMatcher,
  policyForSender,
  policyStats,
  recordEvent,
  refusalFor,
  revokePolicy,
  seedLearnedIgnorePolicies,
  toEvent,
  toPolicy,
  PolicyRefusal,
  POLICY_COLUMNS,
  type BulkPolicyResult,
  type CreatePolicyInput,
  type GateEvent,
} from './policies/store.js';
export {
  CONSISTENT_VERDICTS,
  learnedProposal,
  learnFromVerdict,
  ownerHasRepliedTo,
  ownerReplies,
  REPLY_SAMPLE,
  senderVerdicts,
  type OwnerReplies,
  type Proposal,
  type Verdict,
} from './policies/learn.js';
export {
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  PURGE_BATCH,
  RETENTION_DAYS_KEY,
  loadSettings,
  purgeBodies,
  purgeLogLine,
  purgedBodyNote,
  setRetentionDays,
  type EmailSettings,
  type PurgeOutcome,
} from './retention.js';
export {
  createRetentionSource,
  RETENTION_EVERY_SECONDS,
  RETENTION_SOURCE_ID,
} from './sources/retention.js';
export { draftNew, draftReply, readDraft, draftView, ownerEditedNote, type DraftView } from './tools/drafts.js';
export {
  buildEnvelope,
  createSendTool,
  renderPreview,
  sha256,
  SEND_TIMEOUT_MS,
  SEND_TOOL_VERSION,
  type ReplyAudienceSummary,
  type SendEnvelope,
  type SendInput,
  type SendResult,
} from './tools/send.js';
export {
  createInboxPollSource,
  triageDedupKey,
  withDeadline,
  ImapTimeoutError,
  BACKFILL_VAR,
  DEFAULT_BACKFILL,
  DEFAULT_POLL_TIMEOUT_MS,
  MAX_PER_POLL,
  POLL_EVERY_SECONDS,
  POLL_TIMEOUT_VAR,
  TRIAGE_AGENT_ID,
} from './sources/inbox-poll.js';
export {
  ACCOUNT_SECRET_PREFIX,
  ensureGmailAccount,
  findAccount,
  lastSyncByAccount,
  listAccounts,
  resolveAuth,
  secretNameFor,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SECRET_NAME,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GMAIL_USER_VAR,
  INBOX,
  type EnvLike,
} from './config.js';
export {
  createDateStatedSentinel,
  createWaitingOnMeSentinel,
  dateStated,
  emailSentinels,
  mailAgent,
  waitingOnMe,
  EVERY_12H,
  EVERY_HOUR,
  MAX_DATE_FINDINGS,
  MAX_WAITING_FINDINGS,
} from './sentinels/index.js';
export {
  clampConfidence,
  findDates,
  isConfident,
  sentencesOf,
  withoutQuotedLines,
  BASE_CONFIDENCE,
  DATE_WINDOW_DAYS,
  DEFAULT_DATE_CONFIDENCE,
  KEYWORD_BOOST,
  MAX_CONFIDENCE,
  MAX_DATE_CONFIDENCE,
  MIN_DATE_CONFIDENCE,
  type DateHit,
  type FindDatesOptions,
} from './dates.js';
export {
  recordDates,
  remindersFor,
  scanMessageDates,
  skipDates,
  statedDatesBetween,
  unscannedMessages,
  DATE_SCAN_BATCH,
  type ScannableMessage,
} from './dates-store.js';
export {
  clampWaitingDays,
  dateFinding,
  dateKey,
  firstLineOf,
  loadWatcherSettings,
  setWatcherSettings,
  severityForAge,
  waitingFinding,
  waitingKey,
  DATE_CONFIDENCE_KEY,
  DEFAULT_WAITING_DAYS,
  DEFAULT_WATCHER_SETTINGS,
  DETAIL_CHARS,
  MAX_WAITING_DAYS,
  MIN_WAITING_DAYS,
  WAITING_DAYS_KEY,
  WARNING_WAITING_DAYS,
  type DateFinding,
  type StatedDate,
  type WaitingFinding,
  type WaitingThread,
  type WatcherSettings,
} from './watchers.js';
export {
  emailPages,
  emailPageTools,
  emailQueries,
  addressesOf,
  attachmentRows,
  conflictSentence,
  draftStatusLine,
  hostsFor,
  originWord,
  policyLine,
  readNewAccount,
  relative,
  AccountRefusal,
  DraftRefusal,
  KNOWN_HOSTS,
  MAX_DRAFT_BODY,
  RuleRefusal,
  SEARCH_LIMIT,
  THREAD_LIST_LIMIT,
  THREAD_MESSAGE_LIMIT,
  type MailHosts,
} from './pages/index.js';
export { imapflowFactory } from './imap/imapflow-client.js';
export { smtpFactory } from './smtp/nodemailer-client.js';
export { FakeImapServer, fakeMessage, type FakeMailbox } from './imap/fake.js';
export { FakeSmtpServer } from './smtp/fake.js';
export * from './ports.js';
export * from './mail.js';
export * from './rows.js';
export * from './types.js';
export {
  accountOf,
  accountScope,
  identityChoices,
  identityFor,
  ownAddresses,
  requireOneAccount,
  type AccountScope,
  categoryLabel,
  CATEGORIES,
  isKnownCategory,
  KNOWN_CATEGORIES,
  latestTriage,
  LEGACY_CATEGORIES,
  PROCESSING_VERSION,
  URGENCIES,
  type Category,
  type Urgency,
} from './tools/shared.js';

/* ------------------------------------------------------------------ *
 * Step 6: the four remaining watchers (docs/specs/email.md §7, §13.6)
 *
 * Kept in one block of its own rather than folded into the exports above, so
 * that what step 6 added can be read — and merged — as one thing.
 * ------------------------------------------------------------------ */
export {
  createPromisedReplySentinel,
  createReceiptOrBillSentinel,
  createSuspiciousSenderSentinel,
  createUnansweredByThemSentinel,
  promisedReply,
  receiptAgent,
  receiptOrBill,
  suspiciousSender,
  unansweredByThem,
  EVERY_DAY,
  MAX_NUDGE_FINDINGS,
  MAX_PROMISED_FINDINGS,
  MAX_RECEIPT_FINDINGS,
  MAX_SUSPICIOUS_FINDINGS,
} from './sentinels/index.js';
export {
  classifyAsk,
  classifyReceipt,
  discriminatingName,
  findAmount,
  findPromise,
  findQuestion,
  firstLines,
  fold,
  nameKey,
  nfc,
  ownLines,
  ownText,
  ASK_PATTERNS,
  BOILERPLATE_CEILING,
  CONFUSABLES,
  CURRENCIES,
  GENERIC_NAMES,
  LETTER_FOLDINGS,
  MAX_AMOUNT,
  MAX_ASK_CONFIDENCE,
  PROMISE_PATTERNS,
  QUESTION_PATTERNS,
  RECEIPT_AMOUNT_BOOST,
  RECEIPT_CONFIDENCE_CEILING,
  RECEIPT_HEADER_BOOST,
  RECEIPT_PHRASES,
  TOTAL_WINDOW,
  URGENCY,
  URGENCY_BOOST,
  type Amount,
  type AskKind,
  type AskReading,
  type PhraseHit,
  type ReceiptInput,
  type ReceiptReading,
} from './phrases.js';
export {
  ignoredSql,
  receiptsSince,
  recordReceipt,
  scanMessageReceipt,
  stampOldReceipts,
  unscannedReceipts,
  RECEIPT_BODY_LINES,
  RECEIPT_SCAN_BATCH,
  RECEIPT_STAMP_BATCH,
  type ScannableReceipt,
  type StoredReceipt,
} from './receipts-store.js';
export {
  asksSince,
  lookAlikesSince,
  recordSuspicion,
  scanMessageAsk,
  stampOldSuspicions,
  unscannedSuspicions,
  KNOWN_NAMES_YEARS,
  SUSPICION_SCAN_BATCH,
  SUSPICION_STAMP_BATCH,
  type AskRow,
  type ScannableBody,
  type SuspectMessage,
} from './suspicions-store.js';
export {
  clampNudgeDays,
  clampPromisedDays,
  clampReceiptConfidence,
  historyWindowDays,
  money,
  nudgeFinding,
  nudgeKey,
  promisedDraftFinding,
  promisedDraftKey,
  promisedFinding,
  promisedKey,
  receiptFinding,
  receiptKey,
  severityForPromise,
  severityForSuspicion,
  suspiciousFinding,
  suspiciousKey,
  ASK_URGENT_ABOVE,
  DEFAULT_NUDGE_DAYS,
  DEFAULT_PROMISED_DAYS,
  DEFAULT_RECEIPT_CONFIDENCE,
  MAX_NUDGE_DAYS,
  MAX_PROMISED_DAYS,
  MAX_RECEIPT_CONFIDENCE,
  MIN_NUDGE_DAYS,
  MIN_PROMISED_DAYS,
  MIN_RECEIPT_CONFIDENCE,
  NUDGE_DAYS_KEY,
  NUDGE_WINDOW_DAYS,
  PROMISE_WINDOW_DAYS,
  PROMISED_DAYS_KEY,
  RECEIPT_CONFIDENCE_KEY,
  RECEIPT_WINDOW_DAYS,
  SUSPICION_WINDOW_DAYS,
  WARNING_PROMISED_DAYS,
  WINDOW_HEADROOM_DAYS,
  type NudgeFinding,
  type PromisedDraft,
  type PromisedFinding,
  type PromisedReply,
  type ReceiptFinding,
  type ReceiptHit,
  type Suspicion,
  type SuspiciousFinding,
  type UnansweredAsk,
  type WatcherSettingsPatch,
} from './watchers.js';
