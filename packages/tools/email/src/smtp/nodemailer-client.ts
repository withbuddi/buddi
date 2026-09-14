/**
 * The real SMTP adapter: `nodemailer` behind the `SmtpClient` port.
 *
 * Implicit TLS on 465 with certificate verification on. The envelope is passed
 * through verbatim — every recipient the approved action named, BCC included —
 * because the approval was bound to exactly these bytes and the adapter is not
 * allowed to reinterpret them.
 *
 * Imported dynamically: registering the plugin must not pull a mail transport
 * into the process, and the test suite never loads one at all.
 */
import type {
  AccountRecord,
  EmailAuth,
  SmtpClient,
  SmtpClientFactory,
  SmtpEnvelope,
  SmtpResult,
} from '../ports.js';

interface TransporterLike {
  sendMail(message: Record<string, unknown>): Promise<Record<string, any>>;
  close(): void;
}

interface NodemailerLike {
  createTransport(options: Record<string, unknown>): TransporterLike;
}

export const smtpFactory: SmtpClientFactory = async (
  account: AccountRecord,
  auth: EmailAuth,
): Promise<SmtpClient> => {
  const mod = (await import('nodemailer')) as unknown as
    | NodemailerLike
    | { default: NodemailerLike };
  const nodemailer: NodemailerLike = 'createTransport' in mod ? mod : mod.default;
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    // 465 is implicit TLS; anything else would be an unencrypted first hop.
    secure: account.smtpPort === 465,
    requireTLS: true,
    auth: { user: auth.user, pass: auth.pass },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });

  return {
    async send(envelope: SmtpEnvelope): Promise<SmtpResult> {
      const info = await transporter.sendMail({
        from: envelope.from,
        to: envelope.to,
        cc: envelope.cc,
        bcc: envelope.bcc,
        subject: envelope.subject,
        text: envelope.text,
        ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
        ...(envelope.references && envelope.references.length
          ? { references: envelope.references }
          : {}),
      });
      return {
        messageId: String(info.messageId ?? ''),
        response: String(info.response ?? ''),
        accepted: (info.accepted ?? []).map(String),
        rejected: (info.rejected ?? []).map(String),
      };
    },
    async close(): Promise<void> {
      transporter.close();
    },
  };
};
