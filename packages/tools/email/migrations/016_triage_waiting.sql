-- New mail with nobody to triage it.
--
-- The poll hands every new inbound message to the triage agent, `mail-triage`,
-- which the plugin proposes and the owner accepts. Until they do, the poll
-- keeps the mail and starts no run for an agent that does not exist — and it
-- writes down that it did so, here, so the Email settings page can say
-- "triage waiting" against the mailbox rather than leave the owner to read a
-- log line. Null again once a poll finds the agent.

alter table accounts add column if not exists triage_waiting_since timestamptz null;
