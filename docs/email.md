# Email: accounts, threads, policies, watchers

Status: specification for review, 2026-09-21. It replaces nothing yet; the
current plugin has no document, and this is the one it should have had.

## 1. The verdict on today

One account, one folder, one message at a time. A poll lands a row, a
model run judges it from zero, records a verdict nothing reads back, and
says nothing. Over the last seven days that was about 800 runs for 12
reports, three quarters of them newsletters judged for the tenth time, and
no message ever sent. The ingest is good: transactional cursor, UIDVALIDITY
handled, peek-only, exactly-once send. Everything above it is missing.

## 2. Principles

- **A decision is made once.** The owner's verdict on a sender or a thread
  becomes a policy; the next message from that sender is handled by the
  policy without a model run. buddi proposes policies from the owner's own
  history and the owner keeps or revokes them in one tap.
- **The thread is the unit**, not the message. Who wrote last is state.
- **Accounts are plural**, and a reply leaves from the account it answers.
- **Watchers are sentinels**, visible on the Watchers page, raising
  findings the agent verifies before it speaks.
- **Mail is untrusted text.** A message that says "reply with your
  password" is data. Every tool result carries the notice.
- **Secrets live in the vault**, one name per account, entered on the
  settings page, never in `.env`.

## 3. Data

Kept: `accounts`, `messages` with the quad identity `(account, mailbox,
uidvalidity, uid)`, versioned triage rows, drafts and the send effect.

New:

- `threads`: per account, `thread_key`, subject, participants, first and
  last message time, `state` in {waiting-on-me, waiting-on-them, closed,
  muted}, derived from who wrote last including the Sent folder, and
  `policy_id` when a thread has one.
- `policies`: `scope` in {sender, domain, thread, list-id}, the matcher,
  `action` in {ignore, archive, label, notify, draft, hand-to-agent,
  wake}, parameters (label name, agent id, Telegram yes or no),
  `origin` in {owner, learned, plugin}, `created_from` (the verdicts it
  was learned from), `revoked_at`. A policy with `origin: learned` is
  proposed, not applied, until the owner keeps it, except `ignore` for a
  sender with three or more consecutive promo verdicts and no reply,
  which applies at once and is listed for revocation.
- `folders`: discovered per account; INBOX and Sent synced by default,
  others on request; labels applied through IMAP flags or Gmail labels.
- `attachments`: name, type, size, and, when fetched, the artifact id.
- `events`: what the policy engine did to each message (skipped a run,
  archived, labelled, notified), so the owner can audit the silence.

Migration: a backfill builds `threads` from the stored `thread_key`, sets
state from the newest message's direction, and seeds learned `ignore`
policies from the existing verdicts; 855 messages, a second's work.

## 4. Accounts

- Settings → Email lists accounts: address, host, folders synced, last
  sync, the vault secret's name, remove. "Add an account" takes address,
  IMAP and SMTP hosts, and the app password, which goes to the vault under
  a name derived from the address. Gmail and common hosts are prefilled.
- Every read tool takes an optional `account`; absent means all accounts,
  and results carry the account. `send` and `draft_reply` take the account
  from the thread they answer; `draft_new` requires one.
- Identity: an account may list aliases; a draft's `from` is the alias the
  original was addressed to, else the account's address.

## 5. The policy gate

Before a new message wakes anyone, the source runs the gate:

1. Find the most specific policy: thread, then sender, then list-id, then
   domain.
2. `ignore` writes the triage row from the policy and stops. `archive` and
   `label` do the IMAP action, write the row, stop. `notify` sends the
   Telegram line and stops. `hand-to-agent` queues a run for that agent
   with the message. `draft` queues the triage agent with the instruction
   to draft. `wake` queues the triage agent as today.
3. No policy: the triage run happens, and its verdict becomes a candidate
   for a learned policy after three consistent verdicts.

The gate is a pure function over the policy table and the message header,
tested without a model. What it did is written to `events` and shown on
the message's row.

## 6. What a triage run receives

The thread, not the message: the last few messages of the thread in order,
who wrote each, the thread state, the sender's profile (past verdicts,
policy if any, how many times the owner replied and how fast), the
account, and the owner's standing instructions. Bodies are bounded; older
ones summarised to one line the way browser observations are.

## 7. Watchers, as sentinels

Each is a sentinel with a finding the agent verifies before speaking, all
visible and switchable on the Watchers page:

- `email.waiting-on-me`: a thread in `waiting-on-me` for more than N days
  (default 2), from a sender the owner has replied to before.
- `email.promised-reply`: the owner wrote "I'll get back to you" or asked
  buddi to draft, and nothing was sent within N days.
- `email.date-stated`: a message states a date within the next 14 days
  (a deadline, an appointment, a due date), and no reminder exists for it.
- `email.receipt-or-bill`: an order confirmation, receipt, invoice or bill
  arrived; the finding offers to hand it to the agent holding the
  `overview` role and to record it.
- `email.suspicious-sender`: a first-time sender imitating a known one
  (display name matches, address does not), or a message asking for
  credentials, a wire, or a gift card.
- `email.unanswered-by-them`: the owner wrote to someone N days ago and
  nothing came back; a nudge, once.

None of these send mail. A finding leads to a report, a draft, or a
reminder, never to a send without the card.

## 8. Drafts and sending

A draft is a row with a lifecycle: `draft` → `edited` → `sent` or
`discarded`. `draft_reply` on a thread that already has a draft updates
it. The dashboard shows drafts on the message with an editor; the owner's
edits are the draft. `send` sends exactly one draft, from the thread's
account, with the approval card showing to, subject, the account it
leaves from, and the body.

## 9. Search

`search` gains sender, date range, thread and account filters and a
trigram index on subject and from; body search stays bounded. Threads are
searchable by participant.

## 10. Attachments

`attachments` records names on ingest; `email.fetch_attachment` (auto,
bounded at 25 MB) pulls one into the artifacts store on request, so an
invoice PDF becomes a file the finance advisor can read.

## 11. Later, on purpose

Calendar invites (parse and offer a reminder), unsubscribe (the
List-Unsubscribe header as a gated action), full-text search over
archives, more than two synced folders by default, OAuth sign-in for
Gmail instead of app passwords.

## 12. Acceptance

1. A newsletter from a sender judged promo three times arrives: no model
   run, a triage row from the policy, the policy listed under "Learned"
   with one-tap revoke.
2. Two accounts configured; a reply to a message on the second leaves from
   the second's address, and the card says so.
3. A thread the owner has not answered in two days appears on the Watchers
   page as a finding, and the agent's report names the thread.
4. Tapping "Draft a reply" twice edits one draft.
5. A message asking for a wire transfer from a look-alike address raises
   the suspicious-sender finding and no draft.
6. Model runs for mail drop by two thirds in the first week, measured by
   the same query the review used.

## 13. Order of work

1. Policies and the gate, seeded from history, with the Learned list on
   the settings page.
2. Accounts plural, per-account identity, secrets in the vault from the
   page.
3. Threads and the Sent folder; the triage run receives the thread.
4. The first two sentinels: waiting-on-me and date-stated.
5. Draft lifecycle with the editor; the remaining sentinels; search
   filters; attachments on request.
