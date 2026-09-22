/**
 * The two mail screens, as data (`docs/specs/plugin-pages.md`).
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
import type { Component, Field, PageDescriptor, QueryRef } from '@buddi/core';
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
 * One message: a line saying who wrote it and when, and its body behind a
 * fold.
 *
 * The body is *not* shipped with the thread — twenty bodies for a list of
 * one-line rows is a page weight nobody reads — so opening a message is what
 * fetches it (`expand`), exactly as the old route did.
 */
const messages: Component = {
  kind: 'repeat',
  title: 'Messages',
  query: thread(),
  rows: 'messages',
  key: 'id',
  /*
   * The sentence for an empty conversation belongs *here*, on the thing that
   * would have drawn the rows — not on a sibling `notice` asking `when` about
   * the thread. A component is handed the data of the nearest query above it,
   * and inside a `list-detail`'s detail that is the page's own, which is
   * nothing: such a `when` can only ever be false, and the sentence would
   * never appear. `empty` asks nothing and cannot rot.
   */
  empty: 'No messages have been synced for this conversation yet.',
  body: [
    {
      kind: 'expand',
      // The fold carries the row's own words: who wrote it, when, and what it
      // opens with — the line the old list drew, on the thing that opens it.
      label: { path: 'summary' },
      query: message(),
      body: [
        {
          kind: 'detail',
          query: message(),
          fields: [
            { label: 'From', value: { path: 'from' } },
            { label: 'To', value: { path: 'to' } },
            { label: 'Sent', value: { path: 'date' }, unit: 'date' },
            { label: 'Body', value: { path: 'bodyText' } },
          ],
          body: [],
        },
        /*
         * The bytes were never downloaded at ingest — what is stored is a
         * listing — so an attachment is one block: what it is, a Fetch while
         * there is nothing to download, and the link to the file once there
         * is. `when` is asked of the row, so the button gives way rather than
         * sitting beside the link it produced.
         */
        {
          kind: 'repeat',
          title: 'Attachments',
          query: message(),
          rows: 'attachments',
          // The index, never the filename: a filename comes off the wire, and
          // two `invoice.pdf` on one message are two rows, not one.
          key: 'index',
          empty: 'Nothing was attached to this message.',
          body: [
            { kind: 'notice', text: { path: 'line' } },
            {
              kind: 'button',
              when: { path: 'artifactId', equals: null },
              action: {
                // Plain words: a `button` is not handed its row for `{field}`
                // substitution the way a row action is, and the line above it
                // already names the file.
                tool: 'email.fetch_attachment',
                label: 'Fetch',
                busy: 'Fetching…',
                done: { path: 'note' },
                args: { message: { path: 'messageId' }, index: { path: 'index' } },
              },
            },
            {
              kind: 'artifact',
              when: { path: 'artifactId', equals: null, not: true },
              path: 'artifactId',
              label: 'Download the file',
            },
          ],
        },
      ],
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
 * One live draft, editable — and one that was dispatched and never confirmed,
 * which is not the same thing at all.
 *
 * A draft a send is holding may already be on the wire, so it is drawn as a
 * critical notice with every action taken away: a second Send is how the same
 * letter goes out twice.
 */
const drafts: Component = {
  kind: 'repeat',
  title: 'Drafts',
  query: thread(),
  rows: 'drafts',
  key: 'id',
  empty:
    'No draft is waiting here. Ask an agent to draft a reply and it will appear under the conversation.',
  body: [
    {
      // The sentence carries the server's own words when there were any, which
      // is why it is a path rather than a string.
      kind: 'notice',
      tone: 'critical',
      title: 'This was dispatched and never confirmed',
      text: { path: 'unresolvedLine' },
      when: { path: 'unresolved', equals: true },
    },
    {
      /*
       * `notLive`, not `live === false`: a draft a dispatch is holding is also
       * not live, and telling the owner "it is kept so you can read what was
       * proposed" directly under "whether it went out is genuinely unknown"
       * is two answers to one question.
       */
      kind: 'notice',
      text: { path: 'notLiveLine' },
      when: { path: 'notLive', equals: true },
    },
    {
      kind: 'editor',
      query: { query: 'draft', params: { id: { path: 'id' } } },
      // A stamp, not a clock: the save carries the `updated_at` this editor
      // loaded, and a save that lost a race is refused rather than allowed to
      // overwrite what is stored.
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
        {
          // Gated, and the page draws the approval card in place — identity
          // select and all. Nothing on this page reaches SMTP.
          tool: 'email.send',
          label: 'Send',
          tone: 'accent',
          busy: 'Proposing…',
          args: { draftId: { path: 'id' } },
        },
      ],
      footnote:
        'Send does not send: it puts the whole envelope in front of you to approve, and that card is where you choose which of your addresses it leaves from. Save first if you have edited anything — the card is bound to what is stored.',
    },
  ],
};

const mail: PageDescriptor = {
  id: 'mail',
  title: 'Mail',
  place: 'rail',
  icon: 'mail',
  order: 10,
  body: [
    {
      kind: 'notice',
      text:
        'What buddi has read, newest first. A conversation with a reply waiting on it carries a "draft" pill — open it to read, edit, discard or send what was written. Accounts, rules and watcher settings are under Settings → Email.',
    },
    /*
     * Four filters and a phrase, and not one more (docs/specs/email.md §9):
     * from, since, until and "has attachments" are the ones that answer a
     * question an owner actually has in front of a mailbox. It searches on
     * submit rather than on every keystroke — a substring search over bodies
     * is not free.
     */
    {
      kind: 'search',
      title: 'Search',
      fields: [
        {
          name: 'q',
          label: 'Text',
          type: 'text',
          hint: 'A word in the subject, the sender or the body. On its own, or with the filters.',
        },
        { name: 'from', label: 'From', type: 'text', hint: 'An address, or a domain like acme.com.' },
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
      actions: [{ kind: 'link', label: 'Mailboxes and rules', to: { page: 'settings' } }],
      body: [
        {
          kind: 'list-detail',
          param: THREAD,
          list: {
            kind: 'list',
            query: { query: 'threads' },
            rows: 'threads',
            key: 'id',
            item: {
              title: { path: 'subject' },
              sub: { path: 'participants' },
              meta: [{ path: 'when' }],
              // Both facts: where the conversation stands, and whether a reply is
              // waiting on the owner. One in place of the other hid the state of
              // every conversation an agent had drafted for.
              pills: [{ value: { path: 'state' } }, { value: { path: 'draftPill' } }],
              to: { page: 'mail', item: { path: 'id' } },
            },
            empty: 'No conversations yet. buddi builds them as mail arrives.',
          },
          detail: [
            /*
             * The parts of a conversation are siblings rather than one nested
             * tree: a descriptor may be twelve levels deep, and a message's
             * attachments are already six of them below this line.
             */
            {
              kind: 'detail',
              title: 'Conversation',
              query: thread(),
              fields: [
                { label: 'Subject', value: { path: 'subject' } },
                { label: 'State', value: { path: 'state' } },
                { label: 'With', value: { path: 'participants' } },
                { label: 'Messages', value: { path: 'messageCount' }, unit: 'number' },
                { label: 'Last message', value: { path: 'lastAt' }, unit: 'date' },
              ],
              body: [],
            },
            messages,
            drafts,
            /*
             * The ended drafts. The fold is always here rather than shown only
             * when there are some: `when` would be asked against the page's own
             * data — which, inside a detail the route owns, is nothing — and a
             * question that can only be answered "no" is how a whole section
             * quietly stops existing. The list inside says when there is nothing.
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
                    pill: { value: { path: 'status' } },
                  },
                  empty: 'Nothing has ended on this conversation yet.',
                },
              ],
            },
          ],
          empty: 'Choose a conversation to read it here.',
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
       * **Picked, never typed** (docs/specs/email.md §5). A thread is named in
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
    },
  },
};

/** The five numbers the mail watchers read (docs/specs/email.md §7). */
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
        {
          kind: 'table',
          query: { query: 'accounts' },
          rows: 'accounts',
          columns: [
            { key: 'address', label: 'Address' },
            { key: 'called', label: 'Called' },
            // A reply leaves from the alias the message was addressed to, so
            // which ones a mailbox answers to is part of what it *is*.
            { key: 'aliases', label: 'Also receives as' },
            { key: 'host', label: 'Host' },
            { key: 'lastSync', label: 'Last sync' },
            { key: 'secretName', label: 'Password kept as' },
            // A mailbox buddi is not reading is worth catching an eye.
            { key: 'state', label: 'State', pill: { tone: { path: 'stateTone' } } },
          ],
          actions: [
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
        {
          kind: 'list',
          title: 'Learned, proposed',
          note: 'What buddi noticed in your own history. These decide nothing until you keep them.',
          query: { query: 'policies' },
          rows: 'proposed',
          item: {
            title: { path: 'matcher' },
            sub: { path: 'sub' },
            pill: { value: { path: 'action' }, tone: 'neutral' },
          },
          select: { key: 'id' },
          actions: [
            {
              tool: 'email.keep_policies',
              label: 'Keep',
              tone: 'accent',
              confirm: 'Keep the rule about {matcher}? It starts deciding straight away.',
              done: { path: 'note' },
              args: { ids: { row: 'ids' } },
            },
            {
              tool: 'email.revoke_policies',
              label: 'Revoke',
              confirm: 'Revoke the rule about {matcher}? Nothing proposed it again for a while.',
              done: { path: 'note' },
              args: { ids: { row: 'ids' } },
            },
          ],
          bulk: [
            {
              tool: 'email.keep_policies',
              all: true,
              label: 'Keep {count} {rule|rules}',
              tone: 'accent',
              confirm: 'Keep {count} {rule|rules}? They start deciding straight away, with no model run.',
              done: { path: 'note' },
              args: { ids: { selected: true } },
            },
            {
              tool: 'email.revoke_policies',
              all: true,
              label: 'Revoke {count} {rule|rules}',
              tone: 'danger',
              confirm: 'Revoke {count} {rule|rules}? They stop deciding anything from now on.',
              done: { path: 'note' },
              args: { ids: { selected: true } },
            },
          ],
          empty: 'Nothing proposed. A sender needs three verdicts running before buddi suggests a rule.',
        },
        addRule,
      ],
    },
    watchers,
  ],
};

/** The two screens this plugin contributes. */
export const emailPageDescriptors: PageDescriptor[] = [mail, settings];
