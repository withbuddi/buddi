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
--
-- The query that uses these has to be written as a UNION of an indexed arm
-- (subject/from) and a body arm, never as one `OR` across all three: Postgres
-- can only serve an `OR` from indexes by building a BitmapOr over *every*
-- arm, and `body_text` has none. See `packages/tools/email/src/search.ts`.
--
-- ## What an operator should know before running this
--
--  * **It needs the CREATE privilege on this database**, because it creates an
--    extension. pg_trgm is *trusted* (PostgreSQL 13+), so superuser is not
--    required — the role that owns the `email` schema is enough. If it refuses
--    with a privilege error, either grant that role CREATE on the database, or
--    have a superuser run `create extension pg_trgm;` once (in any schema:
--    the check below finds it and qualifies the operator class accordingly)
--    and then run the migration again. Nothing here is skippable: a mail
--    search that silently degrades to a table scan on one installation and not
--    another is worse than one that refuses to migrate and says why.
--  * **The two GIN builds hold an exclusive lock on `email.messages`** for
--    their duration. `create index concurrently` is not available: migrations
--    run inside one transaction (`packages/core/src/db.ts`), and CIC cannot.
--    On a fresh install this is instant; on a mailbox of several years it is
--    seconds to a minute, during which the poller's inserts wait. Run the
--    upgrade when no poll is mid-flight — `buddi service stop`, migrate,
--    start — rather than discovering it as a stalled ingest.
--
-- Operational notes also in docs/operations.md, "Mail search (migration 012)".

-- The extension, and it is a requirement rather than a nicety.
--
-- No `with schema` clause, so it lands in the first schema of the migration's
-- search_path — `email`, this plugin's own. That is deliberate twice over:
-- pg_trgm is trusted, so installing it here needs only the create right on a
-- schema the plugin already owns rather than the create right on `public`
-- (which Postgres 15 stopped granting); and dropping this plugin's schema
-- takes its extension with it, which is the property `index.ts` advertises.
-- An installation that already has pg_trgm elsewhere keeps it: `if not
-- exists` is satisfied by any schema, and the block below finds out which.
create extension if not exists pg_trgm;

-- The indexes, with the operator class qualified by wherever pg_trgm actually
-- lives.
--
-- The first version of this migration raised when `gin_trgm_ops` was not
-- visible on the search_path, which turned "a DBA installed pg_trgm into an
-- extensions schema" — an ordinary, sensible thing to have done — into a
-- refusal to upgrade. The extension is what matters; which schema holds it is
-- the operator's business, so this discovers the namespace and names it.
do $$
declare
  ns text;
begin
  select n.nspname into ns
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';

  if ns is null then
    raise exception
      'pg_trgm is required for mail search and is not installed on this database'
      using hint = 'Grant this role CREATE on the database, or have a superuser run: create extension pg_trgm;';
  end if;

  -- Subject and sender: the two columns a search names. GIN rather than GiST —
  -- these are read far more often than they are written, one row at a time,
  -- and GIN is the faster of the two to search.
  execute format(
    'create index if not exists messages_subject_trgm_idx on email.messages using gin (subject %I.gin_trgm_ops)',
    ns);
  execute format(
    'create index if not exists messages_from_trgm_idx on email.messages using gin (from_addr %I.gin_trgm_ops)',
    ns);
end $$;

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
