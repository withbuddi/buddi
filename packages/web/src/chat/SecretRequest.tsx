/**
 * Secrets in the sign-in flow, in place (buddi-design `SecretsSignin.jsx`,
 * docs/owner-secrets.md §6).
 *
 * An agent on a sign-in form with nothing saved for the site calls
 * `secret.request`; the card stands in the dock with the fields it saw as
 * inputs. What the owner types goes to the secrets API (`api.saveSecretSet`)
 * and nowhere else: never a chat message, never the transcript. The kit's
 * states are all here:
 *
 *   card        No saved sign-in for <site>: the fields inline, the site chip,
 *               I'll sign in myself · More options · Save and fill, "Save only"
 *   cardlocked  the same card after a save the locked vault refused
 *   sheet       More options: one form for the site over the chat, the page
 *               beside it; a code field and more fields; Cancel · Save and fill
 *   locked      the same sheet after a save the locked vault refused
 *   saved       (SecretSetDock) the fill approval for a saved set
 */
import { useState } from 'react';
import { api, ApiError, type ApprovalRow, type BrowserStatus, type SecretSetField } from '../api';
import { screenshotUrl, tileLetter } from '../canvas/views/BrowserView';
import { settingsRoute } from '../routes';
import { Button, ErrorBanner, Field, Icon, Notice, Sheet, Spacer, Toolbar } from '../ui';
import type { ChatQuestion, SecretRequestCard, SecretRequestField } from './types';

/** The sign-in card this question is, or null for any other question. */
export function secretRequestOf(question: ChatQuestion | null | undefined): SecretRequestCard | null {
  const request = question?.request;
  return request && request.kind === 'secret.request' ? request : null;
}

/** "Wikipedia": the site's name as a secret's name starts (the gateway's `secretNameFor`). */
function siteWord(site: string): string {
  const labels = site.split('.').filter(Boolean);
  if (labels.length < 2) return site;
  const short = labels.length >= 3 && /^(co|com|net|org|gov|ac|edu)$/.test(labels[labels.length - 2]!) ? labels[labels.length - 3]! : labels[labels.length - 2]!;
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** "Wikipedia password": the name a field is saved under. */
function nameFor(site: string, label: string): string {
  const field = label.trim();
  return `${siteWord(site)} ${field.charAt(0).toLowerCase()}${field.slice(1)}`;
}

/** "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A field whose value is masked: anything but a username. */
const masked = (field: Pick<SecretRequestField, 'kind'>): boolean => field.kind !== 'username';

/** A masked value with Show / Hide inside the field (the kit's `SsSecretInput`). */
export function SecretInput({ value, onChange, label, autoFocus, disabled }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const [shown, setShown] = useState(false);
  return (
    <span className="ss-reveal">
      <input
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      <button type="button" className="ss-reveal-btn" aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</button>
    </span>
  );
}

/** The one wording for a save the vault refused, in the card and in the sheet. */
function VaultLocked(): JSX.Element {
  return (
    <Notice tone="critical" title="Nothing was saved: the vault is locked.">
      The keychain on this Mac is locked, so buddi can’t store anything. Unlock this Mac, then press Save and fill again. What you typed is still here.
    </Notice>
  );
}

/** One extra row of the sheet: a label the owner names and its value. */
interface ExtraField { label: string; value: string }

/** Everything typed so far, carried between the card and the sheet. */
interface Typed {
  values: string[];
  totp: boolean;
  seed: string;
  extra: ExtraField[];
}

/** The fields to post: what the agent saw, then the code, then the owner's own rows. Blank ones are left out by the server. */
function fieldsOf(card: SecretRequestCard, typed: Typed): SecretSetField[] {
  return [
    ...card.fields.map((field, index) => ({ label: field.label, kind: field.kind, value: typed.values[index] ?? '' })),
    ...(typed.totp ? [{ label: 'Code', kind: 'totp' as const, value: typed.seed }] : []),
    ...typed.extra.filter((row) => row.label.trim() !== '').map((row) => ({ label: row.label.trim(), kind: 'other' as const, value: row.value })),
  ];
}

/**
 * The card in the dock, and the sheet behind More options. `container` is
 * the chat column the sheet is drawn in on a desk; on a phone it covers the
 * screen and folds the page in at its top.
 */
export function SecretRequestDock({ question, card, phone, container, page, disabled, onSettled }: {
  question: ChatQuestion;
  card: SecretRequestCard;
  phone: boolean;
  container: HTMLElement | null;
  /** The page the agent has open, for the sheet's "Show the page" on a phone. */
  page?: BrowserStatus | undefined;
  disabled: boolean;
  /** The card was answered: the thread reads again. */
  onSettled: () => void;
}): JSX.Element {
  const [typed, setTyped] = useState<Typed>({ values: card.fields.map(() => ''), totp: false, seed: '', extra: [] });
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState<null | 'fill' | 'save' | 'self'>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = card.agentName ?? 'The agent';

  const save = (then: 'fill' | 'save'): void => {
    setBusy(then);
    setError(null);
    api.saveSecretSet({ questionId: question.id, then, fields: fieldsOf(card, typed) })
      .then(() => onSettled())
      .catch((err: unknown) => {
        setBusy(null);
        if (err instanceof ApiError && (err.detail as { locked?: unknown } | null)?.locked === true) {
          setLocked(true);
          return;
        }
        setLocked(false);
        setError(err instanceof ApiError ? err.message : String(err));
      });
  };
  const self = (): void => {
    setBusy('self');
    setError(null);
    api.declineSecretRequest(question.id, 'sign-in-myself')
      .then(() => onSettled())
      .catch((err: unknown) => {
        setBusy(null);
        setError(err instanceof ApiError ? err.message : String(err));
      });
  };
  const off = disabled || busy !== null;
  const set = (index: number) => (value: string): void => setTyped((now) => ({ ...now, values: now.values.map((v, i) => (i === index ? value : v)) }));

  return (
    <>
      <section className="wb-question br-ask ss-card" data-phone={phone ? 'true' : undefined} aria-label={`No saved sign-in for ${card.site}`} data-testid="secret-request">
        <div className="br-ask-head">
          <span className="wb-question-kicker">Needs you</span>
          <strong>No saved sign-in for {card.site}</strong>
          <span className="br-ask-line">{agent} stopped at the sign-in form. Type these once; buddi keeps them and fills them in, and {agent} carries on.</span>
        </div>
        <div className="wb-dock-section ss-inline">
          <div className="ss-inline-fields">
            {card.fields.map((field, index) => (
              <Field key={field.label} label={field.label}>
                {masked(field)
                  ? <SecretInput value={typed.values[index] ?? ''} onChange={set(index)} label={field.label} disabled={off} />
                  : <input value={typed.values[index] ?? ''} onChange={(event) => set(index)(event.target.value)} autoComplete="off" spellCheck={false} autoFocus={!phone && !locked && index === 0} disabled={off} />}
              </Field>
            ))}
          </div>
          <span className="ss-place-row"><span className="ss-site-chip"><Icon name="globe" size={14} />{card.site}</span><span className="ss-place-text">only on this site · {agent} never sees them</span></span>
          {card.warnings?.map((line) => <p key={line} className="ss-warning" role="note">{line}</p>)}
          {locked && !sheet ? <VaultLocked /> : null}
          <ErrorBanner message={sheet ? null : error} />
        </div>
        <div className="wb-dock-section">
          <Toolbar align="end">
            <Button size="sm" variant="ghost" disabled={off} onClick={self}>{busy === 'self' ? 'Handing it over…' : 'I’ll sign in myself'}</Button>
            <Button size="sm" disabled={off} onClick={() => setSheet(true)}>More options</Button>
            <Button size="sm" variant="accent" disabled={off} onClick={() => save('fill')}>{busy === 'fill' ? 'Saving…' : 'Save and fill'}</Button>
          </Toolbar>
          <p className="ss-save-only">Rather sign in yourself this time? <button type="button" className="wb-link" disabled={off} onClick={() => save('save')}>Save only</button> keeps them for next time and hands you the page.</p>
        </div>
      </section>
      {sheet ? (
        <SecretRequestSheet
          card={card}
          typed={typed}
          setTyped={setTyped}
          phone={phone}
          container={phone ? null : container}
          page={page}
          locked={locked}
          error={error}
          busy={busy}
          disabled={off}
          onClose={() => setSheet(false)}
          onSave={save}
        />
      ) : null}
    </>
  );
}

/** The site, prefilled, as a chip: where these values may go and nowhere else. */
function Place({ site }: { site: string }): JSX.Element {
  return (
    <div className="ss-place">
      <span className="ui-field-label">Where they go</span>
      <span className="ss-place-row">
        <span className="ss-site-chip"><Icon name="globe" size={14} />{site}</span>
        <span className="ss-place-text">only on this site</span>
      </span>
      <span className="ui-field-hint">Agents can use them only here. Anywhere else, buddi holds them back and the row in Keys and secrets says so. Filling asks you the first time, then not again.</span>
    </div>
  );
}

/** The sheet: one form for the site, several fields. Over the chat; the page stays beside it. */
function SecretRequestSheet({ card, typed, setTyped, phone, container, page, locked, error, busy, disabled, onClose, onSave }: {
  card: SecretRequestCard;
  typed: Typed;
  setTyped: (update: (now: Typed) => Typed) => void;
  phone: boolean;
  container: HTMLElement | null;
  page?: BrowserStatus | undefined;
  locked: boolean;
  error: string | null;
  busy: null | 'fill' | 'save' | 'self';
  disabled: boolean;
  onClose: () => void;
  onSave: (then: 'fill' | 'save') => void;
}): JSX.Element {
  const [shown, setShown] = useState(false);
  const agent = card.agentName ?? 'The agent';
  const names = [
    ...card.fields.map((field) => nameFor(card.site, field.label)),
    ...(typed.totp ? [nameFor(card.site, 'Code')] : []),
    ...typed.extra.filter((row) => row.label.trim() !== '').map((row) => nameFor(card.site, row.label)),
  ];
  const picture = page ? screenshotUrl(page) : null;
  const title = page?.page?.title ?? card.page?.title ?? card.site;
  return (
    <Sheet title={`Sign-in for ${card.site}`} onClose={onClose} container={container}>
      <div className="ss-sheet">
        {phone ? (
          <div className="ss-peek">
            <div className="ss-peek-head">
              <span className="br-tile" aria-hidden="true">{tileLetter(page) === '·' ? card.site.charAt(0).toUpperCase() : tileLetter(page)}</span>
              <span className="br-head-text"><span className="br-head-title">{title}</span><span className="br-head-line">The page {agent} has open</span></span>
              <Button size="sm" variant="ghost" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? 'Hide the page' : 'Show the page'}</Button>
            </div>
            {shown ? <div className="br-frame ss-peek-frame" data-state="waiting">{picture ? <img src={picture} alt={`The page ${agent} has open`} /> : <p className="br-frame-wait">No picture of the page yet.</p>}</div> : null}
          </div>
        ) : null}
        <p className="ss-note">{agent} saw these fields on the page. Type them once; buddi keeps them and fills them in for you here.</p>
        <div className="ss-form">
          {card.fields.map((field, index) => (
            <Field key={field.label} label={field.label}>
              {masked(field)
                ? <SecretInput value={typed.values[index] ?? ''} onChange={(value) => setTyped((now) => ({ ...now, values: now.values.map((v, i) => (i === index ? value : v)) }))} label={field.label} disabled={disabled} />
                : <input value={typed.values[index] ?? ''} onChange={(event) => { const value = event.target.value; setTyped((now) => ({ ...now, values: now.values.map((v, i) => (i === index ? value : v)) })); }} autoComplete="off" spellCheck={false} autoFocus={!phone && !locked && index === 0} disabled={disabled} />}
            </Field>
          ))}
          {typed.totp ? (
            <div className="ss-extra">
              <Field label="Authenticator (TOTP seed)" hint="The setup key the site showed when you turned on two-step sign-in. buddi fills the current code, never the seed.">
                <SecretInput value={typed.seed} onChange={(seed) => setTyped((now) => ({ ...now, seed }))} label="Authenticator (TOTP seed)" disabled={disabled} />
              </Field>
              <Button size="sm" variant="ghost" onClick={() => setTyped((now) => ({ ...now, totp: false, seed: '' }))}>Remove</Button>
            </div>
          ) : null}
          {typed.extra.map((row, index) => (
            <div key={index} className="ss-extra ss-extra-pair">
              <Field label="Label"><input value={row.label} placeholder="Security answer" onChange={(event) => { const label = event.target.value; setTyped((now) => ({ ...now, extra: now.extra.map((r, i) => (i === index ? { ...r, label } : r)) })); }} disabled={disabled} /></Field>
              <Field label="Value"><SecretInput value={row.value} onChange={(value) => setTyped((now) => ({ ...now, extra: now.extra.map((r, i) => (i === index ? { ...r, value } : r)) }))} label="Value" disabled={disabled} /></Field>
              <Button size="sm" variant="ghost" onClick={() => setTyped((now) => ({ ...now, extra: now.extra.filter((_, i) => i !== index) }))}>Remove</Button>
            </div>
          ))}
          <Toolbar>
            {typed.totp ? null : <Button size="sm" variant="ghost" onClick={() => setTyped((now) => ({ ...now, totp: true }))}><Icon name="plus" size={12} /> Add a code field</Button>}
            <Button size="sm" variant="ghost" onClick={() => setTyped((now) => ({ ...now, extra: [...now.extra, { label: '', value: '' }] }))}><Icon name="plus" size={12} /> Add another field</Button>
          </Toolbar>
        </div>
        <div className="ss-notes">
          <Place site={card.site} />
          {card.warnings?.map((line) => <p key={line} className="ss-warning" role="note">{line}</p>)}
          <p className="ss-note">Kept in the vault and never shown again, not even here. {agent} never sees them: buddi types them into the page itself.</p>
          <p className="ss-note">Saved as {listed(names)} in Keys and secrets.</p>
        </div>
      </div>
      <div className="ss-sheet-foot">
        {locked ? <VaultLocked /> : null}
        <ErrorBanner message={error} />
        <Toolbar align="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={disabled} onClick={() => onSave('fill')}>{busy === 'fill' ? 'Saving…' : 'Save and fill'}</Button>
        </Toolbar>
        <p className="ss-save-only">Rather sign in yourself this time? <button type="button" className="wb-link" disabled={disabled} onClick={() => onSave('save')}>Save only</button> keeps them for next time and hands you the page.</p>
      </div>
    </Sheet>
  );
}

/** "Log in · Wikipedia" → "Log in " (with its space), for "the Log in page"; nothing when there is no title. */
function pageWord(title: string | undefined): string {
  const first = (title ?? '').split(/\s[·|–—-]\s/)[0]?.trim() ?? '';
  return first && first.length <= 40 ? `${first} ` : '';
}

/** The set a `secrets.use_set` approval names: its site and each secret with the field it goes into. */
export function secretSetOf(action: ApprovalRow | null): { site: string; items: Array<{ secret: string; field?: string }> } | null {
  if (!action || action.tool !== 'secrets.use_set') return null;
  const args = action.canonicalArgs as { site?: unknown; items?: unknown } | null;
  if (!args || typeof args.site !== 'string' || !Array.isArray(args.items)) return null;
  const items = (args.items as Array<Record<string, unknown>>)
    .filter((item) => typeof item.secret === 'string')
    .map((item) => ({ secret: String(item.secret), ...(typeof item.field === 'string' ? { field: item.field } : {}) }));
  return items.length > 0 ? { site: args.site, items } : null;
}

/**
 * The saved card: an agent asked to fill a set saved together, the first time
 * on its site — one approval for the set, in the approval card's shape.
 */
export function SecretSetDock({ set, agentName, pageTitle, phone, busy, error, onFill, onSelf }: {
  set: NonNullable<ReturnType<typeof secretSetOf>>;
  agentName: string;
  /** The page's title ("Log in · Wikipedia"): the card says "the Log in page". */
  pageTitle?: string;
  phone: boolean;
  busy: 'approve' | 'reject' | null;
  error: string | null;
  onFill: () => void;
  onSelf: () => void;
}): JSX.Element {
  return (
    <section className="wb-question ss-card ss-saved" data-phone={phone ? 'true' : undefined} aria-label="Approval needed" data-testid="secret-set-dock">
      <div className="br-ask-head">
        <span className="wb-question-kicker">Needs your OK</span>
        <strong><span className="ss-saved-mark" aria-hidden="true">✓</span>Saved {set.items.length} secret{set.items.length === 1 ? '' : 's'} for {set.site}</strong>
      </div>
      <div className="wb-dock-section">
        <ul className="ss-set" aria-label="What will be filled">
          {set.items.map((item) => (
            <li key={item.secret}><Icon name="key" size={14} /><span className="ss-set-name">{item.secret}</span>{item.field ? <span className="ss-set-into">into {item.field}</span> : null}</li>
          ))}
        </ul>
        <div className="wb-dock-where">On {set.site}, the {pageWord(pageTitle)}page {agentName} has open. {agentName} never sees them; buddi types them in.</div>
        <ErrorBanner message={error} />
      </div>
      <div className="wb-dock-section">
        <Toolbar align="end">
          <a className="wb-link ss-quiet-link" href={settingsRoute('secrets')}>Edit in Keys and secrets</a>
          <Spacer />
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onSelf}>I’ll sign in myself</Button>
          <Button size="sm" variant="accent" disabled={busy !== null} onClick={onFill}>{busy === 'approve' ? 'Filling…' : 'Fill them in'}</Button>
        </Toolbar>
      </div>
    </section>
  );
}
