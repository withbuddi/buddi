-- A mission paused for a reason that is not the owner's switch: its plugin is
-- disabled (docs/plugins.md, "Disabling a plugin"). Null means not paused.
-- `enabled` stays the owner's own choice, so re-enabling the plugin resumes
-- exactly the missions it paused and leaves a mission the owner switched off
-- switched off.
alter table core.missions add column if not exists paused_reason text;
