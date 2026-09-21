/**
 * Settings → Email: the mailboxes buddi reads and sends as.
 *
 * Accounts are plural (docs/email.md §2), and this is where they stop being an
 * environment variable. The list says, for each one, the address, the host, the
 * vault entry holding its password and when mail last landed — four facts that
 * between them answer "why has this mailbox gone quiet", which was previously a
 * question only a log file could answer.
 *
 * The form asks for the least that can work: the address, the app password, and
 * hosts that are filled in from the domain the moment the address is typed. The
 * sentence under the password field is the one that matters and is never
 * paraphrased: the password goes to the machine's keychain, not to a file, and
 * nothing on this page ever shows one back.
 *
 * The server tests the login before it keeps anything, so a refusal here is a
 * refusal from the owner's own mail provider, in words, before an account that
 * cannot open is written down.
 */
import { useState } from 'react';
import { ApiError, api, type EmailAccountView } from '../api';
import { fmtRelative } from '../format';
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  KV,
  Notice,
  Panel,
  Pill,
  Section,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';

/** The sentence about where the password goes. Said once, exactly. */
export const KEYCHAIN_LINE = 'The password goes to your keychain, never to a file.';

/** One provider's endpoints. Implicit or STARTTLS on the ports named here. */
export interface MailHosts {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

/**
 * What the common providers' hosts are, by the domain of the address.
 *
 * A prefill, never a constraint: every field stays editable, and a provider
 * that is not here falls back to the `imap.`/`smtp.` convention its own domain
 * almost certainly follows. Getting this right for Gmail alone removes the one
 * step of this form that sends people to a search engine.
 */
export const KNOWN_HOSTS: Record<string, MailHosts> = {
  'gmail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  'googlemail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  'outlook.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'hotmail.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'live.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'yahoo.com': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  'icloud.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'me.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'fastmail.com': { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465 },
};

/** The hosts to offer for an address, known provider or not. Null before an @. */
export function hostsFor(address: string): MailHosts | null {
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  if (domain === '' || !domain.includes('.')) return null;
  return (
    KNOWN_HOSTS[domain] ?? {
      imapHost: `imap.${domain}`,
      imapPort: 993,
      smtpHost: `smtp.${domain}`,
      smtpPort: 465,
    }
  );
}

/** What the form holds while it is being filled in. Strings, as typed. */
interface FormState {
  address: string;
  displayName: string;
  aliases: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  password: string;
  /** True once a host field has been edited by hand; the prefill then stops. */
  touched: boolean;
}

const EMPTY: FormState = {
  address: '',
  displayName: '',
  aliases: '',
  imapHost: '',
  imapPort: '993',
  smtpHost: '',
  smtpPort: '465',
  password: '',
  touched: false,
};

/** The request body a filled-in form makes. Exported so a test can read it. */
export function payloadOf(form: FormState): {
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  password: string;
  displayName: string | null;
  aliases: string[];
} {
  return {
    address: form.address.trim().toLowerCase(),
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort),
    password: form.password,
    displayName: form.displayName.trim() === '' ? null : form.displayName.trim(),
    aliases: form.aliases
      .split(/[,\s]+/)
      .map((alias) => alias.trim().toLowerCase())
      .filter((alias) => alias !== ''),
  };
}

export function Email(): JSX.Element {
  const view = useAsync(() => api.emailAccounts(), []);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const set = (patch: Partial<FormState>): void => setForm((current) => ({ ...current, ...patch }));

  /* Typing the address fills the hosts in, until a host is edited by hand. */
  const onAddress = (address: string): void => {
    const hosts = form.touched ? null : hostsFor(address);
    set({
      address,
      ...(hosts
        ? {
            imapHost: hosts.imapHost,
            imapPort: String(hosts.imapPort),
            smtpHost: hosts.smtpHost,
            smtpPort: String(hosts.smtpPort),
          }
        : {}),
    });
  };

  const add = (): void => {
    setBusy(true);
    setFailed(null);
    setAdded(null);
    api
      .addEmailAccount(payloadOf(form))
      .then((account) => {
        setAdded(account.address);
        setForm(EMPTY);
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => {
        setBusy(false);
        view.reload();
      });
  };

  const remove = (account: EmailAccountView): void => {
    setBusy(true);
    setFailed(null);
    api
      .removeEmailAccount(account.id)
      .then(() => setRemoving(null))
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => {
        setBusy(false);
        view.reload();
      });
  };

  const accounts = view.data?.accounts ?? [];
  const ready =
    form.address.includes('@') &&
    form.password.trim() !== '' &&
    form.imapHost.trim() !== '' &&
    form.smtpHost.trim() !== '';

  return (
    <Stack gap="lg">
      <ErrorBanner message={view.error ?? failed} />
      <Panel title="Mailboxes">
        <Stack divided>
          <Section>
            {!view.data ? (
              <Empty>Loading…</Empty>
            ) : accounts.length === 0 ? (
              <Empty>No mailbox yet. Add one below and buddi starts reading it.</Empty>
            ) : (
              <Stack divided>
                {accounts.map((account) => (
                  <Section key={account.id}>
                    <Stack gap="sm">
                      <KV
                        items={[
                          {
                            label: 'Address',
                            value: (
                              <span>
                                <span className="mono">{account.address}</span>{' '}
                                {account.enabled ? null : <Pill tone="warning">off</Pill>}
                                {account.addedVia === 'env' ? <Pill tone="muted">from .env</Pill> : null}
                              </span>
                            ),
                          },
                          ...(account.displayName
                            ? [{ label: 'Called', value: account.displayName }]
                            : []),
                          ...(account.aliases.length > 0
                            ? [{ label: 'Also receives as', value: <span className="mono">{account.aliases.join(', ')}</span> }]
                            : []),
                          { label: 'Host', value: <span className="mono">{account.imapHost}:{account.imapPort} · {account.smtpHost}:{account.smtpPort}</span> },
                          {
                            label: 'Last sync',
                            value: account.lastSyncAt ? fmtRelative(account.lastSyncAt) : 'no mail has arrived yet',
                          },
                          { label: 'Password kept as', value: <span className="mono">{account.secretName}</span> },
                        ]}
                      />
                      {removing === account.id ? (
                        <Notice tone="warning" role="alert">
                          Removing {account.address} deletes its mail and its drafts from buddi, and the password from
                          your keychain. The mailbox itself is untouched.
                        </Notice>
                      ) : null}
                      <Toolbar align="end">
                        {removing === account.id ? (
                          <>
                            <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                              Cancel
                            </Button>
                            <Button variant="danger" disabled={busy} onClick={() => remove(account)}>
                              Remove it
                            </Button>
                          </>
                        ) : (
                          <Button disabled={busy} onClick={() => { setRemoving(account.id); setFailed(null); }}>
                            Remove
                          </Button>
                        )}
                      </Toolbar>
                    </Stack>
                  </Section>
                ))}
              </Stack>
            )}
          </Section>
        </Stack>
      </Panel>

      <Panel title="Add an account">
        <Stack divided>
          <Section>
            <Stack gap="sm">
              <Field
                label="Address"
                hint="The hosts below fill themselves in from this, and stay editable."
              >
                <input
                  type="email"
                  value={form.address}
                  placeholder="you@example.com"
                  disabled={busy}
                  onChange={(event) => onAddress(event.target.value)}
                />
              </Field>
              <Field label="Name for it" hint="Optional. What you call this mailbox.">
                <input
                  type="text"
                  value={form.displayName}
                  placeholder="Work"
                  disabled={busy}
                  onChange={(event) => set({ displayName: event.target.value })}
                />
              </Field>
              <Field
                label="Also receives as"
                hint="Optional, separated by commas. A reply leaves from the alias the message was addressed to."
              >
                <input
                  type="text"
                  value={form.aliases}
                  placeholder="hello@example.com, contact@example.com"
                  disabled={busy}
                  onChange={(event) => set({ aliases: event.target.value })}
                />
              </Field>
            </Stack>
          </Section>
          <Section title="Where its mail lives">
            <Stack gap="sm">
              <Field label="IMAP host">
                <input
                  type="text"
                  value={form.imapHost}
                  placeholder="imap.example.com"
                  disabled={busy}
                  onChange={(event) => set({ imapHost: event.target.value, touched: true })}
                />
              </Field>
              <Field label="IMAP port">
                <input
                  type="number"
                  value={form.imapPort}
                  disabled={busy}
                  onChange={(event) => set({ imapPort: event.target.value, touched: true })}
                />
              </Field>
              <Field label="SMTP host">
                <input
                  type="text"
                  value={form.smtpHost}
                  placeholder="smtp.example.com"
                  disabled={busy}
                  onChange={(event) => set({ smtpHost: event.target.value, touched: true })}
                />
              </Field>
              <Field label="SMTP port">
                <input
                  type="number"
                  value={form.smtpPort}
                  disabled={busy}
                  onChange={(event) => set({ smtpPort: event.target.value, touched: true })}
                />
              </Field>
            </Stack>
          </Section>
          <Section>
            <Stack gap="sm">
              <Field
                label="App password"
                hint="Most providers want a password made for this, not the one you sign in with."
              >
                <input
                  type="password"
                  value={form.password}
                  autoComplete="new-password"
                  disabled={busy}
                  onChange={(event) => set({ password: event.target.value })}
                />
              </Field>
              <p className="ui-card-meta">{KEYCHAIN_LINE}</p>
              {added ? <Notice tone="good" role="status">{added} is set up. buddi will read it from the next poll.</Notice> : null}
              <Toolbar align="end">
                <Button variant="accent" disabled={busy || !ready} onClick={add}>
                  Add the account
                </Button>
              </Toolbar>
            </Stack>
          </Section>
        </Stack>
      </Panel>
    </Stack>
  );
}
