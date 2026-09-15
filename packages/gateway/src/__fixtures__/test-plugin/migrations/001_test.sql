-- The fixture plugin's schema, applied with search_path = buddi_fixture_testplug.
create table if not exists thing (
  id integer primary key default 1 check (id = 1),
  label text not null
);
