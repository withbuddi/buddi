/**
 * Settings → Email: the mailboxes, and the standing decisions about their mail.
 *
 * One section, two panels, in the order the owner meets them. A mailbox has to
 * exist before a rule about its mail means anything, so **Accounts** is on top
 * and **Policies** sits under a hairline below it.
 *
 * ## Accounts
 *
 * Accounts are plural (docs/specs/email.md §2), and this is where they stop being an
 * environment variable. The list says, for each one, the address, the host, the
 * vault entry holding its password and when mail last landed — four facts that
 * between them answer "why has this mailbox gone quiet", which was previously a
 * question only a log file could answer.
 *
 * **Add an account** is a button on the right of that heading and opens a
 * drawer. The page is then a list of what exists, and the drawer is where
 * something is made: a form as long as this one does not belong in the same
 * column as the mailboxes it is about. The draft stays in it — closing the
 * drawer is closing a lid, not tearing the page out — until the page reloads.
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
 *
 * ## Policies
 *
 * The standing decisions about incoming mail, in two lists, because they are
 * two different things and reading them as one is how an owner ends up not
 * knowing what is switched on:
 *
 *  - **Applied** — rules that are deciding, right now, with no model run and
 *    nothing to approve each time. Each row says how many triage runs it has
 *    saved, which is the only honest measure of what it is doing for you.
 *  - **Learned, proposed** — what buddi noticed in your own history and would
 *    like to do. These decide nothing. Keep turns one on; Revoke says no.
 *
 * Both lists carry a tick per row, a tick for everything shown, and the acts
 * that a selection is for — and the header says how many rows there are ("73
 * proposed"), because a list that long is the reason the bulk actions exist at
 * all. "All" means every row *shown*, and it asks once, in a line that names
 * the number rather than saying "all of them". The whole selection travels as
 * one request and lands in one transaction: what the owner ticked is one
 * decision, and half of it landing would leave an installation nobody chose.
 *
 * Revoke is on both lists on purpose: a rule that is on must be one tap from
 * off. Nothing learned is ever applied without being kept first: the Sent
 * folder is synced from the day buddi arrived, so "you never wrote back" is
 * still only as old as this installation, and a half-known history does not
 * get to silence anyone (docs/specs/email.md §3). The Learned list is where a
 * proposal becomes a rule.
 *
 * One rule is not typed but *picked*: "One conversation". A thread is named in
 * the database by the root Message-ID of its chain, which is not something an
 * owner has, so the form offers the conversations buddi has seen, by subject,
 * and sends the thread's id — which is what the gate matches.
 *
 * ## Writing one
 *
 * **Add a rule** is the owner's own path to the same table the tools write to,
 * with no approval card in the way — they are the one acting. It opens in a
 * drawer, for the same reason the account form does. It asks for the
 * mailbox as plainly as for the matcher: a rule with no mailbox decides for
 * every mailbox, so that has to be the "for every mailbox" box, ticked, and
 * never a field somebody left empty.
 */
import { useState } from 'react';
import {
  ApiError,
  api,
  type EmailAccountView,
  type EmailPolicy,
  type EmailThreadChoice,
  type EmailWatcherSettings,
} from '../api';
import { fmtRelative } from '../format';
import { EmailDraftsBlock } from './parts/EmailDrafts';
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  KV,
  List,
  ListRow,
  Notice,
  PageFrame,
  Panel,
  Pill,
  Section,
  Sheet,
  Stack,
  Toolbar,
  useAsync,
  type Tone,
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

export function Email({ embedded }: { embedded?: boolean }): JSX.Element {
  const view = useAsync(() => api.emailAccounts(), []);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /*
   * Which drawer is open, and nothing about what is in it.
   *
   * The two forms' state lives in this component rather than in the drawers,
   * so closing one is closing a lid: a half-typed account is still half-typed
   * when it is opened again, and only a reload of the page throws it away.
   */
  const [sheet, setSheet] = useState<'account' | 'rule' | null>(null);

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
        // Saved, so the drawer has nothing left to hold.
        setSheet(null);
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


  /*
   * The new-rule form. `allAccounts` is a tick, not a default: the route
   * refuses a policy that names neither one mailbox nor all of them.
   */
  const [rule, setRule] = useState<RuleForm>(EMPTY_RULE);
  const setRuleField = (patch: Partial<RuleForm>): void =>
    setRule((current) => ({ ...current, ...patch }));

  /*
   * Policies and the selected mailbox's thread choices share one response.
   * Passing the mailbox to the read makes the 50-row cap account-local.
   */
  const policyAccount = rule.scope === 'thread' && rule.accountId !== '' ? rule.accountId : undefined;
  const policies = useAsync(() => api.emailPolicies(policyAccount), [policyAccount]);
  const [policyBusy, setPolicyBusy] = useState<string | null>(null);
  const [policyFailed, setPolicyFailed] = useState<string | null>(null);

  const act = (id: string, run: () => Promise<unknown>) => (): void => {
    setPolicyBusy(id);
    setPolicyFailed(null);
    void run()
      .then(() => policies.reload())
      .catch((err: unknown) => setPolicyFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setPolicyBusy(null));
  };

  const applied = policies.data?.applied ?? [];
  const proposed = policies.data?.proposed ?? [];
  const threads = policies.data?.threads ?? [];
  const saved = applied.reduce((n, p) => n + p.runsSaved, 0);

  /*
   * What is ticked, per list, and which "all" is waiting to be confirmed.
   *
   * Kept per list rather than in one set: the two lists mean different things
   * and a tick carried from one to the other would be a rule the owner chose
   * on a screen they were not looking at.
   */
  const [picked, setPicked] = useState<{ applied: string[]; proposed: string[] }>({
    applied: [],
    proposed: [],
  });
  const [asking, setAsking] = useState<{ list: PolicyList; action: BulkAction } | null>(null);

  /** One selection, one request, one reload. */
  const bulk = (action: BulkAction, ids: string[]): void => {
    if (ids.length === 0) return;
    setPolicyBusy('bulk');
    setPolicyFailed(null);
    void api
      .bulkEmailPolicies(action, ids)
      .then(() => {
        setPicked({ applied: [], proposed: [] });
        setAsking(null);
        policies.reload();
      })
      .catch((err: unknown) => setPolicyFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setPolicyBusy(null));
  };

  // A short name for each mailbox, for the thread picker's labels.
  const accountLabels = new Map(
    accounts.map((a) => [a.id, a.displayName ? a.displayName : a.address] as const),
  );
  // The conversations on offer for a `thread` rule: only the chosen
  // mailbox's. Empty (not "every mailbox") until one is chosen.
  const threadChoices =
    rule.scope === 'thread'
      ? rule.accountId === ''
        ? []
        : threads.filter((t) => t.accountId === rule.accountId)
      : threads;

  const ruleReady =
    rule.matcher.trim() !== '' && (rule.allAccounts || rule.accountId !== '');

  const addRule = (): void => {
    setPolicyBusy('new');
    setPolicyFailed(null);
    void api
      .setEmailPolicy(ruleBodyOf(rule))
      .then(() => {
        setRule(EMPTY_RULE);
        setSheet(null);
        policies.reload();
      })
      .catch((err: unknown) => setPolicyFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setPolicyBusy(null));
  };

  /*
   * The two forms, unchanged, as they were on the page.
   *
   * They are written here and rendered inside a drawer so that the page is a
   * list of what exists and the drawer is where something is made — the
   * long-lived thing on screen, and the thing being typed, no longer competing
   * for the same column.
   */
  const accountForm = (
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
          <Toolbar align="end">
            <Button variant="accent" disabled={busy || !ready} onClick={add}>
              Add the account
            </Button>
          </Toolbar>
        </Stack>
      </Section>
    </Stack>
  );

  const ruleForm = (
    <Stack divided>
      <Section title="Which mailbox">
        <Stack gap="sm">
          {/*
            * The mailbox first: a conversation lives in exactly one of
            * them, so the picker below can only ever offer that one's
            * threads once this is answered — never all 50 most-recent
            * threads across every account, which could hand a busy
            * mailbox's conversations to a rule meant for a quiet one.
            */}
          <Field label="Mailbox">
            <select
              aria-label="Which mailbox"
              value={rule.accountId}
              disabled={rule.allAccounts}
              onChange={(event) =>
                setRuleField({
                  accountId: event.target.value,
                  // A conversation picked for the old mailbox is not
                  // one of this mailbox's; stale choice, cleared.
                  ...(rule.scope === 'thread' ? { matcher: '' } : {}),
                })
              }
            >
              <option value="">Choose one…</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName ? `${account.displayName} — ` : ''}
                  {account.address}
                </option>
              ))}
            </select>
          </Field>
          <label className="backup-check">
            <input
              type="checkbox"
              checked={rule.allAccounts}
              disabled={rule.scope === 'thread'}
              onChange={(event) =>
                setRuleField({ allAccounts: event.target.checked, accountId: '' })
              }
            />
            <span>For every mailbox</span>
          </label>
          <p className="ui-card-meta">
            {rule.scope === 'thread'
              ? 'A conversation lives in one mailbox, so a rule about one is never "every mailbox".'
              : 'The same sender can matter in one inbox and not in another, so a rule says which one it is about — unless you tick the box, and then it says all of them.'}
          </p>
        </Stack>
      </Section>
      <Section>
        <Stack gap="sm">
          <Field label="About">
            <select
              aria-label="What the rule is about"
              value={rule.scope}
              onChange={(event) => {
                const scope = event.target.value;
                setRuleField({
                  scope,
                  matcher: '',
                  // "Every mailbox" is meaningless for one conversation.
                  ...(scope === 'thread' ? { allAccounts: false } : {}),
                });
              }}
            >
              <option value="sender">One sender</option>
              <option value="domain">Everyone at a domain</option>
              <option value="list-id">One mailing list</option>
              <option value="thread">One conversation</option>
            </select>
          </Field>
          {/*
            * A conversation is picked, never typed. It is named in the
            * database by the root Message-ID of its thread, which is
            * not something an owner has or should have to find, and
            * the rule carries the thread's id. So the one scope that
            * cannot be a text field is a list of subjects — filtered to
            * the mailbox chosen above, and labelled with it too, so a
            * conversation from another mailbox is never on offer.
            */}
          <Field
            label={MATCHER_LABEL[rule.scope] ?? 'Matcher'}
            {...(rule.scope === 'thread'
              ? {
                  hint:
                    rule.accountId === ''
                      ? 'Choose a mailbox above first.'
                      : 'The conversations buddi has seen in this mailbox, most recent first.',
                }
              : {})}
          >
            {rule.scope === 'thread' ? (
              <select
                aria-label="Which conversation"
                value={rule.matcher}
                disabled={rule.accountId === ''}
                onChange={(event) => {
                  const chosen = threadChoices.find((t) => t.id === event.target.value);
                  setRuleField({
                    matcher: event.target.value,
                    // The thread's own mailbox, bound automatically —
                    // never left to disagree with what was picked.
                    ...(chosen ? { accountId: chosen.accountId } : {}),
                  });
                }}
              >
                <option value="">Choose one…</option>
                {threadChoices.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {threadLabel(thread, accountLabels)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={rule.matcher}
                placeholder={MATCHER_HINT[rule.scope] ?? ''}
                onChange={(event) => setRuleField({ matcher: event.target.value })}
              />
            )}
          </Field>
          <Field label="Then">
            <select
              aria-label="What happens"
              value={rule.action}
              onChange={(event) => setRuleField({ action: event.target.value })}
            >
              <option value="ignore">File it, with no triage run</option>
              <option value="notify">Send me one line</option>
              <option value="draft">Draft a reply</option>
              <option value="wake">Triage it as usual</option>
            </select>
          </Field>
          {rule.action === 'ignore' && (rule.scope === 'thread' || rule.scope === 'list-id') ? (
            <Field
              label="From this address"
              hint="A conversation and a list are named by headers their sender writes, so silence here applies to one address. Without it, this rule silences nothing on its own."
            >
              <input
                type="text"
                value={rule.sender}
                placeholder="them@example.com"
                onChange={(event) => setRuleField({ sender: event.target.value })}
              />
            </Field>
          ) : null}
          <Toolbar align="end">
            <Button
              variant="accent"
              disabled={policyBusy === 'new' || !ruleReady}
              onClick={addRule}
            >
              Add the rule
            </Button>
          </Toolbar>
        </Stack>
      </Section>
    </Stack>
  );

  return (
    <PageFrame embedded={embedded} title="Email">
      <ErrorBanner message={view.error ?? policies.error ?? failed ?? policyFailed} />
      <Stack divided>
        <Section
          title="Mailboxes"
          aside={
            <Button variant="accent" onClick={() => { setSheet('account'); setFailed(null); }}>
              Add an account
            </Button>
          }
        >
          <Stack gap="lg">
          {added ? (
            <Notice tone="good" role="status">
              {added} is set up. buddi will read it from the next poll.
            </Notice>
          ) : null}
          <Panel>
            <Stack divided>
              <Section>
                {!view.data ? (
                  <Empty>Loading…</Empty>
                ) : accounts.length === 0 ? (
                  <Empty>No mailbox yet. Add one and buddi starts reading it.</Empty>
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
          </Stack>
        </Section>
        <Section
          title="Policies"
          aside={
            <Button variant="accent" onClick={() => { setSheet('rule'); setPolicyFailed(null); }}>
              Add a rule
            </Button>
          }
        >
          <Stack gap="lg">
          <Notice>
            A policy is a decision made once. The next message from that sender is handled by the rule
            instead of by a model run, and what each rule did is recorded so you can audit the silence.
            {saved > 0 ? ` So far they have saved ${saved} triage run${saved === 1 ? '' : 's'}.` : ''}
          </Notice>

          <PolicyPanel
            title="Applied"
            kind="applied"
            rows={applied}
            loading={!policies.data}
            empty="No policies are deciding anything yet. buddi proposes them from your own mail."
            busy={policyBusy}
            picked={picked.applied}
            onPicked={(ids) => setPicked((current) => ({ ...current, applied: ids }))}
            asking={asking?.list === 'applied' ? asking.action : null}
            onAsk={(action) => setAsking(action ? { list: 'applied', action } : null)}
            onBulk={bulk}
            onOne={(id, action) =>
              act(id, () => (action === 'keep' ? api.keepEmailPolicy(id) : api.revokeEmailPolicy(id)))()
            }
          />

          <PolicyPanel
            title="Learned, proposed"
            kind="proposed"
            rows={proposed}
            loading={!policies.data}
            empty="Nothing proposed. A sender needs three verdicts running before buddi suggests a rule."
            busy={policyBusy}
            picked={picked.proposed}
            onPicked={(ids) => setPicked((current) => ({ ...current, proposed: ids }))}
            asking={asking?.list === 'proposed' ? asking.action : null}
            onAsk={(action) => setAsking(action ? { list: 'proposed', action } : null)}
            onBulk={bulk}
            onOne={(id, action) =>
              act(id, () => (action === 'keep' ? api.keepEmailPolicy(id) : api.revokeEmailPolicy(id)))()
            }
          />
          </Stack>
        </Section>
        <EmailDraftsBlock />
        <WatchersBlock />
      </Stack>
      {sheet === 'account' ? (
        <Sheet title="Add an account" onClose={() => setSheet(null)}>
          {accountForm}
        </Sheet>
      ) : null}
      {sheet === 'rule' ? (
        <Sheet title="Add a rule" onClose={() => setSheet(null)}>
          {ruleForm}
        </Sheet>
      ) : null}
    </PageFrame>
  );
}


/**
 * The two numbers the mail watchers read (docs/specs/email.md §7).
 *
 * Small on purpose: the watchers themselves live on the Watchers page, with
 * their switches and their last run, and this is only what *mail* watching
 * needs told — how long is too long to leave somebody waiting, and how sure a
 * date has to look before it is worth a word. Both are saved together, because
 * two fields and two buttons would be two decisions where there is one.
 */
export function WatchersBlock(): JSX.Element {
  const settings = useAsync(() => api.emailWatchers(), []);
  const [days, setDays] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current: EmailWatcherSettings | undefined = settings.data;
  const daysValue = days ?? (current ? String(current.waitingDays) : '');
  const confidenceValue = confidence ?? (current ? String(current.dateConfidence) : '');
  const dirty =
    current !== undefined &&
    (daysValue !== String(current.waitingDays) || confidenceValue !== String(current.dateConfidence));

  const save = (): void => {
    setBusy(true);
    setFailed(null);
    setSaved(false);
    api
      .setEmailWatchers({ waitingDays: Number(daysValue), dateConfidence: Number(confidenceValue) })
      .then(() => {
        setSaved(true);
        setDays(null);
        setConfidence(null);
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => {
        setBusy(false);
        settings.reload();
      });
  };

  return (
    <Section title="Watchers">
      <Stack gap="lg">
        <ErrorBanner message={settings.error ?? failed} />
        <Notice>
          Two watchers read your mail without a model: one reports a conversation that has been waiting on
          you, the other a date stated in a message with no reminder for it. Neither ever sends anything —
          they wake an agent, which reads the thread before it says a word.
        </Notice>
        <Panel>
          <Stack gap="sm">
            <Field
              label="Waiting longer than"
              hint={
                current
                  ? `Days before a conversation waiting on you is reported. ${current.defaults.waitingDays} by default; a week or more is always urgent.`
                  : 'Days before a conversation waiting on you is reported.'
              }
            >
              <input
                type="number"
                inputMode="numeric"
                min={current?.limits.waitingDays.min ?? 1}
                max={current?.limits.waitingDays.max ?? 60}
                value={daysValue}
                disabled={!current || busy}
                onChange={(event) => { setDays(event.target.value); setSaved(false); }}
              />
            </Field>
            <Field
              label="Date confidence"
              hint={
                current
                  ? `How sure the date reader must be before it says anything, between ${current.limits.dateConfidence.min} and ${current.limits.dateConfidence.max}. ${current.defaults.dateConfidence} by default: a date with "deadline" beside it scores about 0.8, a bare "9/8" scores 0.3.`
                  : 'How sure the date reader must be before it says anything.'
              }
            >
              <input
                type="number"
                inputMode="decimal"
                step="0.05"
                min={current?.limits.dateConfidence.min ?? 0.1}
                max={current?.limits.dateConfidence.max ?? 0.99}
                value={confidenceValue}
                disabled={!current || busy}
                onChange={(event) => { setConfidence(event.target.value); setSaved(false); }}
              />
            </Field>
            {saved ? (
              <Notice tone="good" role="status">
                Saved. The watchers use it on their next run.
              </Notice>
            ) : null}
            <Toolbar align="end">
              <Button variant="accent" disabled={!dirty || busy} onClick={save}>
                Save
              </Button>
            </Toolbar>
          </Stack>
        </Panel>
      </Stack>
    </Section>
  );
}

/** Which of the two lists a selection or a confirm belongs to. */
export type PolicyList = 'applied' | 'proposed';

/** The two things a selection can be turned into. */
export type BulkAction = 'keep' | 'revoke';

/**
 * The one line a bulk "all" asks before it happens, naming the count.
 *
 * It names the number rather than saying "all of them", because "all" is the
 * word on the button and the owner cannot see from it whether that is three
 * rules or seventy-three.
 */
export function confirmLine(action: BulkAction, count: number): string {
  const rules = `${count} rule${count === 1 ? '' : 's'}`;
  return action === 'keep'
    ? `Keep ${rules}? They start deciding straight away, with no model run.`
    : `Revoke ${rules}? They stop deciding anything from now on.`;
}

/**
 * One of the two policy lists, with the bulk actions in its header.
 *
 * Both lists are the same table read two ways, so they are one component: a
 * tick per row, a tick for everything shown, and the acts that the selection
 * is for. Only the proposed list offers Keep — an applied rule is already
 * kept, and a button saying so would be a button that does nothing.
 *
 * "All" means every row *shown*, and the header says how many that is. The
 * count in the header is the same number the buttons carry, so the sentence
 * the confirm asks and the list the owner is looking at cannot disagree.
 */
function PolicyPanel({
  title,
  kind,
  rows,
  loading,
  empty,
  busy,
  picked,
  onPicked,
  asking,
  onAsk,
  onBulk,
  onOne,
}: {
  title: string;
  kind: PolicyList;
  rows: EmailPolicy[];
  loading: boolean;
  empty: string;
  busy: string | null;
  picked: string[];
  onPicked: (ids: string[]) => void;
  /** The "all" waiting on a yes, for this list. */
  asking: BulkAction | null;
  onAsk: (action: BulkAction | null) => void;
  onBulk: (action: BulkAction, ids: string[]) => void;
  onOne: (id: string, action: BulkAction) => void;
}): JSX.Element {
  const ids = rows.map((p) => p.id);
  // Only what is still on screen counts as ticked: the list is reloaded after
  // every act, and a rule that has gone must not travel in the next request.
  const chosen = picked.filter((id) => ids.includes(id));
  const working = busy !== null;
  const word = kind === 'proposed' ? 'proposed' : 'applied';

  const toggle = (id: string, on: boolean): void =>
    onPicked(on ? [...chosen, id] : chosen.filter((other) => other !== id));

  return (
    <Panel
      title={title}
      tool={`${rows.length} ${word}`}
      actions={
        rows.length === 0 ? undefined : asking ? (
          <>
            <span className="ui-panel-tool" role="status">
              {confirmLine(asking, ids.length)}
            </span>
            <Button size="sm" disabled={working} onClick={() => onAsk(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={asking === 'keep' ? 'accent' : 'danger'}
              disabled={working}
              onClick={() => onBulk(asking, ids)}
            >
              {asking === 'keep' ? `Keep all (${ids.length})` : `Revoke all (${ids.length})`}
            </Button>
          </>
        ) : (
          <>
            <label className="policy-check">
              <input
                type="checkbox"
                aria-label={`Select all ${word}`}
                checked={chosen.length === ids.length}
                onChange={(event) => onPicked(event.target.checked ? ids : [])}
              />
              <span>All</span>
            </label>
            <Button size="sm" disabled={working || chosen.length === 0} onClick={() => onBulk('revoke', chosen)}>
              Revoke selected
            </Button>
            <Button size="sm" variant="danger" disabled={working} onClick={() => onAsk('revoke')}>
              Revoke all ({ids.length})
            </Button>
            {kind === 'proposed' ? (
              <>
                <Button size="sm" disabled={working || chosen.length === 0} onClick={() => onBulk('keep', chosen)}>
                  Keep selected
                </Button>
                <Button size="sm" variant="accent" disabled={working} onClick={() => onAsk('keep')}>
                  Keep all ({ids.length})
                </Button>
              </>
            ) : null}
          </>
        )
      }
      flush
    >
      {loading ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <List>
          {rows.map((p) => (
            <ListRow
              key={p.id}
              lead={
                <>
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.matcher}`}
                    checked={chosen.includes(p.id)}
                    onChange={(event) => toggle(p.id, event.target.checked)}
                  />
                  <Pill tone={kind === 'proposed' ? 'muted' : toneFor(p.action)}>{p.action}</Pill>
                </>
              }
              title={p.matcher}
              sub={subFor(p)}
              side={
                <Toolbar align="end">
                  <Button onClick={() => onOne(p.id, 'revoke')} disabled={busy === p.id}>
                    Revoke
                  </Button>
                  {kind === 'proposed' ? (
                    <Button variant="accent" onClick={() => onOne(p.id, 'keep')} disabled={busy === p.id}>
                      Keep
                    </Button>
                  ) : null}
                </Toolbar>
              }
            />
          ))}
        </List>
      )}
    </Panel>
  );
}

/** The one line under a rule: where it came from, and what it has done. */
export function subFor(policy: EmailPolicy): string {
  const parts = [`${policy.scope}, ${originWord(policy.origin)}`];
  if (policy.learnedFrom > 0) parts.push(`from ${policy.learnedFrom} verdicts`);
  parts.push(
    policy.proposed
      ? 'deciding nothing yet'
      : policy.runsSaved === 0
        ? 'no runs saved yet'
        : `${policy.runsSaved} run${policy.runsSaved === 1 ? '' : 's'} saved`,
  );
  if (policy.createdAt) parts.push(fmtRelative(policy.createdAt));
  return parts.join(' · ');
}

export function originWord(origin: string): string {
  if (origin === 'owner') return 'you decided it';
  if (origin === 'learned') return 'learned from your mail';
  return 'from a plugin';
}

export function toneFor(action: string): Tone | undefined {
  if (action === 'ignore') return 'muted';
  if (action === 'notify' || action === 'draft') return 'accent';
  if (action === 'hand-to-agent') return 'good';
  return undefined;
}

/** What the new-rule form holds while it is being filled in. Strings, as typed. */
export interface RuleForm {
  scope: string;
  matcher: string;
  action: string;
  /** The address a thread or list rule silences. Empty for the other scopes. */
  sender: string;
  accountId: string;
  /** Ticked, never defaulted: this is what writes a rule with no mailbox. */
  allAccounts: boolean;
}

export const EMPTY_RULE: RuleForm = {
  scope: 'sender',
  matcher: '',
  action: 'ignore',
  sender: '',
  accountId: '',
  allAccounts: false,
};

export const MATCHER_LABEL: Record<string, string> = {
  sender: 'Their address',
  domain: 'The domain',
  'list-id': 'The list id',
  thread: 'Which conversation',
};

/**
 * A conversation as the picker names it: its mailbox, its subject, and who it
 * is with. The mailbox is named even though the list is already filtered to
 * one account — the label should say what it is, on its own, not rely on
 * whatever the picker above it happens to be set to.
 */
export function threadLabel(
  thread: EmailThreadChoice,
  accountLabels?: ReadonlyMap<string, string>,
): string {
  const subject = thread.subject.trim() === '' ? '(no subject)' : thread.subject.trim();
  const others = thread.participants.slice(0, 2).join(', ');
  const mailbox = accountLabels?.get(thread.accountId);
  const base = others === '' ? subject : `${subject} — ${others}`;
  return mailbox ? `[${mailbox}] ${base}` : base;
}

/** `Them <THEM@x.test>` -> `them@x.test`. The server normalises too; this is
 * so what the page sends is what the page showed. */
export function bareAddress(raw: string): string {
  const trimmed = raw.trim();
  const angled = /<([^>]+)>/.exec(trimmed);
  return (angled?.[1] ?? trimmed).trim().toLowerCase();
}

/** Placeholders for the scopes that are typed. A thread is picked, not typed. */
export const MATCHER_HINT: Record<string, string> = {
  sender: 'news@shop.example',
  domain: 'shop.example',
  'list-id': 'weekly.shop.example',
};

/**
 * The request body a filled-in rule makes. Exported so a test can read it.
 *
 * The mailbox is sent as one of two mutually exclusive things — `accountId` or
 * `allAccounts: true` — because that is how the route reads it, and an omitted
 * account is no longer a silent "all of them".
 */
export function ruleBodyOf(rule: RuleForm): {
  scope: string;
  matcher: string;
  action: string;
  sender?: string;
  accountId?: string;
  allAccounts?: boolean;
} {
  const sender = bareAddress(rule.sender);
  return {
    scope: rule.scope,
    matcher: rule.matcher.trim(),
    action: rule.action,
    ...(sender !== '' && (rule.scope === 'thread' || rule.scope === 'list-id') ? { sender } : {}),
    ...(rule.allAccounts ? { allAccounts: true } : { accountId: rule.accountId }),
  };
}
