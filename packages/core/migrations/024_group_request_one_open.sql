-- One open request per group conversation, enforced by the row rather than
-- by whoever checked first: two sends racing each other cannot both start.
create unique index if not exists group_requests_one_open_idx
  on core.group_requests (conversation_id)
  where state in ('running', 'suspended');
