-- What first run learned that is not a step: the conversation the owner met
-- their assistant in, and the model account they chose while meeting it.
--
-- `steps_done` answers "what got asked"; this answers "which one". Both are
-- needed by the same reader, and a reload that cannot tell which conversation
-- the handover opened will open a second one and make the assistant introduce
-- itself twice.
alter table core.onboarding
  add column if not exists details jsonb not null default '{}'::jsonb;
