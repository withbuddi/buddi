-- Who the owner is, beside what to call them (docs/agents.md, "Owner context").
--
-- full_name:      the name for letters, forms and bookings ("Samuel Okafor");
--                 preferred_name stays what the agents call them.
-- pronouns:       as the owner wrote them ("he/him"); free text.
-- birthday_day,
-- birthday_month: the day the team greets them on (the owner-birthday
--                 mission); both or neither.
-- birthday_year:  optional, only ever said as an age.
alter table core.owner add column if not exists full_name text;
alter table core.owner add column if not exists pronouns text;
alter table core.owner add column if not exists birthday_day smallint check (birthday_day between 1 and 31);
alter table core.owner add column if not exists birthday_month smallint check (birthday_month between 1 and 12);
alter table core.owner add column if not exists birthday_year smallint check (birthday_year between 1900 and 2100);
