-- The owner's picture behind the lock screen may come in two shapes: row 1 is
-- the picture (drawn on a wide screen, and on a tall one when it is alone),
-- row 2 its portrait version, drawn on a phone. Row 2 never stands without 1.
alter table core.lock_background drop constraint if exists lock_background_id_check;
alter table core.lock_background add constraint lock_background_id_check check (id in (1, 2));
