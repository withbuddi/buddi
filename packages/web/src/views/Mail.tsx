/**
 * Mail: the conversations, and the drafts waiting on them (docs/specs/email.md §8).
 *
 * A place of its own, not a block on the settings page. Everything under
 * Settings → Email is configuration read once and then rarely; this is a
 * working surface — a message list, an editor with five fields and a textarea,
 * and an approval card that dispatches mail — and the owner opens it daily. The
 * thread id lives in the address (`#/email/<threadId>`), so a conversation is
 * something that can be linked to, come back to, and reached with the browser's
 * own Back.
 *
 * The owner's half of the lifecycle is here. An agent writes a draft; the owner
 * reads the conversation it answers, edits it, throws it away, or sends it —
 * and "sends it" means *proposes* it: Send records the `email.send` action by
 * the same path an agent takes, and the approval card appears with the identity
 * select on it. Nothing on this page reaches SMTP.
 *
 * Three things the page has to say plainly, because each of them is a way mail
 * goes wrong quietly:
 *
 *  - a **draft** pill on a conversation, so a reply waiting on the owner is
 *    visible without opening anything;
 *  - a draft whose dispatch was never confirmed is **not** an ordinary editable
 *    draft. It is drawn as a critical notice with every action taken away: the
 *    message may already be on the wire, and a second Send is how the same
 *    letter goes out twice;
 *  - a save that lost a race is shown as what is actually stored now, rather
 *    than reported as saved.
 */
import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type ApprovalRow,
  type EmailAttachment,
  type EmailDraftRow,
  type EmailMessageBody,
  type EmailSearchHit,
  type EmailSearchQuery,
  type EmailThreadRow,
} from '../api';
import { downloadUrl, formatBytes } from '../chat/attachments';
import { fmtRelative } from '../format';
import { mailRoute, parseMailRoute, settingsRoute } from '../routes';
import type { PlaceProps } from '../App';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  List,
  ListRow,
  Notice,
  PageFrame,
  Panel,
  Pill,
  Section,
  Spacer,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';
import { ApprovalCard, useDecide } from './parts/ApprovalCard';

/** The fields of the editor. All of them, because a save writes all of them. */
interface EditState {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
}

function editStateOf(draft: EmailDraftRow): EditState {
  return {
    to: draft.to.join(', '),
    cc: draft.cc.join(', '),
    bcc: draft.bcc.join(', '),
    subject: draft.subject,
    bodyText: draft.bodyText,
  };
}

/** A comma-or-space separated list of addresses, as a list. */
export function addressesOf(text: string): string[] {
  return text
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** What the page says about where a draft is in its life. */
export function draftStatusLine(draft: EmailDraftRow): string {
  const who = draft.editedBy === 'owner' ? 'you' : draft.createdByAgent;
  const when = draft.updatedAt ? fmtRelative(draft.updatedAt) : 'at some point';
  switch (draft.status) {
    case 'edited':
      return `Edited by you, ${when}. Written by ${draft.createdByAgent}.`;
    case 'sent':
      return `Sent ${draft.sentAt ? fmtRelative(draft.sentAt) : when}. Written by ${draft.createdByAgent}.`;
    case 'discarded':
      return `Discarded ${when}. Written by ${draft.createdByAgent}.`;
    case 'lapsed':
      return `Lapsed ${when} — nothing touched it for a fortnight, so it is no longer sendable. Written by ${draft.createdByAgent}.`;
    default:
      return `Written by ${who}, ${when}.`;
  }
}

/**
 * One live draft, editable.
 *
 * Discard, then a spacer, then Save and Send: the act that leads somewhere
 * irreversible is right-most, and the caveat about it wraps below rather than
 * crowding the button.
 */
export function DraftEditor({
  draft,
  onChanged,
  onProposed,
}: {
  draft: EmailDraftRow;
  onChanged: () => void;
  onProposed: (actionId: string) => void;
}): JSX.Element {
  const [edit, setEdit] = useState<EditState>(() => editStateOf(draft));
  const [busy, setBusy] = useState<'save' | 'discard' | 'send' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /*
   * What is on screen follows what is stored, whenever the stored version
   * moves. Without this the editor keeps the text it mounted with — so a page
   * left open while an agent rewrote the draft would show the old words, and
   * Save would be the owner unknowingly putting them back. The route refuses
   * that save on the version precondition; this is what stops it from being
   * proposed in the first place.
   */
  useEffect(() => {
    setEdit(editStateOf(draft));
    setSaved(false);
  }, [draft.updatedAt, draft.id]);

  const set = (patch: Partial<EditState>): void => {
    setSaved(false);
    setEdit((current) => ({ ...current, ...patch }));
  };

  const run = (what: 'save' | 'discard' | 'send', call: () => Promise<unknown>): void => {
    setBusy(what);
    setFailed(null);
    void call()
      .then((result) => {
        if (what === 'save') setSaved(true);
        if (what === 'send') onProposed((result as { actionId: string }).actionId);
        onChanged();
      })
      .catch((err: unknown) => {
        setFailed(err instanceof ApiError ? err.message : String(err));
        // A refusal is usually a race, and the answer carries what is really
        // stored: reload so the editor redraws from it rather than from the
        // text that lost.
        onChanged();
      })
      .finally(() => setBusy(null));
  };

  const editable = draft.live;

  return (
    <Card
      title={edit.subject || '(no subject)'}
      meta={
        <>
          <Pill tone={draft.status === 'edited' ? 'good' : undefined}>{draft.status}</Pill>
          <span className="muted">{draftStatusLine(draft)}</span>
        </>
      }
    >
      <ErrorBanner message={failed} />
      {draft.unresolved ? (
        <Notice tone="critical" role="alert" title="This was dispatched and never confirmed">
          buddi handed this message to the mail server and never got an answer, so whether it went
          out is genuinely unknown. Check the mailbox — the Sent folder and the recipient — before
          sending anything like it again. Nothing here can be edited, discarded or sent until you
          have.
          {draft.sendError ? <> The server said: {draft.sendError}</> : null}
        </Notice>
      ) : null}
      {saved ? (
        <Notice tone="good" role="status">
          Saved. These are your words now — no agent will write over them, and a send you approved
          before this edit will refuse rather than go out with the old text.
        </Notice>
      ) : null}
      {editable || draft.unresolved ? null : (
        <Notice>
          This draft is {draft.status} and cannot be edited or sent. It is kept so you can read what
          was proposed.
        </Notice>
      )}
      <Stack gap="sm">
        <Field label="To">
          <input value={edit.to} disabled={!editable} onChange={(e) => set({ to: e.target.value })} />
        </Field>
        <Field label="Cc">
          <input value={edit.cc} disabled={!editable} onChange={(e) => set({ cc: e.target.value })} />
        </Field>
        <Field label="Bcc" hint="Shown in full on the approval card before anything is sent.">
          <input value={edit.bcc} disabled={!editable} onChange={(e) => set({ bcc: e.target.value })} />
        </Field>
        <Field label="Subject">
          <input
            value={edit.subject}
            disabled={!editable}
            onChange={(e) => set({ subject: e.target.value })}
          />
        </Field>
        <Field label="Body">
          <textarea
            rows={12}
            value={edit.bodyText}
            disabled={!editable}
            onChange={(e) => set({ bodyText: e.target.value })}
          />
        </Field>
      </Stack>
      {editable ? (
        <Toolbar>
          <Button
            variant="danger"
            disabled={busy !== null}
            onClick={() => run('discard', () => api.discardEmailDraft(draft.id))}
          >
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </Button>
          <span className="ui-toolbar-spacer" />
          <Button
            disabled={busy !== null}
            onClick={() =>
              run('save', () =>
                api.saveEmailDraft(draft.id, {
                  to: addressesOf(edit.to),
                  cc: addressesOf(edit.cc),
                  bcc: addressesOf(edit.bcc),
                  subject: edit.subject,
                  bodyText: edit.bodyText,
                  // The version this editor loaded. A save that lost a race is
                  // refused rather than allowed to overwrite; the route refuses
                  // a save that carries no version at all.
                  updatedAt: draft.updatedAt ?? '',
                }),
              )
            }
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
          <Button
            variant="accent"
            disabled={busy !== null}
            onClick={() => run('send', () => api.sendEmailDraft(draft.id))}
          >
            {busy === 'send' ? 'Proposing…' : 'Send'}
          </Button>
          <p className="ui-toolbar-note">
            Send does not send: it puts the whole envelope in front of you to approve, and that card
            is where you choose which of your addresses it leaves from. Save first if you have edited
            anything — the card is bound to what is stored.
          </p>
        </Toolbar>
      ) : null}
    </Card>
  );
}

/**
 * The attachments of an opened message (docs/specs/email.md §10).
 *
 * The bytes were never downloaded at ingest — what is stored is a listing —
 * so each row is either a Fetch button or, once somebody has fetched it, a
 * link to the file in the library. The button is on the right, where every
 * other action on this page is, and a refusal (too big, a program, mail that
 * is no longer on the server) is shown as the sentence the tool wrote rather
 * than as a failed request.
 */
export function AttachmentList({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: EmailAttachment[];
}): JSX.Element | null {
  const [held, setHeld] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const fetchOne = (index: number): void => {
    setBusy(index);
    setFailed(null);
    void api
      .fetchEmailAttachment(messageId, index)
      .then((result) => {
        if (result.artifactId) setHeld((current) => ({ ...current, [index]: result.artifactId as string }));
      })
      .catch((err: unknown) => setFailed(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  return (
    <Section title={attachments.length === 1 ? 'Attachment' : 'Attachments'}>
      <ErrorBanner message={failed} />
      <List>
        {attachments.map((attachment) => {
          const artifactId = held[attachment.index] ?? attachment.artifactId;
          return (
            <ListRow
              key={attachment.index}
              title={attachment.filename ?? 'Unnamed file'}
              sub={`${attachment.mime} · ${formatBytes(attachment.sizeBytes)}`}
              side={
                artifactId ? (
                  <a href={downloadUrl(artifactId)}>Download</a>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => fetchOne(attachment.index)}
                    disabled={busy === attachment.index}
                  >
                    {busy === attachment.index ? 'Fetching…' : 'Fetch'}
                  </Button>
                )
              }
            />
          );
        })}
      </List>
    </Section>
  );
}

/** One message, opened: the body arrives on request, not with the list. */
function MessageRow({ id, from, snippet, direction, date, timezone }: {
  id: string;
  from: string;
  snippet: string;
  direction: 'in' | 'out';
  date: string | null;
  timezone: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<EmailMessageBody | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && !body) {
      void api
        .emailMessage(id)
        .then((result) => setBody(result.message))
        .catch((err: unknown) => setFailed(err instanceof ApiError ? err.message : String(err)));
    }
  };

  return (
    <ListRow
      title={from}
      sub={
        open ? (
          <>
            <ErrorBanner message={failed} />
            <span className="wb-doc">
              {body === null
                ? 'Loading…'
                : body.purged
                  ? 'The body of this message has been purged under your retention setting. Its headers are kept.'
                  : (body.bodyText ?? '')}
            </span>
            {body ? <AttachmentList messageId={id} attachments={body.attachments} /> : null}
          </>
        ) : (
          snippet
        )
      }
      side={
        <>
          <Pill tone={direction === 'out' ? 'good' : undefined}>
            {direction === 'out' ? 'you wrote' : 'they wrote'}
          </Pill>{' '}
          <span className="muted" title={date ?? undefined}>
            {date ? fmtRelative(date) : ''}
          </span>{' '}
          <Button variant="ghost" onClick={toggle} aria-expanded={open}>
            {open ? 'Hide' : 'Read'}
          </Button>
        </>
      }
    />
  );
}

/** One conversation: its messages, then the drafts answering them. */
export function EmailThread({
  threadId,
  timezone,
  onBack,
}: {
  threadId: string;
  timezone: string;
  onBack: () => void;
}): JSX.Element {
  const view = useAsync(() => api.emailThread(threadId), [threadId]);
  const [proposed, setProposed] = useState<ApprovalRow | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const decide = useDecide(() => {
    view.reload();
    setProposed(null);
  });

  const openApproval = (actionId: string): void => {
    void api
      .approval(actionId)
      .then((row) => setProposed(row))
      .catch(() => setProposed(null));
  };

  const detail = view.data;
  return (
    <Stack divided>
      <Section
        title={detail?.thread.subject || 'Conversation'}
        aside={
          <Button variant="ghost" onClick={onBack}>
            All conversations
          </Button>
        }
      >
        <ErrorBanner message={view.error ?? decide.failure} />
        {!detail ? (
          <Empty>Loading…</Empty>
        ) : detail.messages.length === 0 ? (
          <Empty>No messages have been synced for this conversation yet.</Empty>
        ) : (
          <List>
            {detail.messages.map((message) => (
              <MessageRow
                key={message.id}
                id={message.id}
                from={message.from}
                snippet={message.snippet}
                direction={message.direction}
                date={message.date}
                timezone={timezone}
              />
            ))}
          </List>
        )}
      </Section>

      <Section title="Drafts">
        {!detail ? null : detail.drafts.length === 0 ? (
          <Empty>
            No draft is waiting here. Ask an agent to draft a reply and it will appear under the
            conversation.
          </Empty>
        ) : (
          <Stack gap="lg">
            {detail.drafts.map((draft) => (
              <DraftEditor
                key={draft.id}
                draft={draft}
                onChanged={() => view.reload()}
                onProposed={openApproval}
              />
            ))}
          </Stack>
        )}
        {proposed ? (
          <Stack gap="lg">
            <Notice>
              Nothing has been sent. This is the envelope, exactly as it will go out — approve it to
              send it, and pick the address it leaves from here.
            </Notice>
            <ApprovalCard
              action={proposed}
              timezone={timezone}
              busy={decide.busy === proposed.id}
              onDecide={(id, decision, scope, choices) =>
                void decide.decide(id, decision, scope, choices)
              }
            />
          </Stack>
        ) : null}
        {decide.note ? (
          <Notice tone="good" role="status">
            {decide.note}
          </Notice>
        ) : null}
      </Section>

      {detail && detail.older.length > 0 ? (
        <Section
          title="Older drafts"
          aside={
            <Button variant="ghost" onClick={() => setShowOlder((v) => !v)} aria-expanded={showOlder}>
              {showOlder ? 'Hide' : `Show ${detail.older.length}`}
            </Button>
          }
        >
          {showOlder ? (
            <List>
              {detail.older.map((draft) => (
                <ListRow
                  key={draft.id}
                  title={draft.subject || '(no subject)'}
                  sub={draftStatusLine(draft)}
                  side={<Pill>{draft.status}</Pill>}
                />
              ))}
            </List>
          ) : null}
        </Section>
      ) : null}
    </Stack>
  );
}

/**
 * The search field over the conversation list (docs/specs/email.md §9).
 *
 * Four filters and a phrase, and not one more: from, since, until and "has
 * attachments" are the ones that answer a question the owner actually has in
 * front of a mailbox — "what did the accountant send me in March", "which of
 * these had the invoice on it". `thread` and `direction` exist on the tool
 * because an agent reasons with them; on this page the thread is what a result
 * *opens*, so offering it as a filter would be a field for narrowing to the
 * thing you are about to click.
 *
 * It searches on submit rather than on every keystroke. A substring search
 * over bodies is not free, and a page that fires one per letter typed spends
 * the mailbox's budget on prefixes nobody meant.
 */
export function MailSearch(): JSX.Element {
  const [form, setForm] = useState<EmailSearchQuery>({});
  const [hits, setHits] = useState<EmailSearchHit[] | null>(null);
  const [windowed, setWindowed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const set = (patch: Partial<EmailSearchQuery>): void =>
    setForm((current) => ({ ...current, ...patch }));

  const run = (): void => {
    setBusy(true);
    setFailed(null);
    void api
      .emailSearch(form)
      .then((result) => {
        setHits(result.messages);
        setWindowed(result.window ?? null);
      })
      .catch((err: unknown) => {
        setHits(null);
        setFailed(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  const clear = (): void => {
    setForm({});
    setHits(null);
    setWindowed(null);
    setFailed(null);
  };

  return (
    <Panel>
      <Section title="Search">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <Toolbar valign="end">
            <Field label="Text" grow>
              <input
                type="search"
                value={form.q ?? ''}
                placeholder="A word in the subject, the sender or the body"
                aria-label="Search mail"
                onChange={(e) => set({ q: e.target.value })}
              />
            </Field>
            <Field label="From" hint="An address, or a domain like acme.com">
              <input
                type="text"
                value={form.from ?? ''}
                aria-label="From"
                onChange={(e) => set({ from: e.target.value })}
              />
            </Field>
            <Field label="Since">
              <input
                type="date"
                value={form.since ?? ''}
                aria-label="Since"
                onChange={(e) => set({ since: e.target.value })}
              />
            </Field>
            <Field label="Until">
              <input
                type="date"
                value={form.until ?? ''}
                aria-label="Until"
                onChange={(e) => set({ until: e.target.value })}
              />
            </Field>
            <Field label="With attachments" inline>
              <input
                type="checkbox"
                checked={form.hasAttachments ?? false}
                aria-label="Only messages with attachments"
                onChange={(e) => set({ hasAttachments: e.target.checked })}
              />
            </Field>
            <Spacer />
            {hits !== null ? (
              <Button variant="ghost" type="button" onClick={clear}>
                Clear
              </Button>
            ) : null}
            <Button variant="accent" type="submit" disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </Button>
          </Toolbar>
        </form>
        <ErrorBanner message={failed} />
        {windowed ? <Notice>{windowed}</Notice> : null}
        {hits === null ? null : hits.length === 0 ? (
          <Empty>Nothing here matches that.</Empty>
        ) : (
          <List>
            {hits.map((hit) => (
              <ListRow
                key={hit.id}
                {...(hit.threadId ? { href: mailRoute(hit.threadId) } : {})}
                title={hit.subject || '(no subject)'}
                sub={`${hit.from} — ${hit.snippet}`}
                side={
                  <>
                    {hit.hasAttachments ? <Pill>attachment</Pill> : null}{' '}
                    <Pill tone={hit.direction === 'out' ? 'good' : undefined}>
                      {hit.direction === 'out' ? 'you wrote' : 'they wrote'}
                    </Pill>{' '}
                    <span className="muted" title={hit.date ?? undefined}>
                      {hit.date ? fmtRelative(hit.date) : ''}
                    </span>
                  </>
                }
              />
            ))}
          </List>
        )}
      </Section>
    </Panel>
  );
}

/** The conversations, and whichever one the address names. */
export function Mail({ hash, timezone, navigate }: PlaceProps): JSX.Element {
  const route = parseMailRoute(hash);
  const threadId = route?.threadId ?? null;
  const threads = useAsync(() => api.emailThreads(), []);

  if (threadId) {
    return (
      <PageFrame title="Mail">
        <Panel>
          <EmailThread
            threadId={threadId}
            timezone={timezone}
            onBack={() => {
              navigate(mailRoute());
              threads.reload();
            }}
          />
        </Panel>
      </PageFrame>
    );
  }

  const rows: EmailThreadRow[] = threads.data?.threads ?? [];
  return (
    <PageFrame
      title="Mail"
      actions={
        <Button variant="ghost" onClick={() => navigate(settingsRoute('email'))}>
          Mailboxes and rules
        </Button>
      }
    >
      <Stack gap="lg">
        <Notice>
          What buddi has read, newest first. A conversation with a reply waiting on it carries a{' '}
          <Pill>draft</Pill> — open it to read, edit, discard or send what was written. Accounts,
          rules and watcher settings live under Settings → Email.
        </Notice>
        <ErrorBanner message={threads.error} />
        <MailSearch />
        <Panel>
          {!threads.data ? (
            <Empty>Loading…</Empty>
          ) : rows.length === 0 ? (
            <Empty>No conversations yet. buddi builds them as mail arrives.</Empty>
          ) : (
            <List>
              {rows.map((thread) => (
                <ListRow
                  key={thread.id}
                  href={mailRoute(thread.id)}
                  title={
                    <>
                      {thread.subject || '(no subject)'}{' '}
                      {thread.hasLiveDraft ? <Pill tone="accent">draft</Pill> : null}
                    </>
                  }
                  sub={thread.participants.join(', ')}
                  side={
                    <>
                      <Pill>{thread.state}</Pill>{' '}
                      <span className="muted" title={thread.lastAt ?? undefined}>
                        {thread.lastAt ? fmtRelative(thread.lastAt) : ''}
                      </span>
                    </>
                  }
                />
              ))}
            </List>
          )}
        </Panel>
      </Stack>
    </PageFrame>
  );
}
