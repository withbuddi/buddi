/**
 * An in-process SMTP sink. Records the exact envelope it was handed, so a test
 * can assert that what the owner approved is what went on the wire.
 */
import type { SmtpClient, SmtpClientFactory, SmtpEnvelope, SmtpResult } from '../ports.js';

export class FakeSmtpServer {
  readonly sent: SmtpEnvelope[] = [];
  /**
   * The address of the account each client authenticated as, in order.
   *
   * Separate from `sent[].from` on purpose, and that separation is the point:
   * an alias changes who the message is *from*, never which mailbox opened the
   * connection. A test that only looked at `from` could not tell the two
   * apart, and telling them apart is the whole of the identity choice.
   */
  readonly logins: string[] = [];
  closes = 0;
  /** Set to make the next send fail, the way a refused relay would. */
  failWith: Error | null = null;
  #seq = 0;

  client(): SmtpClient {
    return {
      send: async (envelope: SmtpEnvelope): Promise<SmtpResult> => {
        if (this.failWith) {
          const err = this.failWith;
          this.failWith = null;
          throw err;
        }
        this.sent.push({
          ...envelope,
          to: [...envelope.to],
          cc: [...envelope.cc],
          bcc: [...envelope.bcc],
          references: [...(envelope.references ?? [])],
        });
        this.#seq += 1;
        return {
          messageId: `<fake-${this.#seq}@smtp.test>`,
          response: `250 2.0.0 OK fake-${this.#seq}`,
          accepted: [...envelope.to, ...envelope.cc, ...envelope.bcc],
          rejected: [],
        };
      },
      close: async () => {
        this.closes += 1;
      },
    };
  }

  factory(): SmtpClientFactory {
    return async (account) => {
      this.logins.push(account.address);
      return this.client();
    };
  }
}
