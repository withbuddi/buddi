-- Saying no to an offer, and offers that say no for themselves.
--
-- The installation this was written against had 65 live offers and no way to
-- refuse one. Every button ever offered sat there for a week, and most of them
-- belonged to conversations that had moved on hours earlier — the owner had
-- answered in words, or the thread had rolled over, or the agent was gone. The
-- list stopped being a list of things to do and became wallpaper, which is the
-- failure mode a button is supposed to prevent.
--
-- Two new facts about a row, and they are different facts:
--
--  * `dismissed_at` — **the owner said no.** A deliberate act, on the chip or
--    the Offers tab. It is the owner's answer to the offer, and it is recorded
--    as one rather than deleted, so "I dismissed that" is a thing the record
--    can still show.
--  * `lapsed_at` — **nobody said anything and the moment passed.** The
--    conversation had an owner turn after the offer, or it rolled over or was
--    archived, or the agent that offered it was removed. Nothing was decided;
--    the offer simply stopped describing a live decision.
--
-- Neither deletes. An offer that is dismissed or lapsed leaves the live lists
-- immediately and stays readable under a fold for a week, so the owner can see
-- what they turned down; after that it is gone from every read, and the row
-- remains only for the record.
--
-- `lapse_reason` is which of the three conditions fired, for the fold and for
-- a tap that arrives afterwards — a lapsed button answers "that offer has
-- lapsed", not "already taken" and not silence.
alter table core.offers add column if not exists dismissed_at timestamptz null;
alter table core.offers add column if not exists lapsed_at timestamptz null;
alter table core.offers add column if not exists lapse_reason text null;

-- What a surface actually lists now: still offered, not refused, not lapsed.
-- The older `offers_open_idx` stays: it still answers "never taken", which is
-- what the record is asked for.
create index if not exists offers_live_idx on core.offers (created_at desc)
  where taken_at is null and dismissed_at is null and lapsed_at is null;

-- What the fold reads: the recently closed, newest first.
create index if not exists offers_closed_idx
  on core.offers (greatest(dismissed_at, lapsed_at) desc)
  where dismissed_at is not null or lapsed_at is not null;

-- Nothing backfills. Existing rows keep the expiry they were written with —
-- the shorter 48-hour life is a fact about offers made from now on, and
-- rewriting the owner's live buttons to expire sooner than they were promised
-- is not this migration's business.
