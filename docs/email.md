---
title: "Email: accounts, threads, policies, watchers"
status: reference
updated: 2026-09-25
---

# Email: accounts, threads, policies, watchers

The email plugin (`packages/tools/email`) reads the owner's mailboxes over
IMAP, keeps conversations as threads, decides what it already knows how to
decide without a model, watches for the six things worth saying, and drafts
replies that leave only through an approval card. The limits of each watcher
are stated in §7.

## 1. What it answers

The naive shape is one account, one folder, one message at a time: a poll
lands a row, a model run judges it from zero, records a verdict nothing reads
back, and says nothing. Measured over a week on a real mailbox, that shape was
about 800 runs for 12 reports, three quarters of them newsletters judged for
the tenth time, and no message ever sent. The ingest underneath is sound —
transactional cursor, UIDVALIDITY handled, peek-only, exactly-once send — and
everything on this page is what sits above it.

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

`accounts`, `messages` with the quad identity `(account, mailbox,
uidvalidity, uid)`, versioned triage rows, drafts and the send effect, and:

- `threads`: per account, `thread_key`, subject, participants, first
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
  exception**, promo included. "And no reply" is read from the **Sent
  folder**, not from drafts buddi itself sent, so a sender answered from a
  phone or from the web client counts as answered — but a mailbox is synced
  from the day buddi arrived, not from the day it was made, so the history is
  only partly known and silencing somebody on it is not a decision buddi gets
  to make on its own.
  The Learned list on the settings page is where the owner applies them, one
  tap each, and the same page revokes them. Verdicts, and the reply history,
  are counted per account: three promos in the personal mailbox say nothing
  about the work one.
- `folders`: discovered per account, once, from the server's own LIST.
  Completion is recorded on the account (`accounts.folders_discovered_at`),
  not inferred from how many folder rows there are: a pass that lost the Sent
  row to a transient error leaves it null and the next poll lists again.
  **INBOX and Sent are synced**, each with its own UIDVALIDITY and cursor;
  every other folder is recorded and polled on request (§11). Sent is
  recognised by its SPECIAL-USE `\Sent` attribute, then by Gmail's
  `[Gmail]/Sent Mail`, then by name; an account with no Sent folder keeps
  working and simply never hears the owner's side — and keeps being listed, so
  a Sent folder created later is found. Labels applied through IMAP
  flags or Gmail labels are not done — the port is peek-only (§5).
- `attachments`: name, type, size, and, when fetched, the artifact id.
- `events`: what the policy engine did to each message (skipped a run,
  archived, labelled, notified), so the owner can audit the silence.

Migration: the backfill (`007_threads.sql`) builds `threads` from the stored
`thread_key` per account, sets each message's `direction` from whether the From
is the account's address or one of its aliases, and takes each thread's state
from the newest message's direction — `closed` only for a conversation that is
not one: a single inbound message older than 30 days from a sender there is
already an `ignore` rule about. `004` seeds learned `ignore` policies from
history — as proposals, for the reason above.

## 4. Accounts

- Settings → Email lists accounts: address, the name the owner gave it, the
  addresses it also receives as, host, last sync, the vault secret's name,
  whether it is on and where it came from, and remove. It is a **page descriptor this
  plugin contributes** ([plugin-pages.md](plugin-pages.md)), not a screen compiled
  into the dashboard: a table over the `accounts` query, with
  `email.remove_account` on each row and a drawer that writes through
  `email.add_account`. "Add an account" takes address and app password, and
  the hosts only when they differ from the ones `email.add_account` works
  out from the address — Gmail and the common providers are known to it,
  and anything else falls back to `imap.`/`smtp.` on its own domain. The
  form does not fill those hosts in as the address is typed, on purpose: a
  page descriptor carries no such logic, so the inference happens in the
  tool, and the owner sees the result in the table after it is added. The password goes to the vault under a name derived from
  the address.
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
  than guess at. The password is an owner secret bound to `email.account`
  ([owner-secrets.md](owner-secrets.md) §4, §7), and it never enters
  `process.env`. Removing an account removes its vault
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

**The triage agent is proposed, not assumed.** The poll hands
every new inbound message to `mail-triage`; the plugin proposes that agent
(`agents` in the manifest, `src/agent.ts`: @mail, role `mail`, the model-facing
email tools named one by one with memory, reminders and the canvas, never an
`ownerOnly` tool). Saving a mailbox while no agent has that id answers with a
note, and Settings → Email shows one line — "Background triage needs a mail
agent." — with **Create @mail**, the same gated `platform.accept_plugin_agent`
the Plugins page runs; Home offers it too until accepted or dismissed. Until it
exists the poll still ingests and threads mail but starts no run: the messages
stay unstamped (so the first poll after the accept triages them), it logs "no
triage agent yet — accept the Mail offer on the dashboard" once per poll, and
records `accounts.triage_waiting_since` (migration `016`), which the mailbox
row shows as "triage waiting".

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
   to draft. `wake` queues the triage agent as a message with no policy would.
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

Three rules worth stating:

- **Nothing learned applies itself.** Not even `ignore` after three promo
  verdicts with no reply. "No reply" is read from the owner's own Sent folder
  rather than from buddi's drafts, but it is synced from the day buddi
  arrived, and a rule learned from a history that starts last month may not
  silence a correspondent of ten years. It is proposed, and the Learned list
  is one tap from applying it.

- **`archive` and `label` are refused, not performed.** The IMAP port is
  peek-only by construction — reading mail must not mutate it — so both are
  valid vocabulary with nothing behind them, and a policy carrying one is
  refused at creation with "not yet" rather than written and silently never
  fired.
- **`notify` queues a run rather than sending the line itself.** A source
  has no channel to the owner: its host gives it a database, a clock, a log
  and `schedule.enqueueRun`, and speaking is an agent's act. So the action
  queues a run whose instruction is to send exactly that one line and
  nothing else. It saves the owner's attention, not a model call; only
  `ignore` saves the call.

**Writing one, from the page.** "Add a rule" is a drawer on Settings → Email
that writes through `email.add_rule` — the owner's own path to the same table,
with no approval card in the way, because they are the one acting. Two of its
fields are **picked, never typed**, and both for the same reason: the mailbox,
because a rule with no mailbox decides for every mailbox and that has to be a
choice somebody made rather than a field left empty; and, for a rule about one
conversation, the conversation itself — the database names a thread by the root
Message-ID of its chain, which is not something an owner has. The mailbox picker
reads the `accounts` query; the conversation picker reads `rule_threads`, which
depends on the mailbox above it and offers that mailbox's fifty most recent
threads as `[mailbox] subject — participants`. "For every mailbox" is a tick,
disabled for a conversation rule and refused by the tool besides.

## 6. What a triage run receives

The thread, not the message: the last few messages of the thread in order,
who wrote each, the thread state, the sender's profile (past verdicts,
policy if any, how many times the owner replied and how fast), the
account, and the owner's standing instructions. Bodies are bounded; older
ones summarised to one line the way browser observations are.

In practice the prompt carries the conversation's id, its state and its
length; the last three turns before this message quoted and bounded, the ones
before those one line each; and the owner's own habit with this sender —
how many times he has written back and how quickly — measured inside the
thread, from the Sent folder rather than from buddi's drafts.

## 7. Watchers, as sentinels

Each is a sentinel with a finding the agent verifies before speaking, all
visible and switchable on the Watchers page:

- `email.waiting-on-me` : a thread in `waiting-on-me` for more than
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
- `email.promised-reply` : the owner's own outbound message of the
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
- `email.date-stated` : a message states a date within the next 14
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
- `email.receipt-or-bill` : an inbound message of the last fortnight
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
- `email.suspicious-sender` : two tests over inbound mail of the last
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
- `email.unanswered-by-them` : the owner wrote to somebody in the
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

All six are registered and switchable. One rule is common to them: a
watcher's judgement over *text* lives in a pure module
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
`email.set_settings`. That form is the **one write on either page that is not
`ownerOnly`**, and deliberately: how long a conversation may wait on the owner
is a preference an agent may reasonably be asked to change.
Everything else the two pages write through — accounts, rules, drafts — is a
tool no model is ever shown. Each setting is bounded, and a value outside its
bounds — or one that is not a number at all — is refused with a sentence that
says what the bounds are ("The waiting window is a whole number of days between
1 and 30.") rather than a number quietly clamped or coerced into range; an unset one reads as its
default. Two rules keep a bound from being a trapdoor: `receiptConfidence`
stops at **0.95**, which is the highest score the classifier can produce, so
there is no threshold the page offers that silently switches the watcher off;
and a *days* setting is a floor, never a ceiling — the history window each
watcher reads is computed from its setting with a week of room above it, so
`promisedDays: 31` reports a week of news rather than the nothing a
thirty-day window would have returned.

### 7a. Numbers a goal can watch

Metrics are core's way of letting a goal watch a number a plugin owns
(`docs/plugins.md` §2.3a, [goals.md](goals.md)); this plugin contributes two.
The first needs migration `013_last_synced.sql`:

- **`email.waiting_on_me`** (count, down, no narrowing) — how many
  conversations are waiting on the owner. It is the `email.waiting-on-me`
  watcher's own query with `count(*)` where its findings would be, so the pile
  a goal counts and the pile the watcher nags about are the same pile: the same
  waiting window, the same "you have written to them before", the same ignore
  policies, the same thirty-day ceiling and the same **enabled** mailboxes.
  Both read that scope from one place — the shared CTE joins `accounts` and
  requires `enabled`, so a mailbox the owner switched off counts for neither.
- **`asOf` is the stalest completed poll** among the enabled accounts, read
  from `accounts.last_synced_at`, which the source stamps at the end of a pass
  that got all the way through. Not `now` — mail is only as current as the last
  poll — and not the newest sync either, because an aggregate is as fresh as
  its stalest part. An account that has never finished a poll makes the whole
  answer *not measurable*: the count would be "everything except whatever is in
  that mailbox". A mailbox that synced and found nothing waiting answers **0**,
  which is the fact `max(fetched_at)` over the messages could never state.

**`email.inbox_unread`** (migration `015_flag_sync.sql`):
messages in the inbox with `\Seen` unset, for all enabled mailboxes or one
named by `{ account }`, `asOf` the stalest completed poll as above. It needs
flags that move, so each inbox poll re-reads FLAGS (never a body) for the
newest 2,000 rows it holds and updates them in place: `CHANGEDSINCE` the stored
HIGHESTMODSEQ on a CONDSTORE server (Gmail), a capped full FLAGS fetch
otherwise. The count is taken over the same 2,000. The schema has no "still in
the inbox" field, so a message archived unread elsewhere keeps its last flags
and counts until it leaves the window.

## 8. Drafts and sending

Migration `010_drafts.sql`.

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

**The Mail page** (`#/p/email/mail`) carries the owner's half of this, as a
place of its own rather than a block under Settings → Email: that page is
configuration, read once and then rarely, and this is a working surface with a
message list, an editor and an approval card that dispatches mail. It is a
**page descriptor this plugin contributes** ([plugin-pages.md](plugin-pages.md)): a
list-detail over the `threads` and `thread` queries, and nothing in
`packages/web` knows the word "mail". Conversations are listed newest first,
each a link (`#/p/email/mail/<threadId>`, so a draft can be linked to and come
back to — the old `#/email/<threadId>` still lands on it) with a small `draft`
pill when one is waiting; opening one shows
the thread's messages — snippets, with a body fetched only when a message is
opened — and, under them, its drafts. A live draft shows the agent that wrote
it, its status, when it last changed, and editable To/Cc/Bcc/Subject/Body with
**Save** (status `edited`, `edited_by = owner`, a new artifact version),
**Discard** (status `discarded`) and **Send** — which does not send: it records
the `email.send` action by the same path an agent takes and shows the approval
card, alias select and all, for the owner to approve. Settings → Email keeps one
line pointing across. There are no `/api/email/*` routes: the page
reads through `GET /api/pages/email/<query>` (`threads`, `thread`, `message`,
`draft`) and writes through `POST /api/pages/email/act` — `email.save_draft`,
`email.discard_draft` and the gated `email.send` — behind the same session and
CSRF gate as the rest of `/api`. Save, Discard and the version precondition are
a tool's refusals rather than a route's status codes, and what a write says
back — "Saved. These are your words now…", "Discarded. It
is kept under Older drafts…" — is the tool's own sentence, drawn where the
button is.

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
- the owner's save carries the `updated_at` the editor loaded, as its
  `version`. It is **required**: an optional precondition is not one, and a
  save without it is refused rather than written unguarded. A mismatch is
  refused with a sentence saying what is actually stored, which the editor
  redraws from;
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

### Mail to yourself

The plugin carries one notification channel, `email.self`
([notifications.md](notifications.md)): with an account set up, Settings →
Notifications lists "Mail to yourself" with the account's address, and a
message sent there is a plain-text mail from that account to that same
address. The subject is the title after "buddi: "; the body is the text, the
dashboard link when there is a public origin, and any offers as lines ending
"Reply on the dashboard to act.". With several accounts, the first one
enabled is used. It declares `owner:channel` and registers from its
`register` hook.

It is the one send with no approval card, and one rule makes that safe: **the
recipient is always and only the account's own address.** The envelope is
built from the account row alone (`selfEnvelope` in `src/channel.ts`), and
`assertOwnAddressOnly` checks it again right before it goes on the wire: one
recipient, in `To`, the account's address, and `From` the same. Nothing in
the message can add or change a recipient; an alias does not count as the
own address. Anything for anyone else is `email.send`, with its card. At
most one such mail a minute is sent; more are refused with a sentence, which
the notification keeps as its error, as it keeps a failed send's reason. No
account, or none in this process, and the channel is not there.

## 9. Search

`email.search` takes a phrase, filters, or both, and needs at
least one of the two.

A one-time code a site just mailed is found with `from` (the site's domain)
and `since` (today): the agent takes the newest message dated in the last ten
minutes, and never stores or reuses the code. New mail arrives on the next
poll, up to five minutes late, so the agent searches again rather than asking
the owner at once.

- `query` is a case-insensitive **substring** of the subject, the sender or
  the body. pg_trgm's `%` similarity operator is not used: it would quietly turn the search into a fuzzy word
  match, and an agent looking for `@acme.` in an address would stop finding it.
- **The text search is a UNION, not an `OR`.** One arm is
  `subject ilike … or from_addr ilike …`, which the trigram GIN indexes from
  `012_search.sql` can serve as a BitmapOr; the other is `body_text ilike …`,
  which is a scan. They have to be separate queries: Postgres can only serve an
  `OR` from indexes when **every** arm has one, so the obvious three-column
  disjunction would touch neither index and the two GINs would be write
  amplification for no read. `union`, not `union all`, so a message matching in
  both arms comes back once.
- **Only the body arm is windowed.** Subjects and senders are searched over
  everything the mailbox holds — that is what the index is for. The body scan
  is bounded by the filters when one of them actually bounds it, and by a
  **90-day window** otherwise, and the answer says which.
  - Bounding filters are `since`, `thread` and `from`. `direction`,
    `hasAttachments` and `until` **narrow without bounding**: `direction: in`
    excludes a twentieth of a mailbox, and `until` alone *is* the older half of
    the archive, so none of them turns the window off.
  - With `until` and no `since`, the window is measured back from `until`, not
    from today: asking for the old half of the archive and being told "the last
    90 days" would find nothing while claiming to have looked.
  - The anchor is the owner's **calendar day in their own zone**, like every
    other boundary in the query. At 20:00 in New York it is already tomorrow in
    UTC, and a window taken from the UTC date would start a day off from the
    dates beside it.
- Filters, each optional: `from` (a whole address, matched exactly, or a bare
  domain, which also matches its subdomains and nothing else — `acme.com` never
  matches `notacme.com`), `since` and `until` (YYYY-MM-DD, against
  `coalesce(internal_date, fetched_at)` — the server's clock, never the
  sender's `Date` header — with `until` including the whole of the day named),
  `thread`, `direction`, and `hasAttachments`.
- **Days are the owner's days.** Every boundary is read as
  `date::timestamp at time zone <the owner's zone>`, not against the server's
  `TimeZone`, which on the bundled Postgres is UTC — eight hours out in Los
  Angeles and thirteen the other way in Auckland.
- **Malformed input is a sentence, not a database error.** One
  `validateFilters`, shared by the tool and the page query, rejects a date that is
  not a day (`2026-02-31` matches the pattern and is not one), a `thread` that
  is not an id, a one-character `query`, a range that cannot contain anything,
  and a `hasAttachments` that is not a boolean — `?hasAttachments=yes` is a
  refusal, not a silently dropped filter, because a search that quietly ignores
  half of what it was asked is worse than one that says it did not understand.
  The page query answers 400 with the sentence; the tool refuses.
- A hit carries its conversation, its direction, which mailbox it arrived in,
  its date — **the ordering clock, so the list is ordered by the value it
  shows** — and its snippet, **fenced** as quoted mail for the tool and plain
  for the page. A hit's columns are its own short list: `body_text`,
  `attachments`, `flags`, `to_addrs` and `cc` are never selected, because otherwise a
  hundred hits would mean a hundred full message bodies read out of the table
  to build a hundred snippets.

`email.list_threads` takes `participant` (an address, whoever wrote — served
by a GIN index over `threads.participants`) and the same `since`/`until`
window in the same zone, measured against `last_at`: the question "which
conversations since March" is about the ones that are still alive, not about
when they began.

The Mail page has a search field above the conversation list — text, from,
since, until, with attachments — over the `threads` page query, which answers
with the conversations and, when something narrows it, the hits. That query and
the tool share **one query builder**
(`packages/tools/email/src/search.ts`), so the owner and their agents asking
the same question get the same answer. Each result links to the conversation
it is in.

Operational note: `012_search.sql` creates the `pg_trgm` extension (which needs
CREATE on the database — pg_trgm is trusted, so not superuser) and builds two
GIN indexes under an exclusive lock on `email.messages`. See
docs/operations.md, "Mail search (migration 012)".

## 10. Attachments

Ingest records a *listing* — filename, type, size, and the IMAP
body part each file is — and never downloads bytes. `email.fetch_attachment`
(tier `auto`, `producesArtifacts`) pulls one on request: name the message, and
the attachment by `index` or by `filename`. What comes back is saved through
`saveArtifact`, so an invoice PDF becomes a file in the owner's library with a
download link, and the finance advisor can read it.

**The stored listing is a handle; the body structure is the fact.** `index`
means a position in the row the caller was shown, so the pick happens against
the stored listing — but the chosen attachment is then always re-resolved
against a **fresh body structure** immediately before the download, matched on
the part id first and on filename plus size as a fallback, never by position.
A part id is a position in a MIME tree, the tree is the server's, and the fresh
listing owes a months-old row no particular order. A part id that is not one
(`/^[1-9]\d*(?:\.[1-9]\d*)*$/`) is not stored at ingest and is not sent.

**Three layers of refusal**, each with its own sentence
(`packages/tools/email/src/attachments/safety.ts`):

1. **The name**, normalised once — basename only, NFC, control and bidi
   characters removed, trailing dots and spaces stripped (Windows strips them
   before executing, so `invoice.exe ` is `invoice.exe`), capped at 255 — and
   then used for the check, the artifact row and the download header alike.
   Refused for programs, scripts, installers, mountable images and
   macro-carrying Office documents.
2. **The declared type**, which the sender wrote, so it is a hint: the
   executable mimes and the `vnd.ms-*.macroEnabled` family.
3. **The first bytes**, once they are here and before anything is saved. PE
   (`MZ`), ELF, Mach-O and fat binaries, and shebang scripts. This is the only
   layer that cannot be lied to by renaming a file. The sniffed type is what
   gets stored, unless the sender declared something more precise about the
   same bytes — a `.docx` really is a ZIP.
4. **Inside the archive**, whenever there is a reason to look: the declared
   type is a ZIP family, the extension is a ZIP container (`.zip .jar .docx
   .xlsx .pptx .docm .xlsm .pptm .apk .odt .ods` …), or an end-of-directory
   record sits anywhere it legally could. Not "byte 0 is `PK`" — a preamble
   before the archive is legal, and must not skip the inspection.
   The central directory is parsed rather than grepped for (a `.docx` may
   perfectly well *contain* the text `vbaProject.bin` in a compressed part),
   its offset and size are checked to land inside the buffer with the
   central-directory signature actually there (so a fake end record planted in
   a comment does not win), and every loop is bounded by the buffer. Refused
   when it names `vbaProject.bin` or `META-INF/MANIFEST.MF` — **and refused
   when it cannot be read at all**: ZIP64, a truncated index, a malformed one.
   "I could not see inside it" is not "there was nothing in it".

Also:

- **Content-addressed.** A second call for the same bytes returns the same
  artifact; the artifact id is written back onto the message's listing, so the
  page draws a link rather than a second Fetch. A row whose listing was empty
  has the fresh listing written back with the mark, rather than losing it.
- **Bounded at 25 MB**, refused on the declared size *before* the download and
  cut off on the stream if the server under-reported it.
- **Mail that is no longer there is said plainly**: the mailbox was recreated
  (UIDVALIDITY moved), the message is gone, or the attachment is no longer one
  of its parts; and if the body was purged under retention the refusal says
  buddi has no copy either. An **empty** attachment is called empty, which is
  a different thing from missing.
- On the Mail page, an opened message lists its attachments with a Fetch per
  row — `email.fetch_attachment` through the page's act route, the same
  session and CSRF gate as every other write, the owner as `createdBy` — and
  a file already here carries its download link in place of the button. The
  heading is always "Attachments": a title that changes with the count is not
  something a descriptor can say, and one file under a plural heading is a
  smaller oddity than a component set that grows to fix it.

**Retention does not touch them.** The body of a message is purged on the
owner's window; the artifact a fetch produced is the owner's own file, in their
own library, and is never deleted by the mail sweep. The message row keeps its
listing, artifact id included.

## 11. Not done, on purpose

Calendar invites (parse and offer a reminder), unsubscribe (the
List-Unsubscribe header as a gated action), full-text search over
archives, more than two synced folders by default, OAuth sign-in for
Gmail instead of app passwords.

## 12. End to end

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
   the same query as the week in §1.
