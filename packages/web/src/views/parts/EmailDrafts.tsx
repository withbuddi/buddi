/**
 * Conversations, and the drafts waiting on them (docs/specs/email.md §8).
 *
 * This is the owner's half of the draft lifecycle. An agent writes a draft; the
 * owner reads the conversation it answers, edits it, throws it away, or sends
 * it — and "sends it" here means *proposes* it: Send records the `email.send`
 * action by the same path an agent takes, and the approval card appears with
 * the identity select on it. Nothing on this page reaches SMTP.
 *
 * The shape follows what is being read. A list of conversations on the left of
 * the reading order — subject, who is in it, when it last moved, and a small
 * **draft** pill when something is waiting — and, once one is chosen, the
 * conversation itself: its messages in order, and its drafts *under* them,
 * because a draft is an answer to what is above it. Sent, discarded and lapsed
 * drafts are folded away under "Older drafts": they are the record, not the
 * decision.
 *
 * One rule shows up as a disabled field rather than as prose: a lapsed draft is
 * not editable. It is still readable, and the owner can still see exactly what
 * was proposed a fortnight ago — they just cannot send it as though it were
 * current.
 */
import { useState } from 'react';
import {
  ApiError,
  api,
  type ApprovalRow,
  type EmailDraftRow,
  type EmailThreadRow,
} from '../../api';
import { fmtRelative } from '../../format';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  List,
  ListRow,
  Notice,
  Panel,
  Pill,
  Section,
  Stack,
  Toolbar,
  useAsync,
} from '../../ui';
import { ApprovalCard, useDecide } from './ApprovalCard';

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
 * Save, Discard, and Send sit in one toolbar with Send last and on the right:
 * it is the act that leads somewhere irreversible, and the one the layout
 * should make deliberate rather than convenient.
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
  const set = (patch: Partial<EditState>): void => {
    setSaved(false);
    setEdit((current) => ({ ...current, ...patch }));
  };

  const run = (
    what: 'save' | 'discard' | 'send',
    call: () => Promise<unknown>,
  ): void => {
    setBusy(what);
    setFailed(null);
    void call()
      .then((result) => {
        if (what === 'save') setSaved(true);
        if (what === 'send') onProposed((result as { actionId: string }).actionId);
        onChanged();
      })
      .catch((err: unknown) => setFailed(err instanceof ApiError ? err.message : String(err)))
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
      {saved ? (
        <Notice tone="good" role="status">
          Saved. These are your words now — no agent will write over them, and a send you approved
          before this edit will refuse rather than go out with the old text.
        </Notice>
      ) : null}
      {editable ? null : (
        <Notice>
          This draft is {draft.status} and cannot be edited or sent. It is kept so you can read what
          was proposed.
        </Notice>
      )}
      <Stack gap="sm">
        <Field label="To">
          <input
            value={edit.to}
            disabled={!editable}
            onChange={(event) => set({ to: event.target.value })}
          />
        </Field>
        <Field label="Cc">
          <input
            value={edit.cc}
            disabled={!editable}
            onChange={(event) => set({ cc: event.target.value })}
          />
        </Field>
        <Field label="Bcc" hint="Shown in full on the approval card before anything is sent.">
          <input
            value={edit.bcc}
            disabled={!editable}
            onChange={(event) => set({ bcc: event.target.value })}
          />
        </Field>
        <Field label="Subject">
          <input
            value={edit.subject}
            disabled={!editable}
            onChange={(event) => set({ subject: event.target.value })}
          />
        </Field>
        <Field label="Body">
          <textarea
            rows={12}
            value={edit.bodyText}
            disabled={!editable}
            onChange={(event) => set({ bodyText: event.target.value })}
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

/** One conversation: its messages, then the drafts answering them. */
export function EmailThread({
  threadId,
  onBack,
}: {
  threadId: string;
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
        aside={<Button variant="ghost" onClick={onBack}>Back to conversations</Button>}
      >
        <ErrorBanner message={view.error ?? decide.failure} />
        {!detail ? (
          <Empty>Loading…</Empty>
        ) : detail.messages.length === 0 ? (
          <Empty>No messages have been synced for this conversation yet.</Empty>
        ) : (
          <List>
            {detail.messages.map((message) => (
              <ListRow
                key={message.id}
                title={message.from}
                sub={message.snippet}
                side={
                  <>
                    <Pill tone={message.direction === 'out' ? 'good' : undefined}>
                      {message.direction === 'out' ? 'you wrote' : 'they wrote'}
                    </Pill>{' '}
                    <span className="muted">{message.date ? fmtRelative(message.date) : ''}</span>
                  </>
                }
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
              timezone="UTC"
              busy={decide.busy === proposed.id}
              onDecide={(id, decision, scope, choices) => void decide.decide(id, decision, scope, choices)}
            />
          </Stack>
        ) : null}
        {decide.note ? <Notice tone="good" role="status">{decide.note}</Notice> : null}
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

/** The conversations, and the one the owner opened. */
export function EmailDraftsBlock(): JSX.Element {
  const threads = useAsync(() => api.emailThreads(), []);
  const [open, setOpen] = useState<string | null>(null);

  if (open) {
    return (
      <Section title="Conversations">
        <Panel>
          <EmailThread
            threadId={open}
            onBack={() => {
              setOpen(null);
              threads.reload();
            }}
          />
        </Panel>
      </Section>
    );
  }

  const rows: EmailThreadRow[] = threads.data?.threads ?? [];
  return (
    <Section title="Conversations">
      <Stack gap="lg">
        <Notice>
          What buddi has read, newest first. A conversation with a reply waiting on it carries a
          <Pill>draft</Pill> — open it to read, edit, discard or send what was written.
        </Notice>
        <ErrorBanner message={threads.error} />
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
                      <span className="muted">{thread.lastAt ? fmtRelative(thread.lastAt) : ''}</span>{' '}
                      <Button onClick={() => setOpen(thread.id)}>Open</Button>
                    </>
                  }
                  onClick={() => setOpen(thread.id)}
                />
              ))}
            </List>
          )}
        </Panel>
      </Stack>
    </Section>
  );
}
