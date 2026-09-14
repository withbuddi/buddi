-- email plugin schema (applied with search_path = email, public).
--
-- Identity is the quad (account_id, mailbox_id, uidvalidity, uid) — RFC 9051:
-- a UID is unique only within one UIDVALIDITY generation of one mailbox, so it
-- is never a key on its own. Message-ID is *evidence* about the logical
-- message, never the key, and is therefore nullable and unconstrained.
--
-- Lifecycle is factored on purpose (ARCHITECTURE.md, "Email ingestion"):
-- the mailbox occurrence (`messages`), what triage decided about it (`triage`,
-- versioned so a policy change can re-triage), and what the owner might send
-- (`drafts`) are three records. Send attempts are NOT here: the core effect
-- ledger is generic and owns them.

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  imap_host text not null,
  imap_port integer not null,
  smtp_host text not null,
  smtp_port integer not null,
  auth_mode text not null check (auth_mode in ('app-password', 'xoauth2')),
  -- The *name* of a vault entry, never the secret. Nothing in this schema ever
  -- holds a credential: a secrets table hands the mailbox to anyone with the
  -- database file.
  secret_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists mailboxes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  name text not null,
  -- Null until the mailbox has been opened once. A *change* means every stored
  -- uid for this mailbox is meaningless and the cursor resets to 0.
  uidvalidity bigint null,
  last_uid bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (account_id, name)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  mailbox_id uuid not null references mailboxes (id) on delete cascade,
  uidvalidity bigint not null,
  uid bigint not null,
  message_id text null,
  thread_key text null,
  from_addr text not null,
  to_addrs jsonb not null default '[]'::jsonb,
  subject text not null default '',
  date timestamptz null,
  snippet text not null default '',
  body_text text not null default '',
  has_attachments boolean not null default false,
  -- Listed for `email.read` and hashed into a send envelope. Filenames, mime
  -- types and sizes only: attachment bytes are not ingested in v1.
  attachments jsonb not null default '[]'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  -- Durability for the source contract. The ingest transaction commits rows and
  -- the cursor together; the triage run is enqueued *after* the commit, and this
  -- stamp is what makes that recoverable — a crash in between leaves the row
  -- unstamped and the next poll enqueues it. The dedup key makes the retry a
  -- no-op when the run did get created.
  triage_enqueued_at timestamptz null,
  unique (account_id, mailbox_id, uidvalidity, uid)
);

create index if not exists messages_date_idx on messages (date desc nulls last);
create index if not exists messages_thread_idx on messages (thread_key);
create index if not exists messages_pending_triage_idx on messages (triage_enqueued_at)
  where triage_enqueued_at is null;

create table if not exists triage (
  message_id uuid not null references messages (id) on delete cascade,
  -- Bumped when the triage policy changes, so a re-triage is a new row rather
  -- than a rewritten history.
  processing_version integer not null,
  category text not null,
  urgency text not null check (urgency in ('urgent', 'normal', 'low')),
  summary text not null,
  action_needed text null,
  decided_at timestamptz not null default now(),
  primary key (message_id, processing_version)
);

create table if not exists drafts (
  id uuid primary key default gen_random_uuid(),
  in_reply_to uuid null references messages (id) on delete set null,
  to_addrs jsonb not null default '[]'::jsonb,
  cc jsonb not null default '[]'::jsonb,
  bcc jsonb not null default '[]'::jsonb,
  subject text not null default '',
  body_text text not null,
  -- The draft body as a versioned artifact in the core store: an approval
  -- references an artifact version, and the preview must be what ships.
  artifact_id uuid null,
  created_by_agent text not null,
  created_at timestamptz not null default now(),
  -- The approved action this draft was sent under. Null means never sent; the
  -- atomic claim on this column is what makes `email.send` exactly-once per
  -- action id, and re-sending an already-sent draft is refused.
  sent_action_id uuid null,
  sent_at timestamptz null,
  sent_message_id text null,
  sent_response text null,
  -- Set when a claimed send did not come back cleanly: the attempt is `unknown`
  -- and needs review, never a blind retry (ARCHITECTURE.md, "Effectful side effects").
  send_error text null,
  unique (sent_action_id)
);

create index if not exists drafts_in_reply_to_idx on drafts (in_reply_to);
