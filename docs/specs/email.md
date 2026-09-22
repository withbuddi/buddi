# Email: accounts, threads, policies, watchers

Status: in progress, steps 1 to 5 of 6 built and step 6's watchers with them,
2026-09-22. What remains of step 6 is the search filters (§9) and attachments
on request (§10).
review; the current plugin had no document, and this is the one it should have
had. What §13.1 asks for — policies, the gate, the backfill and the Learned
list — is implemented, with three departures noted in §5; §4's accounts are
plural, added from the settings page; and §13.3's threads, Sent folder and
thread-shaped triage prompt are in, which is what §3's `threads` and `folders`
below now describe rather than propose.

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

- `threads` (built): per account, `thread_key`, subject, participants, first
  and last message time, `state` in {waiting-on-me, waiting-on-them, closed,
  muted}, derived from who wrote last including the Sent folder, and
  `policy_id` when a thread has one. Every message carries its `thread_id` and
  a `direction` — `in` for what arrived, `out` for what the owner sent — and
  the thread is maintained as each message lands: `muted` is sticky and new
  mail never lifts it. `email.list_threads`, `email.read_thread` and the gated
  `email.mute_thread` are how the conversation is read and silenced, and the
  gate's `thread` scope matches the thread's **id**, not the `thread_key` a
  sender writes.
- `policies`: `scope` in {sender, domain, thread, list-id}, the matcher,
  `action` in {ignore, archive, label, notify, draft, hand-to-agent,
  wake}, parameters (label name, agent id, Telegram yes or no, and — on a
  thread or list-id rule — the sender it was created about),
  `origin` in {owner, learned, plugin}, `created_from` (the verdicts it
  was learned from), `revoked_at`. **A policy with `origin: learned` is
  proposed, not applied, until the owner keeps it. There is no
  exception**, promo included: "and no reply" used to be derived from drafts
  buddi itself sent, so a sender answered from a phone or from the web client
  looked here like one who was never answered. Since step 3 it is read from
  the **Sent folder** — but a mailbox is synced from the day buddi arrived,
  not from the day it was made, so the history is still only partly known and
  silencing somebody on it is not a decision buddi gets to make on its own.
  The Learned list on the settings page is where the owner applies them, one
  tap each, and the same page revokes them. Verdicts, and the reply history,
  are counted per account: three promos in the personal mailbox say nothing
  about the work one.
- `folders` (built): discovered per account, once, from the server's own LIST.
  Completion is recorded on the account (`accounts.folders_discovered_at`),
  not inferred from how many folder rows there are: a pass that lost the Sent
  row to a transient error leaves it null and the next poll lists again.
  **INBOX and Sent are synced**, each with its own UIDVALIDITY and cursor;
  every other folder is recorded and polled on request (§11). Sent is
  recognised by its SPECIAL-USE `\Sent` attribute, then by Gmail's
  `[Gmail]/Sent Mail`, then by name; an account with no Sent folder keeps
  working and simply never hears the owner's side — and keeps being listed, so
  a Sent folder created later is found. Labels applied through IMAP
  flags or Gmail labels remain future work — the port is peek-only (§5).
- `attachments`: name, type, size, and, when fetched, the artifact id.
- `events`: what the policy engine did to each message (skipped a run,
  archived, labelled, notified), so the owner can audit the silence.

Migration: the backfill (`007_threads.sql`) builds `threads` from the stored
`thread_key` per account, sets each message's `direction` from whether the From
is the account's address or one of its aliases, and takes each thread's state
from the newest message's direction — `closed` only for a conversation that is
not one: a single inbound message older than 30 days from a sender there is
already an `ignore` rule about. `004`'s seed of learned `ignore` policies —
proposals, for the reason above — is unchanged. 855 messages, a second's work.

## 4. Accounts

- Settings → Email lists accounts: address, host, folders synced, last
  sync, the vault secret's name, remove. "Add an account" takes address,
  IMAP and SMTP hosts, and the app password, which goes to the vault under
  a name derived from the address. Gmail and common hosts are prefilled.
  The secret's name is *derived*, never chosen: `EMAIL_`, the address
  upper-cased with every non-alphanumeric character turned into an
  underscore, then eight hex digits of the address's SHA-256 — so
  `owner@work.test` is kept as `EMAIL_OWNER_WORK_TEST_<hash>`. The hash is
  not decoration: sanitising alone maps `a-b@x.test` and `a.b@x.test` onto
  one name, and one name for two mailboxes means the second overwrites the
  first's password and removing either deletes the other's. `secret_name`
  is unique in the database, and the settings page refuses a name another
  row owns before it writes anything to the vault. The same name appears on
  the page, in the `accounts` row, in the keychain and in `buddi doctor`,
  which is what makes a missing secret a thing the owner can look up rather
  than guess at. Removing an account removes its vault
  entry with it, unless the row came from the `GMAIL_USER` seed, whose
  secret is named by `.env` rather than by us.
- Every read tool takes an optional `account`; absent means all accounts,
  and results carry the account. `send` and `draft_reply` take the account
  from the thread they answer; `draft_new` requires one.
- Identity: an account may list aliases; a draft's `from` is **the
  account's address**, and one of its aliases only when the owner chooses
  it on the approval card, where they are a **select** — one option per
  identity, the account's own address preselected — rather than a line of
  prose. The options come from the envelope the approval is bound to, and core
  refuses a value that is not on it, so the owner picks among exactly what they
  were shown. Nothing is derived from the original's `To` or `Cc`: those are
  headers the sender writes, and mail reaches a mailbox through Bcc,
  forwarding and catch-alls, so an alias appearing there says who typed it,
  not who was delivered to. When the delivery envelope is captured at
  ingest (`Delivered-To`, the RCPT TO), it can pick the default; until
  then the owner does.

## 5. The policy gate

Before a new message wakes anyone, the source runs the gate:

1. Find the most specific policy: thread, then sender, then list-id, then
   domain. A policy belongs to one account, or — only by the owner's
   explicit "for every mailbox" choice — to all of them; nothing derives an
   installation-wide rule from an omitted field.
   **A thread or list-id match never produces `ignore` on its own.**
   `thread_key` comes from `References`/`In-Reply-To` and `List-Id` is
   copied off the wire, so both are strings the sender chooses, and thread
   is the first scope in the order: anyone who learned a muted thread's
   root id could otherwise silence themselves past every other rule. An
   `ignore` on one of those scopes applies only when the sender is
   corroborated — the policy records the address it was created for and the
   message is from it, or the sender independently matches a live sender or
   domain policy of the same account. Every other action still starts a
   run, so a forged header can at worst ask for the treatment the message
   would have had anyway.
   A `sender` policy matches the normalised **exact** address: plus-address
   equivalence is not a rule every provider follows, and `sales+legal@` is
   not `sales@`.
2. `ignore` writes the triage row from the policy and stops. `archive` and
   `label` do the IMAP action, write the row, stop. `notify` sends the
   Telegram line and stops. `hand-to-agent` queues a run for that agent
   with the message. `draft` queues the triage agent with the instruction
   to draft. `wake` queues the triage agent as today.
3. No policy: the triage run happens, and its verdict becomes a candidate
   for a *proposed* policy after three consistent verdicts in that same
   account. A proposal decides nothing until the owner keeps it.

The gate is a pure function over the policy table and the message header,
tested without a model. What it did is written to `events` and shown on
the message's row — one row per message, carrying a status, so an event
never claims more than happened: an `ignore` writes the triage row, the
event and the stamp in one transaction, and an enqueue writes the event
`pending`, then `done` once the run exists or `failed` if it threw. A
message retried because it was never stamped updates its event rather than
adding a second one.

Three departures, as built:

- **Nothing learned applies itself.** §3 said `ignore` after three promo
  verdicts with no reply would apply at once. It does not. The Sent folder is
  synced now, so "no reply" is read from the owner's own mail rather than from
  buddi's drafts — but it is synced from the day buddi arrived, and a rule
  learned from a history that starts last month may not silence a
  correspondent of ten years. It is proposed, and the Learned list is one tap
  from applying it.

- **`archive` and `label` are refused, not performed.** The IMAP port is
  peek-only by construction — reading mail must not mutate it — so both are
  valid vocabulary with nothing behind them, and a policy carrying one is
  refused at creation with "not yet" rather than written and silently never
  fired.
- **`notify` queues a run rather than sending the line itself.** A source
  has no channel to the owner: `SourceContext` is `db`, `now`, `timezone`,
  `log` and `enqueueRun`, and speaking is an agent's act. So the action
  queues a run whose instruction is to send exactly that one line and
  nothing else. It saves the owner's attention, not a model call; only
  `ignore` saves the call.

## 6. What a triage run receives

The thread, not the message: the last few messages of the thread in order,
who wrote each, the thread state, the sender's profile (past verdicts,
policy if any, how many times the owner replied and how fast), the
account, and the owner's standing instructions. Bodies are bounded; older
ones summarised to one line the way browser observations are.

Built in step 3. The prompt carries the conversation's id, its state and its
length; the last three turns before this message quoted and bounded, the ones
before those one line each; and the owner's own habit with this sender —
how many times he has written back and how quickly — measured inside the
thread, from the Sent folder rather than from buddi's drafts.

## 7. Watchers, as sentinels

Each is a sentinel with a finding the agent verifies before speaking, all
visible and switchable on the Watchers page:

- `email.waiting-on-me` (**built**): a thread in `waiting-on-me` for more than
  N days (`waitingDays`, default 2, on the Email settings page), from a sender
  the owner has replied to before — read from the Sent folder, so an
  installation with no Sent folder says nothing rather than reporting every
  stranger. A live `ignore` policy on the sender or their domain, and a muted
  thread, are the owner's decisions and silence it. One finding per thread per
  cycle, keyed to the thread **and** the last inbound message, so a reply is a
  new fact and the old one resolves; `info` at the setting, `urgent` at a week
  — and a thread raised as `info` still wakes somebody the day it turns
  `urgent`, rather than waiting out the weekly cooldown first. Nothing older
  than a month is reported at all: an inbox arrives with years of unanswered
  threads, and a watcher that read them all out would be an alarm about 2019.
  The newest waiting threads are reported first, so the per-tick cap truncates
  the least urgent, and what it truncates is not mistaken for answered.
  Twice a day.
- `email.promised-reply` (**built**): the owner's own outbound message of the
  last thirty days contains one of a small pinned list of promise phrases —
  "I'll get back to you", "I'll send", "je reviens vers vous", "je vous envoie"
  and a dozen more in English and French, in
  `packages/tools/email/src/phrases.ts` and pinned as a table in
  `phrases.test.ts` — and nothing outbound has followed on that conversation
  since. A *second* shape of the same promise: a live draft (`draft` or
  `edited`, never claimed by a dispatch) that an agent wrote and that has sat
  unsent for longer than the setting. The two are keyed apart — the thread and
  the promising message, the thread and the draft — because they are two things
  the owner owes and resolving one must not resolve the other. `promisedDays`,
  default 3; `urgent` at a week. Twice a day.
  Its limits, honestly: it reads the owner's *words*, so "let me check" and
  "I'll have a look" are not promises here and never will be, and a promise
  kept by phone looks exactly like one that was not — which is why the finding
  tells the agent to read the thread before it says anything. A month is the
  ceiling; a muted thread and a live `ignore` on the recipient silence it.
- `email.date-stated` (**built**): a message states a date within the next 14
  days (a deadline, an appointment, a due date), and no reminder exists for it.
  The reading happens at **ingest**, on the body already in hand, and is stored
  in `email.dates` (message, day, the phrase it was read from, a confidence);
  the sentinel sweeps up what ingest missed, bounded, and raises one `info`
  finding per message-date above `dateConfidence` (default 0.6) whose day is
  still ahead. Reading and alerting are two horizons: every date the parser can
  resolve inside a year is stored when the message is read, and the fortnight
  is applied later, against the owner's clock — otherwise a date announced a
  month out, or a backlog message swept up long after it arrived, would be
  dropped by the only pass that will ever look at it. A date that names its
  year (`2027-07-05`, `30 septembre 2026`) is kept up to a year ahead; a date
  that does not (`15 September`, `22/09`) is only rolled into next year when
  that lands within a hundred and eighty days, because a day that has just
  gone by is somebody talking about last week, not booking the same day in
  twelve months' time. A pending reminder for that day on that thread silences it, and
  so do a muted thread, an `ignore` policy on the sender, and quoted (`>`)
  lines. The finding offers "set a reminder"; the agent creates it with
  `reminder.set` after reading the message. What the parser does and refuses to
  do — English and French absolute dates, slashed numbers and their ambiguity,
  weekday-plus-time against the message's own INTERNALDATE, and no relative
  words, no dotted numbers, no bare weekday — is documented in
  `packages/tools/email/src/dates.ts` and pinned as a table in `dates.test.ts`.
- `email.receipt-or-bill` (**built**): an inbound message of the last fortnight
  that a pure classifier reads as an order confirmation, receipt, invoice or
  bill, over the subject, the sender and the first lines of the body. The
  vocabulary is a pinned table with weights — `invoice`, `facture`, `receipt`,
  `reçu`, `order confirmation`, `payment received` are worth 0.55; `your order`,
  `amount due`, `montant dû` 0.4 — plus a fifth for saying it in the subject or
  the sender, and a fifth for an amount with a currency sign beside the word
  "total". `receiptConfidence`, default 0.7, so "Invoice #42" in a subject with
  a total speaks and a bare shipping notice does not. Always `info`: a bill is a
  thing to file, and a phone buzzing at a misread order confirmation costs the
  watcher its welcome. One finding per message, keyed to the message; it names
  the total when one was read — in the prose, as a number *we* parsed and a
  sign from a table of three, never the sender's own string, and never in
  `data`, which is ids and numbers only — and offers two actions in the detail, hand it
  to whoever holds the `overview` role (falling back to `mail`) and record it.
  Hourly, with the bounded catch-up dates has: bodies are classified once and
  stamped (`messages.receipts_scanned_at`, migration `011_receipts.sql`), the
  reading kept in `email.receipts`. Two bounds keep the sweep honest. Mail
  older than the fortnight is **stamped as read without being read** — it could
  never raise a finding, and reading it oldest-first for ever is how a busy
  mailbox ends up silent about exactly the fortnight this watcher exists for —
  and migration `011` does the same for everything older than thirty days on
  the day it is applied, once, so a decade of history does not become a decade
  of sweeping. The reading and the stamp are one statement, so a message whose
  reading cannot be stored is read again rather than marked read with nothing
  behind it.
  Its limits: it reads vocabulary, not documents. A receipt with no receipt
  word in it — a bank's "your statement is ready" — is invisible to it, and a
  mail *about* an invoice reads like one. A muted thread silences it, and a
  sender under a live `ignore` is neither read nor stamped — so revoking the
  rule lets the message be read after all, which a permanent stamp would have
  made impossible.
- `email.suspicious-sender` (**built**): two tests over inbound mail of the last
  seven days, and one finding per message, keyed to the message, whose detail
  says which of them fired. **(a)** the display name is one the owner writes to — read from
  the Sent folder's To and Cc of the last two years — at a different address,
  on a domain no address of that name has ever been written to. Two names are
  compared through one algorithm written twice, in
  `packages/tools/email/src/phrases.ts` and as `email.name_key` in migration
  `011`, with the DB suite holding the two to the same answers: NFKD, combining
  marks dropped, lowercased, the letters no decomposition touches (`ø`, `æ`,
  `ß`) folded, Cyrillic and Greek homoglyphs mapped onto the Latin letters they
  are drawn as, punctuation collapsed and the tokens **sorted** — so `MEYER,
  Jean-Paul` is `Jean-Paul Meyer`, `Søren Kjær` is `Soren Kjaer`, and an
  `Аna` with a Cyrillic А is `Ana`. A name has to identify somebody: the
  owner's own address and aliases are excluded, and so is a pinned list of
  generic display names (`Support`, `Billing`, `Notifications`…), which he
  writes to at a dozen addresses and which would otherwise make every second
  shop an urgent warning. It is computed in SQL on every tick rather than stamped,
  so a correspondent first written to this morning is protective this afternoon;
  it is `urgent`, because a name worn by the wrong address is never innocent by
  accident. **(b)** the body asks for credentials (0.6), a wire (0.7) or a gift
  card (0.8), from a pinned bilingual table, with a quarter added for
  "urgently" and its French **when the urgency is in the same sentence as the
  ask**. A *noun* is never a demand on its own: `wire transfer` and `gift card`
  are the words receipts and dispatch notices are written in, so they count
  only when the same sentence — the noun itself cut out of it first — carries a
  verb of sending or paying, an asking construction ("can you", "please",
  "merci de", "veuillez"), or a `to`/`vers` directly after the noun, which is
  what a wiring instruction looks like when its verb is elsewhere. Above 0.8 is `urgent`, the rest `info` — and a phrase that only
  *names* a credential rather than asking to be given it (`reset your
  password`, `verify your account`, the vocabulary of every real reset mail)
  is capped below that line and can never be more than a notice. Only somebody
  asking to be sent the thing, or to be paid, wakes anybody: §7's *«a password
  reset "urgently"»* is the phishing sentence, not the transactional one, and
  the difference is the difference between this watcher being kept and being
  switched off in its first week. The body is read once and stamped
  (`messages.suspicion_scanned_at`), the reading kept in `email.suspicions`.
  **An `ignore` policy does not silence this one**, and that is the whole point:
  an impostor sends from a domain the owner has very likely silenced, and a
  fraud that can buy its own quiet with a promotional rule is not being watched
  for. Only a muted conversation does. The finding never quotes the body beyond
  a single fenced first line, and it tells the agent to describe the message and
  reply to nothing.
  Its limits: (a) says nothing about a name the owner has never written to, one
  he last wrote to more than two years ago, one too generic to identify
  anybody, or a display name the impostor did not bother to copy — and,
  because the tokens are sorted, `May Lee` and `Lee May` are one name to it.
  That collision is accepted: sorting is what makes `MEYER, Jean-Paul` match
  `Jean-Paul Meyer`, which is the form half the world's address books produce,
  and two real correspondents whose names are each other's reverse is rarer
  than a corporate directory. The cost is a false warning, which is a warning
  the agent reads the thread about; the alternative cost is silence about the
  comma form, which is the shape an impostor would copy. (b) is a phrase table
  over a *request*, not over a noun — `Your wire transfer was processed` is a
  receipt and is read as one — so it is blind to a fraud that asks for nothing
  in its first message, which is most of them.
- `email.unanswered-by-them` (**built**): the owner wrote to somebody in the
  last thirty days, it was not a reply to a message of theirs, it *asked*
  something — a sentence ending in a question mark, or one of the pinned polite
  asks ("let me know", "can you", "pourriez-vous", "merci de") — and nothing has
  come back from anybody he addressed it to. `nudgeDays`, default 5, because
  people are allowed a working week. `info`, once, keyed to the thread and the
  message that asked; the detail offers a draft with `email.draft_reply` and
  says in as many words never to send it. Daily. "Not a reply to *their*
  message" means the earlier inbound came from somebody this message is
  addressed to — an introduction from a third party, then an original question
  to a second, is the ordinary shape of work and is reported.
  Excluded: no-reply addresses, any conversation carrying a `List-Id`, muted
  threads, a live `ignore` on the recipient, and anything the owner has already
  nudged — which is any later outbound message on the thread, whatever it says.
  Its limits: an answer that arrived by phone looks like no answer at all, and
  a question asked in a quoted line is not the owner's question, so quoted
  history is dropped before anything is read.

All six are registered and switchable. The two steps that built them left one
rule in common behind: a watcher's judgement over *text* lives in a pure module
with a pinned table — `dates.ts` for days, `phrases.ts` for promises, receipts,
asks and questions — so that what wakes the owner can be changed, and argued
with, without a database.

None of these send mail. A finding leads to a report, a draft, or a
reminder, never to a send without the card. The wake run is given the
conversation the finding is about — the same bounded, fenced block §6 gives a
triage run, with the same paragraph that says what its markers mean — and with
it the one instruction that makes a watcher safe: **verify, then report or
draft, never send.** The finding's own words are fenced too, at the source: a
subject, an address, a quoted first line and a parsed phrase are all things a
stranger wrote, and they reach a model through the wake prompt and the weekly
recap. The raw values stay in the finding's `data`, where nothing reads them as
prose.

All six appear on the Watchers page with their last run and a
switch (`core.sentinel_switches`; absent means on). A watcher that is off does
not run, and resolves nothing: what it already found stays as it was, so
switching it back on does not replay a week of news — it reports what is true
that morning, resolves quietly what stopped being true while it was off, and
says nothing about the threads that went stale in the meantime. A finding that
resolves also leaves the digest queue, so the weekly recap never reads out
something the watcher has stopped believing. The switch route refuses an id
this installation does not ship. Five numbers are on the Email settings page in
a small "Watchers" block, saved together — `waitingDays` (2), `dateConfidence`
(0.6), `promisedDays` (3), `receiptConfidence` (0.7) and `nudgeDays` (5) — and
all five are readable and writable from a chat through `email.get_settings` and
`email.set_settings`. Each is bounded, and a value outside its bounds — or one
that is not a number at all — is a 400 that says what the bounds are rather
than a number quietly clamped or coerced into range; an unset one reads as its
default. Two rules keep a bound from being a trapdoor: `receiptConfidence`
stops at **0.95**, which is the highest score the classifier can produce, so
there is no threshold the page offers that silently switches the watcher off;
and a *days* setting is a floor, never a ceiling — the history window each
watcher reads is computed from its setting with a week of room above it, so
`promisedDays: 31` reports a week of news rather than the nothing a
thirty-day window would have returned.

## 8. Drafts and sending

**Built** (step 5, migration `010_drafts.sql`).

A draft is a row with a lifecycle: `draft` → `edited` → `sent`,
`discarded` or `lapsed`. `draft` is what an agent wrote, `edited` what the
owner wrote over it, and the three after are ends.

- **One conversation, one live draft.** `draft_reply` on a thread that already
  has a live draft (`draft` or `edited`) **updates** it: a new artifact
  version, a new `updated_at`, and back to `draft`. Tapping "Draft a reply"
  twice edits one draft (§12.4). `draft_new` always creates — it answers
  nothing, so it has no conversation to hold a draft on, and two new messages
  to the same stranger are two messages.
- **An owner-edited draft is not overwritten by an agent.** Once the owner has
  saved over the words, `edited_by` is `owner`, and `draft_reply` refuses to
  replace them: the result says so and names `email.read_draft`, a read tool
  whose whole job is letting the agent see what the owner wrote before it
  proposes anything else. This is the one rule in the lifecycle that protects
  something that cannot be recovered — the owner's own writing.
- **A body change is a new artifact version, always.** The send envelope
  carries the artifact id and the body's hash, so a draft edited after a send
  was approved makes that approval unusable *by construction*. The Executor
  re-describes before dispatch; the tool compares the stored envelope against
  the approved one and refuses in the owner's own terms ("this draft has been
  edited since you approved it"). The action lands in **`refused`**, not
  `failed`: nothing was dispatched, and an irreversible effect that certainly
  did not happen must not read like one that might have.
- **Lapse.** A live draft nobody has touched for fourteen days becomes
  `lapsed`, on the plugin's own daily housekeeping pass (`email.retention`,
  which originates no run and wakes nobody). A lapsed draft is not editable and
  not sendable; it is kept, under the page's collapsed "Older drafts" list with
  the sent and discarded ones.
- **`email.send` refuses a discarded or lapsed draft at describe time**, before
  an approval card is ever put in front of the owner.

`send` sends exactly one draft, from the thread's account, with the approval
card showing to, subject, the account it leaves from, the body — and, when the
account has aliases, **a select for which of them it leaves under** (§4). That
select is an `EffectDescription.choices` entry the tool declares; core validates
the owner's pick against the declared list and hands it to `execute` as
`ctx.choices.from`. The identity on the wire changes; the mailbox that
authenticates does not.

**The Mail page** (`#/email`) carries the owner's half of this, as a place of
its own rather than a block under Settings → Email: that page is configuration,
read once and then rarely, and this is a working surface with a message list, an
editor and an approval card that dispatches mail. Conversations are listed
newest first, each a link (`#/email/<threadId>`, so a draft can be linked to and
come back to) with a small `draft` pill when one is waiting; opening one shows
the thread's messages — snippets, with a body fetched only when a message is
opened — and, under them, its drafts. A live draft shows the agent that wrote
it, its status, when it last changed, and editable To/Cc/Bcc/Subject/Body with
**Save** (status `edited`, `edited_by = owner`, a new artifact version),
**Discard** (status `discarded`) and **Send** — which does not send: it records
the `email.send` action by the same path an agent takes and shows the approval
card, alias select and all, for the owner to approve. Settings → Email keeps one
line pointing across. The routes are `/api/email/threads`,
`/api/email/messages/:id` and `/api/email/drafts` (list per thread, get, put,
discard, send), behind the same session and CSRF gate as the rest of `/api`.

**Two writers, one row.** Every rule above is in the SQL predicate, not in a
check above the write, because everything here has a second writer: an agent
drafting while the owner edits, an owner editing while a send is dispatching,
two runs drafting on one thread at once. So:

- the live-draft index is **unique** per thread, and the insert path catches the
  violation and retries as an update of the winner — "one conversation, one live
  draft" is a fact about the database, not a hope about scheduling;
- the agent's update carries `edited_by is distinct from 'owner'`, so the rule
  that protects the owner's words cannot be overtaken by the save that made them
  the owner's — **and** the artifact version it read, so two runs rewriting one
  draft cannot silently replace each other's work; a loser is told to read the
  draft with `email.read_draft` first, exactly as it would be after an owner
  edit;
- the owner's save carries the `updated_at` the editor loaded. It is
  **required**: an optional precondition is not one, and a `PUT` without it is a
  400 rather than an unguarded write. A mismatch is a 409 carrying what is
  actually stored, which the editor redraws from;
- **`email.send` claims the draft row** in `ToolDefinition.claim` — after the
  Executor's re-description, before the effect ledger row — on `status`,
  `sent_action_id is null` *and* the artifact version the approved envelope
  named. A lost claim settles the approval `refused` with no attempt recorded,
  because nothing was attempted;
- every editor of a draft carries `sent_action_id is null`, so nothing can be
  changed out from under a dispatch already in flight;
- a draft that was claimed and never confirmed (`sent_action_id` set, `sent_at`
  null) is not editable, not discardable, not sendable and never lapsed: it is
  drawn as a critical notice saying the message may already be on the wire and
  the mailbox needs checking. Hiding that is how the same letter goes out twice.

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

1. A sender judged promo three times is listed under "Learned, proposed"
   with one-tap Keep; once kept, the next message from them starts no model
   run and gets a triage row from the policy.
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
   the settings page. **Built.**
2. Accounts plural, per-account identity, secrets in the vault from the
   page. **Built.**
3. Threads and the Sent folder; the triage run receives the thread. **Built.**
4. The first two sentinels: waiting-on-me and date-stated. **Built.**
5. Draft lifecycle with the editor, and the owner's choice of sending
   identity on the approval card. **Built.**
6. The remaining four sentinels (`promised-reply`, `receipt-or-bill`,
   `suspicious-sender`, `unanswered-by-them`, §7) — **built**, with migration
   `011_receipts.sql` and the three settings that go with them; the search
   filters and the trigram index (§9) and attachments on request (§10) remain.
