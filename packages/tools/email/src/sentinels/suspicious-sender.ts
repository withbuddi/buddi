/**
 * `email.suspicious-sender` — somebody is wearing a name, or asking for money.
 *
 * docs/specs/email.md §7: *«a first-time sender imitating a known one (display
 * name matches, address does not), or a message asking for credentials, a wire,
 * or a gift card»*; §12.5 is the acceptance test — *«a message asking for a
 * wire transfer from a look-alike address raises the suspicious-sender finding
 * and no draft»*.
 *
 * Two tests, one finding per message, keyed to the message; the detail says
 * which of them fired, and when both do the message is named once rather than
 * twice. Where each test lives, and why, is in `suspicions-store.ts`.
 *
 * ## The one watcher an `ignore` policy does not silence
 *
 * Every other watcher here stops at a live `ignore` rule, because a sender the
 * owner silenced does not get to speak through a different door. This one is
 * the exception, on purpose: an impostor sends from a domain the owner has very
 * likely silenced — that is the *shape of the thing* — and a fraud that can buy
 * its own quiet with a promotional rule is not being watched for at all. Only a
 * muted conversation silences it, because muting is a decision about a
 * conversation the owner has actually read.
 *
 * ## It quotes one line and no more
 *
 * A fraud's own prose is the last text that should be read out at length to a
 * model that is being asked what to do about it. The finding carries a single
 * fenced first line, the phrase that fired, and ids — and the instruction that
 * the agent is to describe it to the owner and reply to nothing.
 */
import type { Finding, Sentinel, SentinelContext, SentinelReport } from '@buddi/core';
import {
  SUSPICION_SCAN_BATCH,
  asksSince,
  lookAlikesSince,
  recordSuspicion,
  scanMessageAsk,
  unscannedSuspicions,
  type SuspectMessage,
} from '../suspicions-store.js';
import {
  SUSPICION_WINDOW_DAYS,
  firstLineOf,
  suspiciousFinding,
  type Suspicion,
} from '../watchers.js';
import { mailAgent } from './waiting-on-me.js';

/** Hourly, and the one watcher here where the hour matters. */
export const EVERY_HOUR = 60 * 60;

/** At most this many findings in one tick. */
export const MAX_SUSPICIOUS_FINDINGS = 20;

export function createSuspiciousSenderSentinel(): Sentinel {
  return {
    id: 'email.suspicious-sender',
    description:
      'Reports a sender wearing the display name of somebody you write to at another address, or a message ' +
      'asking for a password, a transfer or a gift card.',
    every: EVERY_HOUR,
    async run(ctx: SentinelContext): Promise<SentinelReport> {
      const now = ctx.now();

      // Catch-up: read the bodies nothing has read. Every inbound message,
      // silenced senders included — see the module note.
      for (const message of await unscannedSuspicions(ctx.db, SUSPICION_SCAN_BATCH)) {
        try {
          await scanMessageAsk(ctx.db, message, now);
        } catch {
          await recordSuspicion(ctx.db, message.id, null, now).catch(() => {});
        }
      }

      const since = new Date(now.getTime() - SUSPICION_WINDOW_DAYS * 86_400_000);
      const [lookAlikes, asks] = await Promise.all([
        lookAlikesSince(ctx.db, since),
        asksSince(ctx.db, since),
      ]);

      /*
       * One message, one warning. A look-alike that also asks for a wire is
       * the same fraud twice over, not two of them, so the two lists are
       * merged on the message id before anything is shaped.
       */
      const suspects = new Map<string, Suspicion>();
      const shape = (message: SuspectMessage): Suspicion => ({
        messageId: message.messageId,
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        firstLine: firstLineOf(message.bodyText ?? message.snippet ?? ''),
        lookAlike: false,
        ask: null,
      });
      for (const message of lookAlikes) {
        suspects.set(message.messageId, { ...shape(message), lookAlike: true });
      }
      for (const row of asks) {
        const existing = suspects.get(row.messageId) ?? shape(row);
        suspects.set(row.messageId, {
          ...existing,
          ask: { kind: row.kind, confidence: row.confidence, phrase: row.phrase },
        });
      }

      const agentId = mailAgent(ctx);
      const keys: string[] = [];
      const findings: Finding[] = [];
      /*
       * Urgent first, so the cap truncates the notices rather than the
       * warnings — every key is still returned, so nothing is resolved by
       * being left out.
       */
      const shaped = [...suspects.values()].map((s) => suspiciousFinding(s));
      shaped.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'urgent' ? -1 : 1));
      for (const finding of shaped) {
        keys.push(finding.key);
        if (findings.length >= MAX_SUSPICIOUS_FINDINGS) continue;
        findings.push({ ...finding, ...(agentId ? { agentId } : {}) });
      }
      return { findings, keys };
    },
  };
}

export const suspiciousSender: Sentinel = createSuspiciousSenderSentinel();
