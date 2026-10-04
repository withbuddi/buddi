/**
 * The three small sheets first run opens from chapter 4: a mailbox, a
 * calendar's private link, the bank.
 *
 * First run only. Each asks one thing at a time and writes through the
 * plugin's own page tools (`email.add_account`, `calendar.add`,
 * `calendar.google_sign_in` / `calendar.google_finish`) — the same writes
 * the full settings pages make, so no password or link is handled here beyond
 * passing it to that tool once. Everything else a plugin can do (policies,
 * counters, access per calendar) stays on its own settings page.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api, ApiError } from '../../api';
import { Button, ButtonLink, Details, Field, Icon, Sheet, Spacer, Toolbar } from '../../ui';

/* ------------------------------------------------------------------ *
 * words
 * ------------------------------------------------------------------ */

export type MailProvider = 'gmail' | 'icloud' | 'fastmail' | 'other';

export const SHEETS = {
  back: 'Back',
  checking: 'Checking…',
  mailbox: {
    sheet: 'Add a mailbox',
    which: 'Which mailbox?',
    providers: {
      gmail: { name: 'Gmail', line: 'Google Mail, or Google Workspace.', mark: 'G' },
      icloud: { name: 'iCloud', line: 'An @icloud.com, @me.com or @mac.com address.', mark: 'i' },
      fastmail: { name: 'Fastmail', line: 'Fastmail, with your own domain or theirs.', mark: 'F' },
      other: { name: 'Other', line: 'Any mailbox that offers IMAP.', mark: '@' },
    } satisfies Record<MailProvider, { name: string; line: string; mark: string }>,
    address: 'Address',
    password: 'App password',
    otherPassword: 'Password',
    /** One line on making the app password, and where. */
    how: {
      gmail: { text: 'Google wants an app password, not your usual one. 2-Step Verification must be on.', link: 'Make one', href: 'https://myaccount.google.com/apppasswords' },
      icloud: { text: 'Apple wants an app-specific password, made under Sign-In and Security.', link: 'How', href: 'https://support.apple.com/en-us/102654' },
      fastmail: { text: 'Fastmail wants an app password with Mail (IMAP/SMTP) access.', link: 'How', href: 'https://www.fastmail.help/hc/en-us/articles/360058752854' },
      other: null,
    } satisfies Record<MailProvider, { text: string; link: string; href: string } | null>,
    server: 'Server details',
    serverHint: 'Left empty, buddi tries imap. and smtp. at your domain.',
    imapHost: 'IMAP host',
    smtpHost: 'SMTP host',
    submit: 'Add it',
    reading: 'Mail Triage is reading it.',
    /** Saved before Mail Triage exists: its offer is on Home. */
    noTriage: 'Saved. Mail Triage starts reading once you accept it on Home.',
    later: 'More in Mail settings later.',
  },
  calendar: {
    sheet: 'Link your calendar',
    ask: 'Your calendar’s private link',
    google: 'Sign in with Google',
    googleLine: 'Reads and, when you approve, changes your Google calendars.',
    or: 'or paste a private link',
    field: 'Private link',
    placeholder: 'Paste the whole link',
    where: 'Where do I find it?',
    help: [
      { name: 'iCloud', text: 'In the Calendar app or at icloud.com/calendar, share the calendar, tick Public Calendar, then copy the link.' },
      { name: 'Google', text: 'Google Calendar on the web → Settings → pick the calendar → Integrate calendar → copy “Secret address in iCal format”.' },
      { name: 'Fastmail', text: 'Settings → Calendars → Share beside the calendar → turn on the iCal link for anyone with it → copy it.' },
    ],
    submit: 'Link it',
    starting: 'Starting…',
    continue: 'Continue to Google',
    waiting: 'Waiting for Google… This finishes by itself when Google sends you back.',
    reading: 'Signed in. Reading your calendars…',
    again: 'Try again',
    found: (n: number): string => `Found ${n} ${n === 1 ? 'calendar' : 'calendars'}.`,
    events: (n: number): string => `Found your calendar: ${n} ${n === 1 ? 'event' : 'events'}.`,
    later: 'More in Calendar settings later.',
  },
  bank: {
    sheet: 'Your bank',
    ask: 'Statements, not a bank sign-in',
    line: 'Finance never signs in to a bank, so nothing leaves this computer. Once we are done, hand me a statement — a PDF, a photo or your bank’s CSV export — and I read your accounts in.',
    ok: 'Got it',
  },
} as const;

/* ------------------------------------------------------------------ *
 * shared pieces
 * ------------------------------------------------------------------ */

function reason(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err);
}

/** The quiet line under the fields: checking, done, or why not. */
function Line({ state, children }: { state: 'busy' | 'good' | 'bad'; children: ReactNode }): JSX.Element {
  if (state === 'bad') {
    return (
      <p className="frs-line" data-tone="bad" role="alert">
        {children}
      </p>
    );
  }
  return (
    <div className="wiz-busy" role="status" aria-live="polite">
      <span className="wiz-pulse" data-done={state === 'good' ? 'true' : undefined} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{children}</span>
    </div>
  );
}

/** How long a success line stays before the sheet closes by itself. */
export const CLOSE_AFTER_MS = 1400;

/** Close shortly after `done` turns true; a sheet closed by hand meanwhile is left alone. */
function useCloseAfter(done: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!done) return undefined;
    const timer = window.setTimeout(() => latest.current(), CLOSE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [done]);
}

/** A field that takes the caret when its step appears. */
function useFocus<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => ref.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return ref;
}

/* ------------------------------------------------------------------ *
 * a mailbox
 * ------------------------------------------------------------------ */

/** Each provider's hosts, sent with the address so a custom domain on Fastmail or iCloud still lands right. */
const MAIL_HOSTS: Record<Exclude<MailProvider, 'other'>, { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number }> = {
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465 },
};

const PROVIDERS: MailProvider[] = ['gmail', 'icloud', 'fastmail', 'other'];

/**
 * "Which mailbox?", then only what that provider needs.
 *
 * Gmail is an app password too: the email plugin signs in with app passwords
 * only (its `xoauth2` mode is declared and not implemented), so there is no
 * Google sign-in to offer here.
 */
export function MailboxSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (address: string) => void }): JSX.Element {
  const [provider, setProvider] = useState<MailProvider | null>(null);
  return (
    <Sheet title={SHEETS.mailbox.sheet} onClose={onClose}>
      {provider === null ? (
        <div className="wiz-sheet-body">
          <h3 className="frs-ask">{SHEETS.mailbox.which}</h3>
          <div className="frs-choices" role="group" aria-label={SHEETS.mailbox.which}>
            {PROVIDERS.map((id) => {
              const words = SHEETS.mailbox.providers[id];
              return (
                <button key={id} type="button" className="wiz-opt frs-choice" onClick={() => setProvider(id)}>
                  <span className="frs-mark" data-provider={id} aria-hidden="true">
                    {words.mark}
                  </span>
                  <span className="frs-choice-text">
                    <span className="wiz-opt-title">{words.name}</span>
                    <span className="wiz-opt-line">{words.line}</span>
                  </span>
                  <Icon name="chevron-right" />
                </button>
              );
            })}
          </div>
          <p className="frs-later">{SHEETS.mailbox.later}</p>
        </div>
      ) : (
        <MailboxForm key={provider} provider={provider} onBack={() => setProvider(null)} onClose={onClose} onAdded={onAdded} />
      )}
    </Sheet>
  );
}

function MailboxForm({
  provider,
  onBack,
  onClose,
  onAdded,
}: {
  provider: MailProvider;
  onBack: () => void;
  onClose: () => void;
  onAdded: (address: string) => void;
}): JSX.Element {
  const first = useFocus<HTMLInputElement>();
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'good'; line: string } | { kind: 'bad'; line: string }>({ kind: 'idle' });
  useCloseAfter(state.kind === 'good', onClose);
  const words = SHEETS.mailbox.providers[provider];
  const how = SHEETS.mailbox.how[provider];
  const ready = address.trim() !== '' && password.trim() !== '' && state.kind !== 'busy' && state.kind !== 'good';

  const submit = (): void => {
    if (!ready) return;
    setState({ kind: 'busy' });
    const hosts =
      provider === 'other'
        ? { ...(imapHost.trim() ? { imapHost: imapHost.trim() } : {}), ...(smtpHost.trim() ? { smtpHost: smtpHost.trim() } : {}) }
        : MAIL_HOSTS[provider];
    void Promise.resolve()
      .then(() => api.pageAct('email', { tool: 'email.add_account', args: { address: address.trim(), password, ...hosts } }))
      .then((answer) => {
        const result = (answer.result ?? {}) as { address?: string; triage?: string };
        setPassword('');
        setState({ kind: 'good', line: result.triage === 'needs-agent' ? SHEETS.mailbox.noTriage : SHEETS.mailbox.reading });
        onAdded(result.address ?? address.trim().toLowerCase());
      })
      .catch((err: unknown) => setState({ kind: 'bad', line: reason(err) }));
  };

  return (
    <>
      <div className="wiz-sheet-body">
        <h3 className="frs-ask">
          <span className="frs-mark" data-provider={provider} aria-hidden="true">
            {words.mark}
          </span>
          {words.name}
        </h3>
        <form
          className="frs-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field label={SHEETS.mailbox.address}>
            <input ref={first} type="email" autoComplete="email" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field
            label={provider === 'other' ? SHEETS.mailbox.otherPassword : SHEETS.mailbox.password}
            hint={
              how ? (
                <>
                  {how.text}{' '}
                  <a href={how.href} target="_blank" rel="noreferrer">
                    {how.link}
                  </a>
                </>
              ) : undefined
            }
          >
            <input type="password" autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {provider === 'other' ? (
            <Details summary={SHEETS.mailbox.server}>
              <div className="frs-form">
                <p className="frs-later">{SHEETS.mailbox.serverHint}</p>
                <Field label={SHEETS.mailbox.imapHost}>
                  <input spellCheck={false} placeholder="imap.example.com" value={imapHost} onChange={(e) => setImapHost(e.target.value)} />
                </Field>
                <Field label={SHEETS.mailbox.smtpHost}>
                  <input spellCheck={false} placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
                </Field>
              </div>
            </Details>
          ) : null}
          {/* Enter submits; the visible button is in the foot. */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
        {state.kind === 'busy' ? <Line state="busy">{SHEETS.checking}</Line> : null}
        {state.kind === 'good' ? <Line state="good">{state.line}</Line> : null}
        {state.kind === 'bad' ? <Line state="bad">{state.line}</Line> : null}
        <p className="frs-later">{SHEETS.mailbox.later}</p>
      </div>
      <div className="ui-sheet-foot">
        <Toolbar>
          <Button variant="ghost" onClick={onBack} disabled={state.kind === 'busy'}>
            <Icon name="chevron-left" />
            {SHEETS.back}
          </Button>
          <Spacer />
          <Button variant="accent" disabled={!ready} onClick={submit}>
            {SHEETS.mailbox.submit}
          </Button>
        </Toolbar>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * a calendar
 * ------------------------------------------------------------------ */

interface CalendarSettings {
  googleAvailable?: boolean;
  calendars?: Array<{ id: string; name: string; group?: string }>;
}

interface SignInRow {
  id: string;
  url: string;
  state: 'waiting' | 'received' | 'done' | 'failed';
  note: string;
  problem: string;
}

/** How often the Google sign-in is asked how it stands: the settings page's own two seconds. */
export const SIGN_IN_POLL_MS = 2000;

/**
 * A Google sign-in prepared when the sheet opens is started again this often,
 * inside the ten minutes the host keeps one, so the address a press opens is
 * never one that has run out.
 */
export const SIGN_IN_PREPARE_MS = 8 * 60_000;

/** The name a pasted link is kept under, from where it points: never one already taken. */
export function nameForLink(link: string, taken: readonly string[]): string {
  let host = '';
  try {
    host = new URL(link.trim().replace(/^webcals?:\/\//i, 'https://')).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const base = /google\./.test(host)
    ? 'Google calendar'
    : /icloud\.com$|me\.com$/.test(host)
      ? 'iCloud calendar'
      : /fastmail\./.test(host)
        ? 'Fastmail calendar'
        : /outlook\.|office365\.|live\.com$/.test(host)
          ? 'Outlook calendar'
          : 'My calendar';
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/**
 * "Your calendar's private link": Google's sign-in first when this buddi can
 * run one, then the link — one field, the per-provider directions folded.
 */
export function CalendarSheet({ onClose, onLinked }: { onClose: () => void; onLinked: (line: string) => void }): JSX.Element {
  const field = useFocus<HTMLInputElement>();
  const [settings, setSettings] = useState<CalendarSettings | null>(null);
  const [link, setLink] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'busy'; line: string }
    | { kind: 'google'; signIn: SignInRow | null }
    | { kind: 'good'; line: string }
    | { kind: 'bad'; line: string }
  >({ kind: 'idle' });
  useCloseAfter(state.kind === 'good', onClose);

  const read = (): Promise<CalendarSettings> =>
    api.pageQuery<CalendarSettings>('calendar', 'settings').then((answer) => answer.data ?? {});

  useEffect(() => {
    let cancelled = false;
    read()
      .then((data) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) setSettings({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const succeed = (line: string): void => {
    setState({ kind: 'good', line });
    onLinked(line);
  };

  const before = settings?.calendars?.length ?? 0;
  const pasted = (): void => {
    if (link.trim() === '' || state.kind === 'busy' || state.kind === 'good') return;
    setState({ kind: 'busy', line: SHEETS.checking });
    const name = nameForLink(link, (settings?.calendars ?? []).map((c) => c.name));
    void Promise.resolve()
      .then(() => api.pageAct('calendar', { tool: 'calendar.add', args: { name, link: link.trim() } }))
      .then((answer) => {
        setLink('');
        const note = (answer.result as { note?: string } | undefined)?.note ?? '';
        const events = /(\d+) events? read/.exec(note);
        succeed(events ? SHEETS.calendar.events(Number(events[1])) : SHEETS.calendar.found(1));
      })
      .catch((err: unknown) => setState({ kind: 'bad', line: reason(err) }));
  };

  /*
   * ---- Google: prepared on open, so one press opens Google's page ----
   *
   * The sign-in is started as soon as the sheet knows Google is offered (and
   * again before it runs out), and its address kept: the press is then a
   * plain link to it, opened at once — fetching the address after the press
   * trips the browser's popup rule and took a second press. buddi.app hands
   * the new window to the default browser.
   */
  const [prepared, setPrepared] = useState<{ id: string; url: string } | null>(null);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const [round, setRound] = useState(0);
  /** Pressed: the prepared sign-in is the owner's now, never replaced underneath them. */
  const opened = useRef(false);
  const refresher = useRef<number | undefined>(undefined);
  const googleAvailable = settings?.googleAvailable === true;
  useEffect(() => {
    if (!googleAvailable) return undefined;
    let stopped = false;
    const prepare = async (): Promise<void> => {
      if (stopped || opened.current) return;
      try {
        await api.pageAct('calendar', { tool: 'calendar.google_sign_in', args: {} });
        const answer = await api.pageQuery<{ rows?: SignInRow[] }>('calendar', 'sign_in');
        if (stopped || opened.current) return;
        const row = answer.data?.rows?.[0];
        if (!row || row.state !== 'waiting' || !row.url) throw new Error('no address to open');
        setPrepared({ id: row.id, url: row.url });
        setPrepareFailed(false);
        refresher.current = window.setTimeout(() => void prepare(), SIGN_IN_PREPARE_MS);
      } catch {
        // The press starts it instead, the slower way.
        if (!stopped) {
          setPrepared(null);
          setPrepareFailed(true);
        }
      }
    };
    void prepare();
    return () => {
      stopped = true;
      window.clearTimeout(refresher.current);
    };
  }, [googleAvailable, round]);

  /** A sign-in that failed on Google's side: a fresh one is prepared for Try again. */
  const failed = (line: string): void => {
    setState({ kind: 'bad', line });
    opened.current = false;
    setPrepared(null);
    setRound((n) => n + 1);
  };

  /* ---- Google: wait for the owner's yes on Google's page, finish ---- */
  const [attempt, setAttempt] = useState(0);
  const waitingId = state.kind === 'google' ? (state.signIn?.id ?? null) : null;
  useEffect(() => {
    if (attempt === 0) return undefined;
    let stopped = false;
    let inFlight = false;
    let finishing = false;
    const stop = (): void => {
      stopped = true;
      window.clearInterval(timer);
    };
    const tick = (): void => {
      if (stopped || inFlight) return;
      inFlight = true;
      void api
        .pageQuery<{ rows?: SignInRow[] }>('calendar', 'sign_in')
        .then(async (answer) => {
          if (stopped) return;
          const row = answer.data?.rows?.[0] ?? null;
          if (!row) return;
          if (row.state === 'waiting') {
            setState((s) => (s.kind === 'google' && s.signIn?.url === row.url ? s : { kind: 'google', signIn: row }));
            return;
          }
          if (row.state === 'failed') {
            stop();
            failed(row.problem || row.note);
            return;
          }
          stop();
          if (row.state === 'received' && !finishing) {
            finishing = true;
            setState({ kind: 'busy', line: SHEETS.calendar.reading });
            await api.pageAct('calendar', { tool: 'calendar.google_finish', args: { id: row.id } });
          }
          const after = await read();
          await api.pageAct('calendar', { tool: 'calendar.google_dismiss', args: { id: row.id } }).catch(() => undefined);
          const added = (after.calendars?.length ?? 0) - before;
          succeed(SHEETS.calendar.found(added > 0 ? added : (after.calendars?.length ?? 0)));
        })
        .catch((err: unknown) => {
          stop();
          failed(reason(err));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const timer = window.setInterval(tick, SIGN_IN_POLL_MS);
    tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // One loop per sign-in attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /** The press on a prepared sign-in: the link opens Google's page by itself; this only starts waiting. */
  const openGoogle = (): void => {
    if (!prepared || state.kind === 'google') return;
    opened.current = true;
    window.clearTimeout(refresher.current);
    setState({ kind: 'google', signIn: { id: prepared.id, url: prepared.url, state: 'waiting', note: '', problem: '' } });
    setAttempt((n) => n + 1);
  };

  /** No prepared sign-in (preparing it failed): start one now; its link is a second press. */
  const google = (): void => {
    opened.current = true;
    window.clearTimeout(refresher.current);
    setState({ kind: 'busy', line: SHEETS.calendar.starting });
    void Promise.resolve()
      .then(() => api.pageAct('calendar', { tool: 'calendar.google_sign_in', args: {} }))
      .then(() => {
        setState({ kind: 'google', signIn: null });
        setAttempt((n) => n + 1);
      })
      .catch((err: unknown) => failed(reason(err)));
  };

  /**
   * Closed while Google was still being waited for, or with a prepared
   * sign-in never pressed: that sign-in is dropped, as Cancel on the settings
   * page does.
   */
  const close = (): void => {
    const drop = waitingId ?? (state.kind !== 'good' ? prepared?.id : undefined);
    window.clearTimeout(refresher.current);
    if (drop) void api.pageAct('calendar', { tool: 'calendar.google_cancel', args: { id: drop } }).catch(() => undefined);
    onClose();
  };

  const busy = state.kind === 'busy' || state.kind === 'google' || state.kind === 'good';
  /** The address the Google button opens: the one being waited for, else the prepared one. */
  const googleUrl = state.kind === 'google' ? state.signIn?.url : state.kind === 'busy' || state.kind === 'good' ? undefined : prepared?.url;
  /** Started by the press (nothing was prepared): its link is the second step, and says so. */
  const secondStep = state.kind === 'google' && prepared === null;
  return (
    <Sheet title={SHEETS.calendar.sheet} onClose={close}>
      <div className="wiz-sheet-body">
        <h3 className="frs-ask">{SHEETS.calendar.ask}</h3>
        {settings?.googleAvailable ? (
          <>
            <div className="frs-google">
              {googleUrl ? (
                <ButtonLink variant="accent" size="lg" href={googleUrl} target="_blank" rel="noreferrer" onClick={openGoogle}>
                  {secondStep ? SHEETS.calendar.continue : SHEETS.calendar.google}
                  <Icon name="external" />
                </ButtonLink>
              ) : (
                <Button variant="accent" size="lg" disabled={busy || !prepareFailed} onClick={google}>
                  {SHEETS.calendar.google}
                  <Icon name="external" />
                </Button>
              )}
              <span className="wiz-opt-line">{SHEETS.calendar.googleLine}</span>
            </div>
            <div className="frs-or">{SHEETS.calendar.or}</div>
          </>
        ) : null}
        <form
          className="frs-form"
          onSubmit={(event) => {
            event.preventDefault();
            pasted();
          }}
        >
          <Field label={SHEETS.calendar.field}>
            <input
              ref={field}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={SHEETS.calendar.placeholder}
              value={link}
              disabled={busy}
              onChange={(e) => setLink(e.target.value)}
            />
          </Field>
          <Details summary={SHEETS.calendar.where}>
            <dl className="frs-help">
              {SHEETS.calendar.help.map((item) => (
                <div key={item.name}>
                  <dt>{item.name}</dt>
                  <dd>{item.text}</dd>
                </div>
              ))}
            </dl>
          </Details>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
        {state.kind === 'busy' ? <Line state="busy">{state.line}</Line> : null}
        {state.kind === 'google' ? <Line state="busy">{SHEETS.calendar.waiting}</Line> : null}
        {state.kind === 'good' ? <Line state="good">{state.line}</Line> : null}
        {state.kind === 'bad' ? <Line state="bad">{state.line}</Line> : null}
        <p className="frs-later">{SHEETS.calendar.later}</p>
      </div>
      <div className="ui-sheet-foot">
        <Toolbar align="end">
          <Button variant="accent" disabled={busy || link.trim() === ''} onClick={pasted}>
            {SHEETS.calendar.submit}
          </Button>
        </Toolbar>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * the bank
 * ------------------------------------------------------------------ */

/**
 * The bank: one line and one button. The finance plugin has no connect flow
 * and no page of its own — it reads statements an agent is handed — so there
 * is no first question to trim down to, and nothing to open.
 */
export function BankSheet({ onClose, onUnderstood }: { onClose: () => void; onUnderstood: () => void }): JSX.Element {
  return (
    <Sheet title={SHEETS.bank.sheet} onClose={onClose}>
      <div className="wiz-sheet-body">
        <h3 className="frs-ask">{SHEETS.bank.ask}</h3>
        <p className="frs-text">{SHEETS.bank.line}</p>
      </div>
      <div className="ui-sheet-foot">
        <Toolbar align="end">
          <Button
            variant="accent"
            onClick={() => {
              onUnderstood();
              onClose();
            }}
          >
            {SHEETS.bank.ok}
          </Button>
        </Toolbar>
      </div>
    </Sheet>
  );
}
