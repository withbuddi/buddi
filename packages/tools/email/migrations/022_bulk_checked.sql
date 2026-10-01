-- Whether `messages.bulk` was read from the message's own headers
-- (docs/email.md §5; search_path = email, public). Mail stored before 018 read
-- them never, so its `bulk` is false whatever it carried; the inbox poll reads
-- just `List-Unsubscribe` and `Precedence` for those, a bounded few per poll,
-- and marks them. Everything stored from now on was read at ingest.
alter table messages add column if not exists bulk_checked boolean not null default false;
alter table messages alter column bulk_checked set default true;

-- Already known: bulk by its headers, on a list, or the owner's own.
update messages set bulk_checked = true
 where not bulk_checked and (bulk or list_id is not null or direction = 'out');

create index if not exists messages_bulk_unchecked_idx on messages (folder_id, uid desc) where not bulk_checked;
