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
import type { PluginManifest, Source } from '@buddi/core';
import { imapflowFactory } from './imap/imapflow-client.js';
import { smtpFactory } from './smtp/nodemailer-client.js';
import { createInboxPollSource } from './sources/inbox-poll.js';
import { draftNew, draftReply } from './tools/drafts.js';
import { listRecent, readMessage, search } from './tools/read.js';
import { createSendTool } from './tools/send.js';
import { triageRecord } from './tools/triage.js';
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
      triageRecord,
      draftReply,
      draftNew,
      createSendTool({
        send: opts.send ?? smtpFactory,
        ...(opts.env ? { env: opts.env } : {}),
      }),
    ],
    sources: createEmailSources(opts),
  };
}

/** The installed manifest: real transports, secrets read from `process.env`. */
export const manifest: PluginManifest = createEmailManifest();

/** The installed sources, for a gateway that wires `poll()` itself. */
export const emailSources: Source[] = manifest.sources ?? [];

export default manifest;

export { listRecent, readMessage, search } from './tools/read.js';
export { triageRecord } from './tools/triage.js';
export { draftNew, draftReply, draftFilename } from './tools/drafts.js';
export {
  buildEnvelope,
  createSendTool,
  renderPreview,
  sha256,
  SEND_TIMEOUT_MS,
  SEND_TOOL_VERSION,
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
  currentAccount,
  ensureGmailAccount,
  resolveAuth,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SECRET_NAME,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GMAIL_USER_VAR,
  INBOX,
  type EnvLike,
} from './config.js';
export { imapflowFactory } from './imap/imapflow-client.js';
export { smtpFactory } from './smtp/nodemailer-client.js';
export { FakeImapServer, fakeMessage, type FakeMailbox } from './imap/fake.js';
export { FakeSmtpServer } from './smtp/fake.js';
export * from './ports.js';
export * from './mail.js';
export * from './rows.js';
export * from './types.js';
export {
  CATEGORIES,
  PROCESSING_VERSION,
  URGENCIES,
  type Category,
} from './tools/shared.js';
