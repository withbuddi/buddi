-- Frequency goals (docs/goals.md, "Frequency goals").
--
-- "Run three times a week" is a goal on the same series as a weight, read a
-- different way: not where the number is, but how many values landed in each
-- week. The target is a count per window, so the goal row gains the window
-- (`target_per`) and a third `target_kind`; `target_value` holds the count.
-- A level goal has no window, and a frequency goal always has one.

alter table core.goals drop constraint if exists goals_target_kind_check;
alter table core.goals
  add constraint goals_target_kind_check check (target_kind in ('absolute', 'delta', 'frequency'));

alter table core.goals add column if not exists target_per text null;
alter table core.goals drop constraint if exists goals_target_per_check;
alter table core.goals
  add constraint goals_target_per_check check (
    (target_kind = 'frequency' and target_per in ('week', 'month'))
    or (target_kind <> 'frequency' and target_per is null)
  );
