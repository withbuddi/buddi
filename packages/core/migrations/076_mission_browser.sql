-- Missions that browse (docs/browser.md, "Missions"): a mission its package
-- declares `browser: own` may use browser.act unattended, in buddi's own
-- browser only, never the owner's Chrome or apps. Null for every other
-- mission: an unattended run opens no page.
alter table core.missions add column if not exists browser text null;
alter table core.missions drop constraint if exists missions_browser_check;
alter table core.missions add constraint missions_browser_check check (browser is null or browser = 'own');
