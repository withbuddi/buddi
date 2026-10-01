-- Which "buddi learned" line told the owner about a rule that kept itself
-- (docs/email.md §5; search_path = email, public). The line waits for the
-- end-of-day message and is updated while it waits; once it has gone out, a
-- rule kept later opens the next line instead of a second line for the same
-- date. Null: not told yet. Rules kept before this column were already told
-- (or never will be), so they are marked as such.
alter table policies add column if not exists learned_line text null;

update policies set learned_line = 'before-021' where kept_by = 'auto' and learned_line is null;
