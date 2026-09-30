-- Messages an agent writes itself, `owner.notify` (docs/notifications.md,
-- "Messages from your agents").
--
-- A new kind, `agent`, on the record. `agent_messages` holds what Settings
-- says about them: { maxUrgency: 'now' | 'today', muted: [agent ids] }; null
-- is the default (now, nobody muted). On or off is `per_kind.agent`, like
-- every other kind.
alter table core.owner_notifications drop constraint if exists owner_notifications_kind_check;
alter table core.owner_notifications add constraint owner_notifications_kind_check
  check (kind in ('approval', 'question', 'watcher', 'reminder', 'failure', 'recap', 'plugin', 'agent'));
alter table core.notification_settings add column if not exists agent_messages jsonb;

-- The per-agent limits count an agent's own rows over the last hour and day.
create index if not exists owner_notifications_agent_kind on core.owner_notifications (agent_id, created_at desc)
  where kind = 'agent';
