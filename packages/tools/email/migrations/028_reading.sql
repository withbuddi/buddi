-- What the Mail page needs to read a message as it was written (docs/email.md,
-- "Reading mail"; search_path = email, public).
--
--  - `body_html` is the HTML part the sync already downloads when a message
--    has one, sanitised at the door (`html.ts`: an allow-list of reading
--    tags, no scripts, forms, frames or external styles, links and images
--    kept only when they are http(s), cid: or a small inline picture) and
--    capped at `MAX_STORED_HTML_BYTES`. Null for a text-only message, for one
--    over the cap (the text is drawn instead) and for every message synced
--    before this column. Purged with `body_text` under the retention setting:
--    a body is a body, whichever form it was kept in.
--  - `from_name` is the display name on the From header ("Ana Duarte"), so
--    the list can name a person rather than an address. Null when the sender
--    gave none, and on older rows; the page falls back to the address.
--
-- `from_name` is never filled for older rows. `body_html` of an older message
-- is filled once, when the owner opens it in the reading pane: the plugin's
-- worker fetches that message's HTML part from the owner's mail server (a
-- peek), sanitises and caps it as above, and stores it (`worker.ts`; since
-- pre.45). A remote picture in an HTML body is never fetched by buddi.

alter table messages add column if not exists body_html text null;
alter table messages add column if not exists from_name text null;
