-- Search (docs/specs/email.md §9), applied with search_path = email, public.
--
-- `email.search` was one `ilike '%needle%'` over subject, from_addr and
-- body_text across every message this installation has ever ingested. On a
-- mailbox of a few hundred messages that is a sequential scan nobody notices;
-- on a few years of mail it is the whole table, three times, for every phrase
-- an agent tries. This migration gives the two columns an agent actually
-- searches by — the subject and the sender — an index that can serve a
-- substring, and gives the date window an index of its own so the body scan
-- that remains is bounded by a range rather than by the table.
--
-- ## Why pg_trgm and not full-text search
--
-- `to_tsvector` would be faster still, but it searches *words*: a stemmed,
-- language-dependent match that finds `invoices` for `invoice` and finds
-- nothing at all for `acme-` or for half an address. The tools promise
-- case-insensitive **substring** search, and an agent looking for a sender
-- types `@acme.com`. A trigram GIN index accelerates exactly the `ilike
-- '%…%'` this plugin already does, so nothing that matched yesterday stops
-- matching today — the meaning of the search does not move, only its cost.
-- Full-text search over archives is named in §11 as later work, on purpose.

-- The extension, and it is a requirement rather than a nicety. `create
-- extension if not exists` raises when the extension is not available on the
-- server, which is what we want: a mail search that silently degrades to a
-- table scan on every installation whose Postgres lacks contrib is worse than
-- one that refuses to migrate and says why. The bundled Postgres has it.
--
-- No `with schema` clause, so it lands in the first schema of the migration's
-- search_path — `email`, this plugin's own. That is deliberate twice over:
-- pg_trgm is a *trusted* extension, so installing it here needs only the
-- create right on a schema the plugin already owns rather than superuser or
-- the create right on `public` (which Postgres 15 stopped granting); and
-- dropping this plugin's schema takes its extension with it, which is the
-- property `index.ts` advertises — deleting the plugin leaves one schema to
-- drop. An installation that already has pg_trgm somewhere else keeps it:
-- `if not exists` is satisfied by any schema.
create extension if not exists pg_trgm;

-- Said out loud all the same. `if not exists` is satisfied by an extension
-- installed into a schema this search_path cannot see, and the index
-- statements below would then fail with a message about an operator class
-- rather than about the extension. This is the sentence worth reading.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    raise exception
      'pg_trgm is required for mail search and is not installed on this database';
  end if;
  if not exists (
    select 1
      from pg_opclass c
     where c.opcname = 'gin_trgm_ops'
       and pg_catalog.pg_opclass_is_visible(c.oid)
  ) then
    raise exception
      'pg_trgm is installed in a schema this migration cannot see; install it into email or public';
  end if;
end $$;

-- Subject and sender: the two columns a search names. GIN rather than GiST —
-- these are read far more often than they are written, one row at a time, and
-- GIN is the faster of the two to search.
create index if not exists messages_subject_trgm_idx
  on messages using gin (subject gin_trgm_ops);

create index if not exists messages_from_trgm_idx
  on messages using gin (from_addr gin_trgm_ops);

-- The date window, per account, on the clock the rest of the plugin orders by:
-- the server's own INTERNALDATE, falling back to when we fetched it. Never the
-- `date` header, which the sender writes (see `threads.ts`). This is the index
-- that makes "the last 90 days of this mailbox" a range rather than a scan,
-- and so it is the index that bounds the body search.
create index if not exists messages_account_when_idx
  on messages (account_id, (coalesce(internal_date, fetched_at)) desc);

-- A thread is searchable by whoever is in it. `participants` is a jsonb array
-- of addresses and the only operator asked of it is containment, so
-- `jsonb_path_ops` — smaller and faster than the default class, at the cost of
-- the operators this query never uses.
create index if not exists threads_participants_idx
  on threads using gin (participants jsonb_path_ops);
