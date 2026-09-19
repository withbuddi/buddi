-- One line the owner writes about themselves — how to address them, what they
-- do, how they like to be spoken to. Read into every agent's prompt.
alter table core.owner add column if not exists about text;
