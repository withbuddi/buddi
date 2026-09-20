-- One open request per *group*, not per conversation: a second conversation
-- of the same group must not run beside the first. Replaces the index 024
-- made.
drop index if exists core.group_requests_one_open_idx;
create unique index if not exists group_requests_one_open_per_group_idx
  on core.group_requests (group_id)
  where state in ('running', 'suspended');
