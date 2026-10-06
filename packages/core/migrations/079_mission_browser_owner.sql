-- A mission may browse in the owner's signed-in Chrome too (docs/browser.md,
-- "Missions"): `owner`, granted only by the owner's approval (a proposal that
-- says so in one line, the "Let … use your Chrome?" card after a refusal, or
-- the switch on Missions). `own` stays buddi's own browser only; null opens
-- no page.
alter table core.missions drop constraint if exists missions_browser_check;
alter table core.missions add constraint missions_browser_check check (browser is null or browser in ('own', 'owner'));
