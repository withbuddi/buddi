/**
 * The two mail screens, as data (`docs/plugin-pages.md`).
 *
 * `Mail.tsx` and `Email.tsx` used to be compiled into the dashboard; this is
 * what is left of them — a tree of generic components, a query per read and a
 * tool per write. Nothing in `packages/web` knows any of the words below.
 *
 * Two shapes are worth reading twice, because they are the whole of what the
 * old pages did:
 *
 *  - **A conversation is a list-detail with a URL per item.** `#/p/email/mail`
 *    is the list; `#/p/email/mail/<threadId>` is one conversation, which is
 *    what makes a draft something the owner can link to, come back to, and
 *    reach with the browser's own Back. The old `#/email/<id>` still lands
 *    here (`packages/web/src/routes.ts`).
 *  - **Send does not send.** The editor's Send is `email.send`, gated, exactly
 *    as an agent would call it: the page draws the approval card in place,
 *    with the identity select on it, and nothing here reaches SMTP.
 */
import { TRIAGE_OFFER_TEXT } from '../agent.js';
import { TRIAGE_AGENT_ID } from '../sources/inbox-poll.js';
import type { Component, Field, PageDescriptor, QueryRef } from '@buddi/core/plugin';
import {
  MAX_DATE_CONFIDENCE,
  MAX_NUDGE_DAYS,
  MAX_PROMISED_DAYS,
  MAX_RECEIPT_CONFIDENCE,
  MAX_WAITING_DAYS,
  MIN_DATE_CONFIDENCE,
  MIN_NUDGE_DAYS,
  MIN_PROMISED_DAYS,
  MIN_RECEIPT_CONFIDENCE,
  MIN_WAITING_DAYS,
  DEFAULT_DATE_CONFIDENCE,
  DEFAULT_NUDGE_DAYS,
  DEFAULT_PROMISED_DAYS,
  DEFAULT_RECEIPT_CONFIDENCE,
  DEFAULT_WAITING_DAYS,
} from '../watchers.js';
import { ATTENTION_LABELS } from '../needs-you.js';

/** The conversation this page is showing, as a page parameter. */
const THREAD = 'thread';

/**
 * One read of the open conversation.
 *
 * A function rather than a shared constant: a descriptor is a *tree*, and the
 * same object in two places is refused at `register()` — rightly, since a
 * shared node is a cycle waiting to be written.
 */
const thread = (): QueryRef => ({ query: 'thread', params: { id: { param: THREAD } } });

/** One read of a message, by whichever row is asking. */
const message = (): QueryRef => ({ query: 'message', params: { id: { path: 'id' } } });

/* ------------------------------------------------------------------ *
 * Mail: the conversations, and the drafts waiting on them
 * ------------------------------------------------------------------ */

/**
 * The thread, as messages, newest last (host API 1.30's `message`): who wrote
 * it, when, To and Cc on expand, and the body — the stored HTML, sanitised
 * again by the dashboard with remote pictures held back, or the text — with
 * earlier quoted messages folded and the attachments as file rows.
 *
 * The thread answers with headers only, and each message reads its own body
 * (`message`) when it is drawn open: every one but the newest is a single line
 * until the owner opens it (or has not read it yet), so a long conversation is
 * not twenty bodies in one answer.
 */
const messages: Component = {
  kind: 'repeat',
  query: thread(),
  rows: 'messages',
  key: 'id',
  /*
   * The sentence for an empty conversation belongs *here*, on the thing that
   * would have drawn the rows — not on a sibling `notice` asking `when` about
   * the thread. `empty` asks nothing and cannot rot.
   */
  empty: 'No messages have been synced for this conversation yet.',
  body: [
    {
      kind: 'message',
      query: message(),
      folded: { path: 'folded', equals: true },
      /*
       * The bytes were never downloaded at ingest — what is stored is a
       * listing — so a file with nothing in the library yet has a Fetch, read
       * against that attachment; once fetched, the row opens it in Files.
       */
      fetch: {
        tool: 'email.fetch_attachment',
        label: 'Fetch',
        busy: 'Fetching…',
        done: { path: 'note' },
        args: { message: { path: 'messageId' }, index: { path: 'index' } },
      },
    },
  ],
};

/** The fields of the editor. All of them, because a save writes all of them. */
const draftFields: Field[] = [
  { name: 'to', label: 'To', type: 'text', from: 'toText', required: true },
  { name: 'cc', label: 'Cc', type: 'text', from: 'ccText' },
  {
    name: 'bcc',
    label: 'Bcc',
    type: 'text',
    from: 'bccText',
    hint: 'Shown in full on the approval card before anything is sent.',
  },
  { name: 'subject', label: 'Subject', type: 'text', from: 'rawSubject' },
  { name: 'bodyText', label: 'Body', type: 'textarea', from: 'bodyText', required: true },
];

/**
 * The reply written for this conversation: read as a message, then Send —
 * through the approval card, exactly as an agent's would — and Edit, which
 * opens the editor. One that was dispatched and never confirmed is not the
 * same thing at all: it is drawn as a critical notice with every action taken
 * away, because a second Send is how the same letter goes out twice.
 */
const drafts: Component = {
  kind: 'repeat',
  // Asked of the conversation the pane reads: no draft, no block at all.
  when: { path: 'hasDraft', equals: true },
  query: thread(),
  rows: 'drafts',
  key: 'id',
  body: [
    {
      kind: 'notice',
      tone: 'critical',
      title: 'This was dispatched and never confirmed',
      text: { path: 'unresolvedLine' },
      when: { path: 'unresolved', equals: true },
    },
    {
      /*
       * `notLive`, not `live === false`: a draft a dispatch is holding is also
       * not live, and "it is kept so you can read what was proposed" under
       * "whether it went out is genuinely unknown" is two answers to one
       * question.
       */
      kind: 'notice',
      text: { path: 'notLiveLine' },
      when: { path: 'notLive', equals: true },
    },
    { kind: 'message', path: 'preview', when: { path: 'live', equals: true } },
    {
      // Gated, and the page draws the approval card in place — identity
      // select and all. Nothing on this page reaches SMTP.
      kind: 'button',
      when: { path: 'live', equals: true },
      action: {
        tool: 'email.send',
        label: 'Send',
        tone: 'accent',
        busy: 'Proposing…',
        pending:
          'Nothing has been sent. This is the envelope, exactly as it will go out — approve it to send it, and pick the address it leaves from here.',
        args: { draftId: { path: 'id' } },
      },
    },
    {
      kind: 'expand',
      label: 'Edit',
      when: { path: 'live', equals: true },
      query: { query: 'draft', params: { id: { path: 'id' } } },
      body: [
        {
          kind: 'editor',
          query: { query: 'draft', params: { id: { path: 'id' } } },
          // A stamp, not a clock: the save carries the `updated_at` this editor
          // loaded, and a save that lost a race is refused rather than allowed
          // to overwrite what is stored.
          version: 'updatedAt',
          readOnlyWhen: { path: 'live', equals: false },
          fields: draftFields,
          save: {
            tool: 'email.save_draft',
            label: 'Save',
            busy: 'Saving…',
            done: { path: 'note' },
            args: {
              draftId: { path: 'id' },
              to: { field: 'to' },
              cc: { field: 'cc' },
              bcc: { field: 'bcc' },
              subject: { field: 'subject' },
              bodyText: { field: 'bodyText' },
              version: { field: 'version' },
            },
          },
          actions: [
            {
              tool: 'email.discard_draft',
              label: 'Discard',
              tone: 'danger',
              placement: 'leading',
              busy: 'Discarding…',
              done: { path: 'note' },
              confirm: 'Discard this draft? It is kept, so you can still read what was proposed.',
              args: { draftId: { path: 'id' } },
            },
          ],
          footnote:
            'Save, then Send above: Send puts the whole envelope in front of you to approve, bound to what is stored, and that card is where you choose which of your addresses it leaves from.',
        },
      ],
    },
  ],
};

/**
 * One conversation, read: buddi's layer first — Mail Triage's verdict and
 * what it changed (Undo), the reply written for it, "Needs a reply" with Done
 * — then the thread itself, and the old record fields folded at the foot.
 */
const reading: Component = {
  kind: 'section',
  title: 'Conversation',
  query: thread(),
  heading: { path: 'subject' },
  body: [
    {
      kind: 'notice',
      title: 'Mail Triage',
      text: { path: 'triageLine' },
      when: { path: 'hasTriage', equals: true },
    },
    /*
     * What buddi changed in the mailbox about this conversation — the same
     * rows Recent changes lists — with Undo while it still applies.
     */
    {
      kind: 'repeat',
      when: { path: 'hasChanges', equals: true },
      query: thread(),
      rows: 'changes',
      key: 'id',
      body: [
        {
          kind: 'notice',
          look: 'quiet',
          text: { path: 'line' },
          when: { path: 'undoable', equals: false },
        },
        {
          kind: 'notice',
          text: { path: 'line' },
          when: { path: 'undoable', equals: true },
          action: {
            tool: 'email.undo_change',
            label: 'Undo',
            busy: 'Putting it back…',
            confirm: '{undoLine}',
            done: { path: 'note' },
            args: { id: { path: 'id' } },
          },
        },
      ],
    },
    {
      kind: 'notice',
      tone: 'warning',
      title: 'Needs a reply',
      text: { path: 'stateLabel' },
      when: { path: 'needsReply', equals: true },
      action: {
        tool: 'email.thread_done',
        label: 'Done',
        busy: 'Marking it done…',
        done: { path: 'note' },
        args: { thread: { path: 'id' } },
      },
    },
    drafts,
    messages,
    /*
     * The ended drafts. Always here rather than shown only when there are
     * some: the list inside says when there is nothing.
     */
    {
      kind: 'expand',
      label: 'Older drafts',
      query: thread(),
      body: [
        {
          kind: 'list',
          query: { query: 'thread', params: { id: { path: 'id' } } },
          rows: 'older',
          key: 'id',
          item: {
            title: { path: 'subject' },
            sub: { path: 'statusLine' },
            pill: {
              value: { path: 'status' },
              labels: { draft: 'Draft', edited: 'Edited', sent: 'Sent', discarded: 'Discarded', lapsed: 'Lapsed' },
            },
          },
          empty: 'Nothing has ended on this conversation yet.',
        },
      ],
    },
    // The record the pane used to be, now a small fold at the foot.
    {
      kind: 'expand',
      label: 'Details',
      query: thread(),
      body: [
        {
          kind: 'detail',
          query: thread(),
          fields: [
            { label: 'Subject', value: { path: 'subject' } },
            { label: 'State', value: { path: 'stateLabel' } },
            { label: 'With', value: { path: 'participants' } },
            { label: 'Messages', value: { path: 'messageCount' }, unit: 'number' },
            { label: 'Last message', value: { path: 'lastAt' }, unit: 'date' },
          ],
          body: [],
        },
      ],
    },
  ],
};

/**
 * The conversations and the one that is open. The list reads the page
 * parameter `show` the bar above it writes (`needs-you.ts` says what each
 * view holds); the detail follows the route, so changing the view keeps the
 * open conversation open. ↑ and ↓ move through the list, Enter opens one.
 */
const conversations: Component = {
  kind: 'list-detail',
  param: THREAD,
  list: {
    kind: 'list',
    query: { query: 'threads', params: { show: { param: 'show' } } },
    rows: 'threads',
    key: 'id',
    item: {
      // Who it is with — the name they gave, else the address — then what it
      // is about, then how it last read: the way a mailbox reads.
      title: { path: 'senderName' },
      sub: { path: 'subject' },
      preview: { path: 'preview' },
      meta: [{ path: 'when' }],
      // Mail the owner has not read yet is drawn heavier.
      strong: { path: 'unread', equals: true },
      pills: [
        // Where it stands, by the one rule (needs-you.ts): "Waiting on you"
        // only when someone is, in the warning ink because it is now rare
        // and true. A notification or a message nobody expects an answer to
        // has no pill (`pill` is empty); the reading pane says which it is.
        {
          value: { path: 'pill' },
          labels: { ...ATTENTION_LABELS },
          tones: { 'needs-you': 'warning', 'waiting-on-them': 'neutral', muted: 'neutral', closed: 'neutral' },
        },
        // The reply waiting on the owner is the one to catch an eye.
        { value: { path: 'draftPill' }, labels: { draft: 'Draft' }, tone: 'accent' },
        // Mail Triage's word for it: "Bill", "Receipt".
        { value: { path: 'tag' }, tone: 'neutral' },
      ],
      to: { page: 'mail', item: { path: 'id' } },
    },
    empty: 'No conversations here.',
  },
  detail: [reading],
  empty: 'Choose a conversation to read it here.',
};

const mail: PageDescriptor = {
  id: 'mail',
  title: 'Mail',
  place: 'rail',
  icon: 'mail',
  order: 10,
  // Which mailboxes are connected, and which are fresh: what the head line,
  // the first state and the list's own visibility are drawn against.
  data: { query: 'mail_status' },
  body: [
    {
      kind: 'notice',
      // The page's intro: one line under the title. A conversation with a
      // reply waiting carries a Draft pill, which says the rest.
      text: 'What buddi has read, newest first. Open a conversation to read it, or the reply written for it.',
    },
    // The head says which mailboxes this is: "Connected: you@example.com".
    { kind: 'notice', look: 'quiet', text: { path: 'connected' }, when: { path: 'hasAccounts', equals: true } },
    /*
     * A fresh mailbox's first state, in place of "No conversations here":
     * what buddi is doing (reading from now on) and what it left alone. There
     * is no backfill tool yet, so "Read the last 7 days" goes to Mailboxes
     * and rules, which says so.
     */
    {
      kind: 'repeat',
      when: { path: 'anyFresh', equals: true },
      query: { query: 'mail_status' },
      rows: 'fresh',
      key: 'id',
      body: [
        {
          kind: 'section',
          title: 'Just connected',
          actions: [{ kind: 'link', label: 'Read the last 7 days', to: { page: 'settings' }, tone: 'accent' }],
          body: [{ kind: 'notice', text: { path: 'line' } }],
        },
      ],
    },
    // Until a mailbox's first poll has finished, nothing is known about it yet.
    { kind: 'notice', look: 'quiet', text: { path: 'connecting' }, when: { path: 'anyConnecting', equals: true } },
    /*
     * Four filters and a phrase, and not one more (docs/email.md §9):
     * from, since, until and "has attachments" are the ones that answer a
     * question an owner actually has in front of a mailbox. It searches on
     * submit rather than on every keystroke — a substring search over bodies
     * is not free.
     */
    {
      kind: 'search',
      // Searching a mailbox with nothing stored answers nothing: the bar
      // stands where the list does.
      when: { path: 'showList', equals: true },
      fields: [
        {
          name: 'q',
          label: 'Search mail',
          type: 'text',
          // A placeholder in the bar, so a few words.
          hint: 'Search the subject, the sender or the body',
        },
        { name: 'from', label: 'From', type: 'text', hint: 'An address or a domain' },
        { name: 'since', label: 'Since', type: 'date' },
        { name: 'until', label: 'Until', type: 'date' },
        { name: 'hasAttachments', label: 'With attachments', type: 'checkbox' },
      ],
      query: {
        query: 'threads',
        params: {
          /*
           * What tells the query that somebody pressed Search: the list above
           * asks the same query with no parameters at all, and an owner who
           * searched for nothing must get the refusal that says so rather than
           * the list's silence.
           */
          searching: { const: 'true' },
          q: { param: 'q' },
          from: { param: 'from' },
          since: { param: 'since' },
          until: { param: 'until' },
          hasAttachments: { param: 'hasAttachments' },
        },
      },
      rows: 'items',
      count: 'count',
      note: 'window',
      // Clear, as the old form had: a search is a thing you finish with.
      reset: true,
      results: {
        title: { path: 'subject' },
        sub: { path: 'line' },
        meta: [{ path: 'attachment' }, { path: 'when' }],
        // The owner's own words are toned as such, as the old list drew them.
        pill: { value: { path: 'who' }, tone: { path: 'whoTone' } },
        to: { page: 'mail', item: { path: 'threadId' } },
      },
      empty: 'Nothing here matches that.',
    },
    {
      /*
       * The way across to the configuration is a header action, right-aligned
       * like every other primary action, rather than a link at the foot of the
       * page — and it routes to the *settings tab*, because a `RouteRef` to a
       * settings page resolves to the tab it is rather than to a bare page.
       */
      kind: 'section',
      title: 'Conversations',
      when: { path: 'showList', equals: true },
      actions: [{ kind: 'link', label: 'Mailboxes and rules', to: { page: 'settings' } }],
      body: [
        {
          /*
           * Three views of the one list, a switch at the left of the bar
           * (docs/email.md §3, Needs you). "Needs a reply" is what the "Waiting
           * on you" widget counts; "Notifications" is the no-reply and bulk
           * mail, so the owner can see what was set aside and why.
           */
          kind: 'tabs',
          // One tab and a pick: the bar is a filter over the one list.
          pick: {
            param: 'show',
            label: 'Show',
            options: [
              { value: 'all', label: 'All' },
              { value: 'needs-reply', label: 'Needs a reply' },
              { value: 'notifications', label: 'Notifications' },
            ],
          },
          tabs: [{ id: 'conversations', label: 'Conversations', body: [conversations] }],
        },
      ],
    },
    /*
     * What buddi changed in the mailbox itself — an agent's approved
     * cleanup, a rule acting on arrival, an undo — newest first, with Undo
     * on each row that can still be undone. Undo is the owner's own button:
     * `email.undo_change` is never listed to a model.
     */
    {
      kind: 'section',
      title: 'Recent changes',
      note: 'What buddi changed on your mail server. Undo puts it back while the messages are still where it left them.',
      body: [
        {
          kind: 'list',
          query: { query: 'mailbox_changes' },
          rows: 'changes',
          key: 'id',
          item: {
            title: { path: 'title' },
            sub: { path: 'line' },
            meta: [{ path: 'when' }],
            pill: {
              value: { path: 'state' },
              labels: {
                undone: 'Undone',
                undo: 'Put back',
                'partly-undone': 'Partly undone',
                partial: 'Partly done',
                pending: 'Checking',
                unknown: 'Unconfirmed',
              },
              tones: {
                undone: 'neutral',
                undo: 'neutral',
                'partly-undone': 'warning',
                partial: 'warning',
                pending: 'neutral',
                unknown: 'warning',
              },
            },
          },
          actions: [
            {
              tool: 'email.undo_change',
              label: 'Undo',
              busy: 'Putting it back…',
              when: { path: 'undoable', equals: true },
              confirm: '{undoLine}',
              done: { path: 'note' },
              args: { id: { row: 'id' } },
            },
          ],
          empty: 'buddi has not changed anything in your mailbox.',
        },
      ],
    },
    /*
     * Rules that kept themselves (docs/email.md §5, "What keeps itself"):
     * a sender quieted without a card, because its mail is sent to many or
     * the owner has kept every rule like it. Newest first, Undo on each one
     * that still decides. The owner's own button: `email.undo_learned` is
     * never listed to a model.
     */
    {
      kind: 'section',
      title: 'Learned',
      note: 'Senders buddi quieted by itself, without asking: newsletters you never wrote to, and rules like ones you always kept. Undo stops one.',
      body: [
        {
          kind: 'list',
          query: { query: 'learned_rules' },
          rows: 'rules',
          key: 'id',
          item: {
            title: { path: 'title' },
            sub: { path: 'line' },
            meta: [{ path: 'when' }],
            pill: { value: { path: 'state' }, labels: { undone: 'Undone' }, tones: { undone: 'neutral' } },
          },
          actions: [
            {
              tool: 'email.undo_learned',
              label: 'Undo',
              busy: 'Undoing…',
              when: { path: 'undoable', equals: true },
              confirm: '{undoLine}',
              done: { path: 'note' },
              args: { id: { row: 'id' } },
            },
            {
              tool: 'email.undo_learned',
              label: 'Undo and put back',
              busy: 'Putting it back…',
              when: { path: 'canPutBack', equals: true },
              confirm: '{undoLine} What it changed in your mailbox is put back too.',
              done: { path: 'note' },
              args: { id: { row: 'id' }, putBack: { const: true } },
            },
          ],
          empty: 'Nothing learned by itself yet. When buddi quiets a newsletter without asking, it is listed here.',
        },
      ],
    },
  ],
};

/* ------------------------------------------------------------------ *
 * Settings → Email: the mailboxes, and the standing decisions
 * ------------------------------------------------------------------ */

/**
 * Add an account.
 *
 * The least that can work: the address and the app password. The hosts are
 * *optional* and are filled in from the address's domain by
 * `email.add_account` — the old form did that as the address was typed, and a
 * page descriptor carries no such logic, so it moved to the one place that can
 * still apply it. The sentence under the password is never paraphrased.
 */
const addAccount: Component = {
  kind: 'form',
  drawer: { title: 'Add an account', button: 'Add an account' },
  fields: [
    {
      name: 'address',
      label: 'Address',
      type: 'email',
      required: true,
      hint: "Its hosts are worked out from this address; set them below only if your provider's are different.",
    },
    {
      name: 'password',
      label: 'App password',
      type: 'secret',
      required: true,
      hint: 'The password goes to your keychain, never to a file. Most providers want a password made for this, not the one you sign in with.',
    },
    { name: 'displayName', label: 'Name for it', type: 'text', hint: 'Optional. What you call this mailbox.' },
    {
      name: 'aliases',
      label: 'Also receives as',
      type: 'text',
      hint: 'Optional, separated by commas. A reply leaves from the alias the message was addressed to.',
    },
    { name: 'imapHost', label: 'IMAP host', type: 'text', hint: 'Optional.' },
    { name: 'imapPort', label: 'IMAP port', type: 'number', min: 1, max: 65_535 },
    { name: 'smtpHost', label: 'SMTP host', type: 'text', hint: 'Optional.' },
    { name: 'smtpPort', label: 'SMTP port', type: 'number', min: 1, max: 65_535 },
  ],
  submit: {
    tool: 'email.add_account',
    label: 'Add the account',
    tone: 'accent',
    busy: 'Opening the mailbox…',
    // The tool's own sentence: it knows the address it just opened.
    done: { path: 'note' },
    then: 'close',
    args: {
      address: { field: 'address' },
      password: { field: 'password' },
      displayName: { field: 'displayName' },
      aliases: { field: 'aliases' },
      imapHost: { field: 'imapHost' },
      imapPort: { field: 'imapPort' },
      smtpHost: { field: 'smtpHost' },
      smtpPort: { field: 'smtpPort' },
    },
  },
};

/**
 * Add a rule.
 *
 * The mailbox is named by its address, and "for every mailbox" is a tick: a
 * rule with no mailbox decides for all of them, so that has to be something
 * somebody chose rather than a field they left empty. A conversation is named
 * by the id in its address on the Mail page, because a thread key is a
 * Message-ID off the wire and not something an owner has.
 */
const addRule: Component = {
  kind: 'form',
  drawer: { title: 'Add a rule', button: 'Add a rule' },
  fields: [
    /*
     * The mailbox first, and picked: a conversation lives in exactly one of
     * them, so the picker below can only offer that one's threads once this
     * is answered — never fifty threads across every account, which could
     * hand a busy mailbox's conversations to a rule meant for a quiet one.
     */
    {
      name: 'mailbox',
      label: 'Mailbox',
      type: 'select',
      optionsFrom: { query: { query: 'accounts' }, rows: 'accounts', value: 'id', label: 'label' },
      disabledWhen: { path: 'allAccounts', equals: true },
    },
    {
      name: 'allAccounts',
      label: 'For every mailbox',
      type: 'checkbox',
      hint: 'The same sender can matter in one inbox and not in another, so a rule says which one it is about — unless you tick this.',
      // Meaningless for one conversation, and refused by the tool besides.
      disabledWhen: { path: 'scope', equals: 'thread' },
    },
    {
      name: 'scope',
      label: 'About',
      type: 'select',
      required: true,
      options: [
        { value: 'sender', label: 'One sender' },
        { value: 'domain', label: 'Everyone at a domain' },
        { value: 'list-id', label: 'One mailing list' },
        { value: 'thread', label: 'One conversation' },
      ],
    },
    {
      // Typed, for the three scopes that are a string somebody can write.
      name: 'matcher',
      label: 'Which',
      type: 'text',
      required: true,
      when: { path: 'scope', in: ['sender', 'domain', 'list-id'] },
      hint: 'An address like news@shop.example, a domain like shop.example, or a List-Id.',
    },
    {
      /*
       * **Picked, never typed** (docs/email.md §5). A thread is named in
       * the database by the root Message-ID of its chain, which is not
       * something an owner has, so the one scope that cannot be a text field
       * is a list of subjects — re-read whenever the mailbox above changes.
       */
      name: 'thread',
      label: 'Which conversation',
      type: 'select',
      required: true,
      when: { path: 'scope', equals: 'thread' },
      optionsFrom: {
        query: { query: 'rule_threads' },
        rows: 'threads',
        value: 'id',
        label: 'label',
        dependsOn: ['mailbox'],
      },
      hint: 'The conversations buddi has seen in the mailbox above, most recent first.',
    },
    {
      name: 'action',
      label: 'Then',
      type: 'select',
      required: true,
      options: [
        { value: 'ignore', label: 'File it, with no triage run' },
        { value: 'notify', label: 'Send me one line' },
        { value: 'draft', label: 'Draft a reply' },
        { value: 'wake', label: 'Triage it as usual' },
      ],
    },
    {
      name: 'sender',
      label: 'From this address',
      type: 'text',
      when: { path: 'scope', in: ['thread', 'list-id'] },
      hint: 'A conversation and a list are named by headers their sender writes, so silence here applies to one address. Without it, such a rule silences nothing on its own.',
    },
    {
      name: 'note',
      label: 'The line you get',
      type: 'text',
      when: { path: 'action', equals: 'notify' },
    },
    {
      name: 'instruction',
      label: 'What the reply should say',
      type: 'text',
      when: { path: 'action', equals: 'draft' },
    },
    {
      // A change on the mail server itself, made as each match arrives and
      // listed under Recent changes on the Mail page, where Undo puts it back.
      name: 'onArrival',
      label: 'In the mailbox',
      type: 'select',
      options: [
        { value: '', label: 'Leave it where it is' },
        { value: 'archive', label: 'Archive it' },
        { value: 'mark-read', label: 'Mark it read' },
        { value: 'move', label: 'Move it to a folder' },
      ],
      hint: 'Done on your mail server as each message arrives. Recent changes on the Mail page can undo it.',
    },
    {
      name: 'folder',
      label: 'Folder',
      type: 'text',
      required: true,
      when: { path: 'onArrival', equals: 'move' },
      hint: 'An existing folder or Gmail label, by its name. Nothing is created.',
    },
  ],
  submit: {
    tool: 'email.add_rule',
    label: 'Add the rule',
    tone: 'accent',
    done: { path: 'note' },
    then: 'close',
    args: {
      mailbox: { field: 'mailbox' },
      allAccounts: { field: 'allAccounts' },
      scope: { field: 'scope' },
      matcher: { field: 'matcher' },
      thread: { field: 'thread' },
      action: { field: 'action' },
      sender: { field: 'sender' },
      note: { field: 'note' },
      instruction: { field: 'instruction' },
      onArrival: { field: 'onArrival' },
      folder: { field: 'folder' },
    },
  },
};

/** The five numbers the mail watchers read (docs/email.md §7). */
const watchers: Component = {
  kind: 'form',
  title: 'Watchers',
  note: 'What mail watching needs told. The switches are on the Watchers page.',
  initial: { query: 'watcher_settings' },
  fields: [
    {
      name: 'waitingDays',
      label: 'Waiting longer than',
      type: 'number',
      from: 'waitingDays',
      min: MIN_WAITING_DAYS,
      max: MAX_WAITING_DAYS,
      step: 1,
      hint: `Days before a conversation waiting on you is reported. ${DEFAULT_WAITING_DAYS} by default; a week or more is always urgent.`,
    },
    {
      name: 'dateConfidence',
      label: 'Date confidence',
      type: 'number',
      from: 'dateConfidence',
      min: MIN_DATE_CONFIDENCE,
      max: MAX_DATE_CONFIDENCE,
      step: 0.05,
      hint: `How sure the date reader must be before it says anything, between ${MIN_DATE_CONFIDENCE} and ${MAX_DATE_CONFIDENCE}. ${DEFAULT_DATE_CONFIDENCE} by default: a date with "deadline" beside it scores about 0.8, a bare "9/8" scores 0.3.`,
    },
    {
      name: 'promisedDays',
      label: 'Unkept promise after',
      type: 'number',
      from: 'promisedDays',
      min: MIN_PROMISED_DAYS,
      max: MAX_PROMISED_DAYS,
      step: 1,
      hint: `Days before a promise of yours — or a draft written for you and never sent — is reported. ${DEFAULT_PROMISED_DAYS} by default; a week or more is always urgent.`,
    },
    {
      name: 'receiptConfidence',
      label: 'Receipt confidence',
      type: 'number',
      from: 'receiptConfidence',
      min: MIN_RECEIPT_CONFIDENCE,
      max: MAX_RECEIPT_CONFIDENCE,
      step: 0.05,
      hint: `How sure the classifier must be before a message is called a receipt or a bill, between ${MIN_RECEIPT_CONFIDENCE} and ${MAX_RECEIPT_CONFIDENCE}. ${DEFAULT_RECEIPT_CONFIDENCE} by default.`,
    },
    {
      name: 'nudgeDays',
      label: 'Nudge after',
      type: 'number',
      from: 'nudgeDays',
      min: MIN_NUDGE_DAYS,
      max: MAX_NUDGE_DAYS,
      step: 1,
      hint: `Days you wait for an answer before a nudge is offered. ${DEFAULT_NUDGE_DAYS} by default, and it is only ever offered: nothing here sends mail.`,
    },
  ],
  submit: {
    tool: 'email.set_settings',
    label: 'Save',
    tone: 'accent',
    done: { path: 'note' },
    args: {
      waitingDays: { field: 'waitingDays' },
      dateConfidence: { field: 'dateConfidence' },
      promisedDays: { field: 'promisedDays' },
      receiptConfidence: { field: 'receiptConfidence' },
      nudgeDays: { field: 'nudgeDays' },
    },
  },
};

const settings: PageDescriptor = {
  id: 'settings',
  title: 'Email',
  place: 'settings',
  // The page's own read, for the one line below that depends on it: whether
  // the mail that lands has an agent to triage it.
  data: { query: 'accounts' },
  body: [
    {
      kind: 'notice',
      text: 'Reading mail, and the drafts waiting on you, are on the Mail page. This is what buddi reads, and what it has been told to do with it.',
    },
    { kind: 'link', label: 'Open Mail', to: { page: 'mail' } },
    {
      kind: 'section',
      title: 'Mailboxes',
      note: 'What this installation reads and sends as.',
      body: [
        /*
         * A mailbox with nobody to triage it: the poll keeps the mail and
         * starts no run until @mail exists. One line, and the same gated
         * accept the Plugins page runs — the approval card is drawn here.
         */
        /*
         * Where the Mail page's "Read the last 7 days" lands while a mailbox
         * is fresh: reading older mail on request is not built yet, and the
         * page says so rather than pretending.
         */
        {
          kind: 'notice',
          when: { path: 'anyFresh', equals: true },
          text: 'Reading older mail on request is not available yet. buddi reads what arrives from the moment a mailbox is connected; mail already there is left alone.',
        },
        {
          kind: 'agent-offer',
          agent: TRIAGE_AGENT_ID,
          text: TRIAGE_OFFER_TEXT,
          label: 'Create @mail',
          when: { path: 'triage', equals: 'needs-agent' },
        },
        {
          kind: 'table',
          query: { query: 'accounts' },
          rows: 'accounts',
          columns: [
            // Long values wrap or are cut, so the table stays inside the page
            // and Remove stays in view.
            { key: 'address', label: 'Address', fit: 'wrap' },
            { key: 'called', label: 'Called', fit: 'wrap' },
            // A reply leaves from the alias the message was addressed to, so
            // which ones a mailbox answers to is part of what it *is*.
            { key: 'aliases', label: 'Also receives as', fit: 'wrap' },
            { key: 'host', label: 'Host', fit: 'truncate' },
            // "Instant" while IDLE is live, else how often the poll checks.
            { key: 'arrival', label: 'New mail' },
            { key: 'lastSync', label: 'Last sync' },
            // Where the password is, in words; the vault's name for it on hover.
            { key: 'password', label: 'Password', hint: 'secretName' },
            // An array of `{ value, tone }`: one pill per fact about the row.
            { key: 'state', label: 'State', pill: {} },
          ],
          actions: [
            /*
             * A new password for a mailbox that stays: after a restore, or an
             * app password changed at the provider. Tested against the
             * mailbox's own hosts before anything is kept. The recovery
             * checklist opens it on one row with `?account=<id>&set=password`.
             */
            {
              tool: 'email.set_password',
              label: 'Set password',
              form: {
                title: 'Set the password for {address}',
                fields: [
                  {
                    name: 'password',
                    label: 'App password',
                    type: 'secret',
                    required: true,
                    hint: 'buddi signs in with it once to test it, then keeps it in your keychain. The old one stays until this one works.',
                  },
                ],
                submit: 'Test and save',
                openWhen: { account: { row: 'id' }, set: 'password' },
              },
              busy: 'Testing…',
              done: { path: 'note' },
              then: 'close',
              args: { id: { row: 'id' }, password: { field: 'password' } },
            },
            {
              tool: 'email.remove_account',
              label: 'Remove',
              tone: 'danger',
              // A destructive confirmation names what it is about to destroy.
              confirm:
                'Remove {address}? It deletes its mail and its drafts from buddi, and its password from your keychain. The mailbox itself is untouched.',
              done: { path: 'note' },
              args: { id: { row: 'id' } },
            },
          ],
          empty: 'No mailbox yet. Add one and buddi starts reading it.',
        },
        addAccount,
      ],
    },
    {
      kind: 'section',
      title: 'Policies',
      body: [
        {
          kind: 'stats',
          query: { query: 'policies' },
          items: [
            { label: 'Applied', value: { path: 'appliedCount' }, unit: 'number' },
            { label: 'Proposed', value: { path: 'proposedCount' }, unit: 'number' },
            { label: 'Triage runs saved', value: { path: 'savedRuns' }, unit: 'number' },
          ],
        },
        {
          kind: 'notice',
          text: 'A policy is a decision made once. The next message from that sender is handled by the rule instead of by a model run, and what each rule did is recorded so you can audit the silence.',
        },
        {
          kind: 'list',
          title: 'Applied',
          note: 'Deciding right now, with no model run and nothing to approve each time.',
          query: { query: 'policies' },
          rows: 'applied',
          item: {
            title: { path: 'matcher' },
            sub: { path: 'sub' },
            pill: { value: { path: 'action' } },
          },
          select: { key: 'id' },
          actions: [
            {
              tool: 'email.revoke_policies',
              label: 'Revoke',
              confirm: 'Revoke the rule about {matcher}? It stops deciding anything from now on.',
              done: { path: 'note' },
              args: { ids: { row: 'ids' } },
            },
          ],
          bulk: [
            {
              /*
               * With nothing ticked this is every row shown — "Revoke all 73"
               * — which is the reason the bulk act exists: going through
               * seventy rules one tap at a time is how an owner ends up not
               * going through them at all.
               */
              tool: 'email.revoke_policies',
              all: true,
              label: 'Revoke {count} {rule|rules}',
              tone: 'danger',
              confirm: 'Revoke {count} {rule|rules}? They stop deciding anything from now on.',
              done: { path: 'note' },
              args: { ids: { selected: true } },
            },
          ],
          empty: 'No policies are deciding anything yet. buddi proposes them from your own mail.',
        },
        /*
         * Learned rules are proposed on the owner's one inbox, beside what the
         * agents propose (docs/learning.md §2 item 3). A link rather
         * than a second copy of those cards: keeping one is core's act and
         * this plugin's apply, and one place to do it is one place to get it
         * right. The link lands filtered to this plugin's rules.
         */
        /*
         * Learned rules are proposed on the owner's one inbox (docs/learning.md
         * §2 item 3). A link rather than a second copy of those
         * cards: keeping one is core's act and this plugin's apply, and one
         * place to do it is one place to get it right. It lands filtered to
         * this plugin's rules.
         */
        {
          kind: 'notice',
          title: 'Learned, proposed',
          text: 'Rules buddi learns from your own mail wait in Settings → Proposals, beside what your agents propose, and decide nothing until you keep them there. Kept, they appear under Applied.',
        },
        { kind: 'link', label: 'Review proposed rules', to: { proposals: true } },
        addRule,
      ],
    },
    watchers,
  ],
};

/** The two screens this plugin contributes. */
export const emailPageDescriptors: PageDescriptor[] = [mail, settings];
