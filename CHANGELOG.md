# Changelog

What changes in buddi from one release to the next, newest first.

## Unreleased

### Added

- Agents try before they decline: every agent is told to look with the browser when it has one (your own browser where you are signed in, or buddi's with a login you stored in Keys and secrets, asking you to take over at a code it cannot answer), to hand a colleague's question to that colleague and relay the answer, and only then to say exactly what it lacks with one next step. An agent without the browser says it could look if you gave it browser control.
- Catalogue agents can be given the browser's stored logins (`secret.list`, `secret.fill`) and colleagues to hand work to: a package's `delegates` resolve at install to the agents you have, an agent added later joins the lists that name it and the front desk's, and the approval card says who may ask whom.

- A news edition in chat is drawn as an edition card: its name and time, the voice note as a waveform, its first sentence, each topic with its stories (the outlet's logo, the headline with Update or Opinion, Anchor's line, the outlet linked out and "and N more"), and the next edition's time. The text as sent is one tap away under "Show as text", and is what shows when News cannot read the edition back.

### Changed

- Reports on Telegram keep their formatting: headings become bold lines in capitals (an edition's topics), bold, italic and code show as such, and a link sits on its words instead of being spelled out; raw addresses stay as they are, and a long report still splits at a paragraph (before a topic when one is near), never inside a link. If Telegram refuses the markup, the report goes as plain text.

## 0.1.0-pre.36 — 2026-10-03

### Added

- Two scripts for working on buddi: `pnpm test:db` runs the suites against a throwaway Postgres in Docker (migrated first, removed afterwards, never the dev database), and `pnpm release pre.N` cuts a release: stamps new API routes, dates the changelog, refreshes the API and CLI pages, commits, tags and pushes.
- Plugins can sign in to a CalDAV or WebDAV account without holding its password (host API 1.26): the password is an owner secret bound to the plugin and the account's host, and buddi itself adds the sign-in to the plugin's requests, for the calendar verbs only, with small bodies, capped answers and at most 120 requests a minute. Settings → Secrets shows such a password under its plugin, as "A plugin’s sign-in".
- A plugin page's table can show a row's own colour as a dot before a cell (`swatch`, host API 1.26): Settings → Calendar draws each account calendar's colour beside its name.
- Plugins can keep small images they fetched, like an outlet's logo (host API 1.27, `assets`): buddi re-draws them as 64 and 128 px PNGs (SVG refused), serves them only to the signed-in dashboard, keeps at most 20 MB per plugin, and removes them with the plugin. The install card says "keeps small images it fetched, like logos".
- Plugin pages can show logos on a list row (up to three overlapping, then "Reuters and 3 more", a letter when there is none) and on a widget's rows at medium size and on the lock screen, always from buddi and never from the outlet (host API 1.27).
- A plugin page can link out to an article: the link opens in a new tab, with no referrer, and an outside-link mark (`href`, host API 1.27). The dashboard still loads nothing from outside buddi.
- A mission can read a plugin's material before it runs (`context`, host API 1.27), so an edition is written in one model call; it can send a longer report (`reportMax`, up to 6,000 characters, split at paragraphs on Telegram); and its report can carry a dashboard link ("Open edition") and a voice note, which Telegram sends before the text and the chat plays above it.
- Plugins can name plugins they work better with (`optional`, host API 1.27) and ask whether one is there (`ctx.buddi.plugins.has`), so a setting can say "Needs Speech" instead of failing.
- A `news` page icon, a folded newspaper, for plugin pages (host API 1.27).
- Plugin pages can draw a feed of stories as the News kit does (`stories`, host API 1.27): cards with their outlets' logos, quiet marks (Opinion, EN · FR, "Told you · this morning"), a ⋯ of ways out that leave "Hidden · Undo" in the card's place, groups with See all, and a sheet per story with its sources linked out and how it moved. Also: buttons in a page's head, topic chips with an add chip, a tab kept in a page parameter, a quiet one-line notice ending with a link, an intro read from the page's data, and list rows with a logo, a small tag, a status line and a ⋯ menu.
- Widget lists can ask for five rows at medium and let a headline take two lines (`max`, `wrap`, host API 1.27), and draw a row's logo at small size too (a letter tile when the outlet has none); a widget set to several topics names itself after them ("Top stories · AI, US politics").

### Changed

- The catalogue update sheet shows where in the persona a change sits: each change comes with two lines of muted context and its line number, and the unchanged lines between changes fold into a "⋯ 12 lines" row. `buddi agents update` prints the same. `POST /api/catalogue/:name/update/plan` returns `personaDiff` as unified hunks (`@@ -a,b +c,d @@` and context lines).

### Fixed

- `buddi dashboard --unlock` no longer lands back on the lock screen when an older dashboard tab is open in the same browser: that tab's idle lock is refused for a session someone used more recently, and a tab only tells the others it locked once the server agrees.
- A plugin's settings link without a tab (`#/settings/p.news`) opens the plugin's first settings tab instead of an empty page.
- The npm release now ships the macOS computer helper behind "Use my apps" (a universal arm64 + x86_64 binary, signed ad hoc, built by a macOS job in the release workflow); before, a Mac installed from npm had none and Settings said "Computer helper unavailable … ENOENT".
- Settings → Computer & browser no longer shows a red error when the computer helper is missing: the "Use my apps" choice carries one line saying so and how to fix it, and Check again answers instead of failing. `buddi doctor` prints a "computer helper" row on macOS (present, and its version).
- Settings no longer asks to update the browser extension just because buddi's version differs from it ("buddi is 0.1.0-pre.35; the extension is 0.1.0"): it asks only when the extension is older than the minimum this buddi needs, which the store's current build meets.
- A tool name in a catalogue listing's owner-facing text (pitch, description, about, what changed, examples, mission names, skill descriptions), such as "(artifacts.write)", is rewritten in words from the tool's description, or dropped, wherever buddi shows it.
- A scheduled mission run now tells the agent its mission's own report cap (`reportMax`, such as 4,000 characters) instead of always 1,500, and that Telegram splits a message past 4,000 characters at paragraphs; a morning edition had dropped stories to fit the wrong limit.
- A plugin request that carries an owner secret can no longer be steered to another server: caller-set `Host`, forwarding and `Proxy-Authorization` headers are dropped, and TLS always names the URL's own host. The sign-in budget (120 a minute) is now shared by every run of a plugin instead of reset per run, a refused or pending sign-in no longer uses it up, and a response cap that is not a whole number (`NaN`) falls back to the default instead of lifting the cap.
- A plugin's logo can no longer exhaust buddi's memory: images are capped at a megapixel (2048 on a side) before any pixel buffer is made, a PNG with a second header or data that inflates past its own size is refused (also inside an ICO), a GIF frame must fit its canvas, and decoding runs one at a time in a worker thread with a memory limit and a five-second deadline.
- A mission's material (`context`) now reaches its run between unique data markers, with the reminder that it is data after it; when the material cannot be read, the run gets a fixed sentence and at most 200 characters of the plugin's error, inside the same markers, instead of the whole error. A mission report's voice note is refused when the run has no conversation to prove it was made there.
- A catalogue update now brings missions the agent already has the package's new material and report length (`context`, `reportMax`): the update sheet and the approval name each one ("Morning edition: new settings — …"), and approving changes just those two settings, never the mission's prompt, hour or switch. Before, installed missions kept their old settings for good.
- The idle lock lands on time again: the page's claim says how long it saw no use, and the server allows for its own record trailing the use by up to 40 seconds, instead of refusing ordinary idle locks and leaving the lock to land at twice the delay.
- Logos on the lock screen's widget rows draw instead of falling back to a letter: plugin assets are answered while locked.

## 0.1.0-pre.35 — 2026-10-03

### Added

- Agents can write documents: with the new `artifacts.write` tool an agent saves a report (Markdown) or a table (CSV, or JSON rows) into Files, credited to it and the conversation; the same title again saves a new version. The Download in Files and on the file's canvas card becomes a menu, and buddi itself converts: Markdown to PDF or Word, a table to Excel. On Telegram a written document arrives as the .md and a PDF. A shipped skill, "writing-a-document", says when a file beats a chat answer and how to shape it. Files search also finds the label a document was filed under.

- Telegram: "Still useful?" for a quiet watch now has Keep and Stop buttons, alone or after the end-of-day message. Only the owner's tap counts, a second tap says what already happened, and the message is edited to show the outcome.

### Fixed

- "Still useful?" is answered once: Keep then Stop on Telegram no longer switches the watch off, an old prompt's button no longer acts on a later question or a re-enabled watch, and a Telegram tap racing the dashboard's Keep or Stop applies only one of them. A later tap says what was decided; the dashboard's Stop answers the question too (`POST /api/missions/:id/still-useful`).
- `artifacts.write` numbers versions over the whole conversation and under a lock: a report pushed out of the newest 100 files no longer comes back as `Report.md`, and two writes at once no longer both become `(v2)`. Bytes already in Files from another conversation are reported as already there instead of "Saved". Host API 1.25: `files.save` takes `version` and says `existed`.
- A JSON table for `artifacts.write` is checked while it is read: thousands of objects with distinct keys are refused at the 201st column instead of building rows × keys cells first, and a row wider than its header is refused in every shape. A written document is at most 512 KiB.
- Converting a document can no longer freeze or exhaust the gateway: PDF, Word and Excel are made in a worker thread with a memory limit, one at a time (a second download is told to retry in a few seconds), and stopped after 15 seconds. Markdown too deep, with too many parts or with runs of `*`/`_` that would take the reader minutes is refused at once, and so is a CSV whose ragged rows would pad to millions of cells; conversions take at most 512 KiB. On Telegram such a document arrives as its .md with a note instead of a PDF.
- A document too large to convert still downloads: "as written" in the Download menu is the plain download, and the export route hands the stored format back at any size. A file whose contents are gone from disk answers 410 instead of an error.
- `buddi status` (and every other command but `serve`) no longer prints "agents: … has its own skill … it shadows the shared one" above its output. The line stays in the gateway's log; a command shows it on stderr with `BUDDI_DEBUG=1`.

## 0.1.0-pre.34 — 2026-10-02

### Changed

- The chat canvas gathers a turn's web reads and searches into one **Sources** tab with a count, instead of a "Web · Read" tab per call: each page as a card (site tile, linked title, when read, length, the text taken behind Show more, failures in plain words) and each search with its results, the ones read marked. Raw JSON stays one quiet link away.

### Fixed

- A conversation with Claude no longer dies after a long tool-using turn with "`thinking` or `redacted_thinking` blocks … cannot be modified": Claude's encrypted (redacted) thinking is now kept with the turn, so every thinking block goes back exactly where it was; and when Claude still refuses the thinking it is handed back, buddi retries that request once without the earlier turns' thinking (then without thinking at all) instead of failing every turn from then on. Conversations already stuck this way work again.
- Thinking that came from another provider is no longer sent to Claude as an empty text block, which Claude refuses.
- Gemini: a tool call that comes back without its thought signature in first place (two steps of a turn merged into one) is vouched for with Google's placeholder, so the request is not refused. The mission failures with "missing a thought_signature" seen before 0.1.0-pre.30 were runs from before that fix.
- `web.read` no longer hands back a compressed page as garbage text (Amazon sends gzip even unasked): the reader unpacks gzip, deflate, Brotli and zstd (asking only for those), reads the page in its own charset (header, then `<meta>`), refuses whatever is still binary as "unreadable", and reports a robot check or captcha page as "turned away" instead of reading it.
- The Sources tab shows a read that came back as unreadable characters (from before this fix) as "Couldn’t read amazon.com — The page came back unreadable." instead of the garbage.
- Claude answers with citations no longer break mid-sentence onto separate lines (". It has" / "Intel Iris Xe graphics" / "."): the pieces Claude splits a cited answer into are joined into one passage, and messages already stored that way read as one.
- Removing an agent (Remove from team, Agent Father, `buddi agents remove`) now takes it off every other agent's delegate list, and the remove preview says which agents will stop handing work to it. A delegate list that still names an agent that is gone (like @concierge's after earlier removals) is ignored with one log line instead of offering a colleague that does not exist.
- Activity no longer shows Claude's encrypted thinking: a transcript draws it as "Thinking (hidden)" and its ciphertext and signatures never leave the gateway, in any dashboard response.
- Removing an agent finishes even when another agent's delegate list cannot be written (a read-only folder, a full disk): the agent still leaves the catalog, its missions are paused and the trash path is given, and the dashboard and `buddi agents remove` name the lists that still mention it.

## 0.1.0-pre.33 — 2026-10-02

### Fixed

- Adding a catalogue agent whose skill is named like one of your shared skills (Researcher's `answering-with-sources` beside the one the web plugin imported) no longer fails: that agent uses its own and every other agent keeps the shared one. The Skills page lists both, and giving the shared one to that agent is refused with a reason.
- Agents from before buddi recorded where agents came from (an old @scout or @ledger with no `plugin.json`) are matched to the catalogue package that replaces them by directory, id and handle, so the catalogue offers "Update @scout to Researcher" instead of adding a second one; an agent you changed gets Keep mine or Replace my changes, and the update keeps its handle, memory and missions.
- The Skills page no longer shows a shared every-agent skill as used by an agent that has its own skill of that name: it reads "Every agent except @researcher (has its own)" and that agent's picker leaves it unticked. Giving a shared skill to agents that use another agent's own skill of the same name (`researcher/sources`) is refused, naming them, instead of silently replacing it, and that skill's holders list only agents that actually load it.

## 0.1.0-pre.32 — 2026-10-02

### Added

- The agent catalogue: ready-made agents from withbuddi.com (Chief of Staff, Researcher, CFO, Chef and more), each added with one approval. A missing by-buddi plugin is installed on the way, only when its package matches what withbuddi.com lists; the picks you answer (a mailbox, a mission's hour, a line about you) are written after the persona, and its missions arrive off unless you turn them on. Routes `/api/catalogue…`.
- Updates from the catalogue are offered, never written on their own: an untouched agent is rewritten from the new version with the same picks after you approve the diff, and an agent you edited is left alone unless you replace your changes (your file goes to the trash).
- The catalogue on the dashboard: Agents → **Add a teammate** opens it (`#/agents/catalogue`), with a search, the six categories and a card per agent (Add, Added, Update, See what changed); each agent has its page with what it does, example asks, its skills, what it can reach, its missions and plugins. Add opens one sheet with the plugins installed on the way, a few picks, the handle and the missions (off), then follows the install to "is on your team" or says what failed with Try again. Update shows the diff; an agent you edited offers Keep mine or Replace my changes.
- First run's handover asks "Who do you want on your team?" with three or four teammates picked from what you set up, ticked; Add these adds them in one go. Home suggests three while your team is new, then shows an Add a teammate tile; Browse gains All · Plugins · Agents.
- An agent's page says when it came from the catalogue, with Update when there is one, and Setup ends with Remove from team, which shows what removing pauses and which plugins nobody else uses before it does it.
- Agent Father reads the catalogue and adds an agent from chat (`platform.catalogue`, `platform.install_agent`), asking the picks in words; the approval is the same one the dashboard makes.
- `buddi agents catalogue`, `buddi agents add <name>`, `buddi agents update <handle>` and `buddi agents remove <handle>`, through the running service.
- Skills, server side of the Skills page: every skill listed in four groups (yours, learned, from plugins, from the catalogue) with the agents that use it; write a new one, save one from a single `.md`, edit its text (a learned one becomes its next version; a plugin's reads only), give it to every agent or to some, mark an upload as yours, download, delete. Who uses a skill is written in each agent's file (`skills:`), and another agent's own skill is given as `<agent>/<skill>`. Routes `/api/skills…`; the dashboard page comes next. `buddi skills list` prints it.
- An uploaded skill is untrusted until you mark it as yours: its text reaches the agents fenced as outside text, never as instructions.
- The Skills page on the dashboard: Agents → **Skills** lists every skill grouped yours / learned / from plugins / from the catalogue, with who uses each; a sheet per skill (who uses it with Take away and a picker, the text as Read · Source, edit in place, Download, Delete that says what it stops); **Write a skill** and **Upload a .md** (untrusted until marked as yours). An agent's Skills tab now lists the skills it uses with **Choose skills…** and **All skills**.
- Asked for a new agent, the front desk checks the catalogue first and offers the match as a button ("Add Chef") that opens its install sheet; when nothing fits it offers "Continue with Agent Father", which moves the conversation to Agent Father with your request. On Telegram both are buttons too (Add Chef is a link to the dashboard when it has an address the phone can open). The front desk still cannot ask Agent Father itself: only your tap starts it. Installs pick up the new front desk with the upgrade; a private copy of the concierge keeps its own wording (docs/agents.md).
- A catalogue agent's page titles each of its skills with its description, and each opens to its text; a card that reads mail says "Uses your mailbox" once one is connected; an agent the catalogue no longer lists shows under "No longer in the catalogue" and its own page says it keeps working with no updates coming.
- `GET /api/agents` says which agents came from the catalogue (`catalogue`: package, version, the listed version, drift, delisted), read from the kept list without fetching, so an agent's page no longer loads the catalogue; `/api/catalogue` cards carry each skill's name, description and text, and a `mailbox` flag.
- A catalogue agent's picture shows wherever its face appears (the rail, the chat, its page, Home, the Skills page, the catalogue's delisted list), drawn from the copy buddi keeps at install, so it works offline; an agent whose picture did not arrive at install gets it with its next update, a picture you chose is never replaced, and an agent without one keeps its initials.
- `BUDDI_MARKET_URL` is documented for trying catalogue packages from a local copy of the market index on a throwaway installation; a gateway test installs every lineup package from a copy of the index.

### Changed

- Editing or deleting a skill that came with a catalogue agent counts as editing that agent: its next update asks before replacing your change, and Replace my changes puts your version of the skill in the trash too.
- Giving a catalogue agent a skill, or taking one away, no longer counts as editing it: its updates stay one click, and an update keeps the skills you gave it. Changing its persona or tools still counts.
- A catalogue agent that needs a drawing account (Illustrator) counts one only once it is chosen in Settings → Image, since a linked account nobody chose is refused when it draws; its fix reads Choose a drawing account and opens that page.
- A picture on an agent's face (the rail, the dashboard's avatars, a group's stacked faces) sits on the agent's soft colour instead of grey, so a catalogue agent's cut-out Blob is drawn on its own tile as in the design kit.
- Removing an agent also pauses its missions, in the same approval, and names the plugins no other agent uses (they stay installed).
- The old Add a teammate cards (the starter team) are gone from Home and the Agents page; the catalogue replaces them. Agents → Add an agent became Add a teammate; a teammate the catalogue does not have is one Ask Agent Father away.
- First run no longer says Ledger or Illustrator is ready to be introduced, and its chapter 3 tiles no longer name a teammate; the handover suggests catalogue teammates instead.
- The starter team (Scout, Planner, Keeper) is gone from buddi: Researcher, Chief of Staff and Home Manager replace them in the catalogue. A Scout, Planner or Keeper you added keeps working with its handle and its data, and is offered its catalogue version while you have not edited it; the same goes for Ledger (CFO) and Illustrator. First run no longer says Planner is ready to be introduced.

### Removed

- `GET /api/teammates`, the old Add a teammate list; the catalogue replaced it.

### Fixed

- A catalogue update approves exactly the plan it showed: `update/plan` answers a fingerprint (the package's integrity, the resolved grant, the file's and every affected skill's hash) that `POST /api/catalogue/:name/update` now requires, refusing with 409 `plan-moved` when anything moved; the dashboard and `buddi agents update` send it, and an approval raised from chat binds each skill's hash too, so a skill edited after the preview is never overwritten.
- Adding a catalogue agent whose plugin was missing no longer shows the listing's tool claims (outside its integrity) and then approves whatever the plugins resolved: the sheet lists the package's own tools, and when the grant that resolves is not the one the click carried, the install job stops at `confirm` with the grant as it is (`POST /api/catalogue/jobs/:id/confirm`; Add / Don't add it on the sheet, a question at the terminal, never `--yes`).
- A catalogue update no longer overwrites a skill of your own (or a learned one) that has the same name as one the new version brings: it counts as an edit, is replaced only when you replace your changes, and goes to the trash first.
- Skills a catalogue update drops now go to the trash instead of running on with no provenance; one you changed waits for Replace my changes.
- An install or update the agents would not load with (a private skill named like a shared one) is undone and fails, instead of reporting success and breaking the next restart.
- Two clicks on Add at once make one install job, and a job in flight is never dropped from the job list.
- An agent's watch approved too late (its end already passed) no longer creates an enabled mission without an end: the end the owner approved is used, checked before anything is written, and the mission, its schedule and its end are written in one transaction.
- Missions stop themselves: every mission run is told its own id, and a run of an agent's own watch is told to call `schedule.cancel_mine` and say so once when its goal is met or no longer applies (it now holds that tool whatever its file grants), so a watch whose answer is known stops firing every hour.
- A watch an agent proposes carries when it is done (`stopWhen`) and an end (`endsOn`, 30 days unless it names a day); past its end it switches off quietly and stays listed as ended. Your own missions and plugins' have no end.
- An agent's watch that told you nothing for 48 runs in a row asks once in Needs you, "Still useful?", and its card on Missions offers Keep (the count starts again) and Stop. Route `POST /api/missions/:id/keep`.
- Take over in "Your browser" mode with Chrome closed on the host no longer shows an empty live view: it says "Your browser isn't connected", with Try again once Chrome is open, or Use buddi's browser instead (releases the session and switches to buddi's own browser).
- Failed sign-ins are counted per arrival path: a tunnel or another forwarded path that runs into the lockout no longer locks out the Mac itself or a tailnet device, which each keep their own count.

## 0.1.0-pre.31 — 2026-10-02

### Added

- The buddi extension is on the Chrome Web Store. Computer & browser → Your browser now leads with Add to Chrome (the store listing, in a new tab) and folds the load-unpacked folder under Developer install; Firefox and Safari are told it needs Chrome, Edge, Brave or Arc, and a phone leaves the install out. The dashboard finds and pairs a store-installed extension exactly like the unpacked one.
- Plugins (host API 1.24): `owner.notify` takes an optional `action`, what the owner is asked to do in at most 80 characters, like an agent's. A plugin's message with one waits in Needs you and counts on every badge; without one it stays information.
- Plugins (host API 1.24): a `clocks` widget body's faces take optional `latitude` and `longitude`; with them a face is light from sunrise to sunset there.

### Fixed

- Profile: a reload of the same profile no longer wipes Time or Dates you were changing.
- Home: Done on a Needs you card now sticks. A line held for the end of the day (like "buddi learned 1 rule: quieted 1 newsletter") showed in Needs you even after Done and came back on every reload; Needs you now lists only what asks for you now, quiet lines stay in Notifications → Recent and the evening message, and a quiet line that says more later stays read instead of coming back unread.
- Needs you: a message updated with a new or changed request comes back unseen even when it is not urgent, instead of staying marked as read; the same request sent again stays read.
- Telegram: the end-of-day message and the one after Do not disturb now say what each item asks of you ("→ Charged twice: Confirm with the bank?"), not just its title.
- Needs you: a request that asks for something waits until you open it, mark it Done or act on it, however long you were away; it no longer drops out after a week.
- Needs you counts every pending approval, not the first 50, and an agent already waiting for your approval is no longer counted a second time as one to set up when more than 50 approvals are pending.
- Home: closing several notices at once, or closing one while hiding a glance, keeps every change; one could undo another and come back after a reload.
- Home: a plugin's card is named by its page ("Mail"), not its id ("email").
- Mail: a conversation you archive, label or delete in another mail app (or with a change you approved) no longer says "Waiting on you" — on the Mail page, the Waiting on you widget, the waiting watcher and `email.select_messages` alike. Moved back into the inbox, it waits on you again.
- Schedules follow your timezone. A mission, a recurring reminder or an agent's schedule made without naming a zone now moves when you change the timezone in Settings → Profile, so its next run stays 8 AM where you are — including buddi's own missions made before 0.1.0-pre.29 (a plugin's default missions, the learning digest, an accepted agent's missions), which kept their old zone; any other older schedule keeps its zone, since buddi cannot tell whether it was named on purpose. One whose zone was named on purpose (by the agent, the plugin or you) keeps it. Missions say "follows your timezone" instead of the zone.
- The World clock's analog faces are light from sunrise to sunset at each place, worked out from the place's coordinates, not from 6:00 to 18:00 — a face for a town without coordinates still uses 6 to 18.
- `buddi doctor` in an installed buddi says which timezone is in use and where it comes from (Settings → Profile, `BUDDI_TZ` or the default), as the checkout's doctor does; both also name this machine's zone when it differs.

### Changed

- The npm page is a product page: what buddi is, the one-line install, screenshots, privacy and links. The repository README is now the developer guide.
- `buddi status` counts what needs you by the dashboard's rule (the same count as Home, the rail's badge and the lock screen) and says "3 things need you", not just approvals and questions. In `--json`, `needsYou` keeps its `approvals` and `questions` and adds `total`, that count.
- Needs you holds only what you can act on: approvals, the watchers' urgent decisions, a question an agent is holding for your answer (now listed, opening its conversation), a message that carries an action, failed jobs, proposals, a connection to sign in to again or review (moved into Needs you), an agent a plugin needs and a restore's checklist. A mission's report, an agent's plain message and a reminder that fired still reach you on your channel and are listed in Settings → Notifications → Recent ("All notifications" on the section), but no longer sit in Needs you or count anywhere. Home's counts, the badge on Home in the rail (which counted approvals and failed jobs only) and the lock screen (which counted every unseen notification, now "N more need you" opening Needs you) all read one count, `needsYou` on `GET /api/overview`; `GET /api/notifications?needs=1` lists the messages, each row says `needsOwner`. A watcher's or source's error moved above Needs you.
- `owner.notify` takes `action`: what the owner is asked to do, in a few words ("Confirm with the bank?"). With it the message waits in Needs you until opened or marked done, and Telegram shows the ask as its last line; without it the message is information. The MCP overview's `needsYou` is the same count (the per-agent list is `waiting`).
- Home: "What buddi learned this week" reads like a person wrote it — one line per kind with one place to look ("Remembered 18 things · See memory", "Quieted 26 senders · See rules", "Kept 2 skills: …", "Your rules handled 436 emails") — with no raw rule lists, no cut-off notes and no empty sections. It shows for three days after the digest runs and × hides it until next week's. The Telegram digest says the same lines.
- Home: every notice and section can be closed and stays closed across reloads and browsers — the upgrade notice until the next version, a connection's or a watcher's or source's error until it changes, a plugin's section until shown again in Settings → Appearance → Home sections. `POST /api/home/dismiss`.

## 0.1.0-pre.30 — 2026-10-01

### Added

- Alerts: every row has a primary action and ways out — Not now (back in a week), Stop telling me this (silences that account or sender, or the whole kind; taken back under Silenced in Settings → Watchers) and Clear all with Undo. Stale balances open one quick form listing every account with its last value; an unsent draft offers Open draft, Send (still approved by you) and Discard; files never used offer Review and Not needed; Ask hands the agent the watcher's brief and the thread shows only what you asked about.
- Failed jobs can be dismissed. Activity → Jobs now opens on what gave up, one row per cause ("Gemini quota (429) · 4", "Gemini thought_signature (400) · 6") with why in plain words, the agents and when; Retry (the main action when the cause has likely passed — a quota that has reset, a bug fixed since) and Dismiss per group, per job and for all, with Undo. Dismissed jobs stay listed under Dismissed and leave the footer's "N failed", Home and `buddi doctor`; a failed job older than 14 days is dismissed on its own. `buddi jobs dismiss <id>|--all`, and `buddi jobs --state failed` says which were dismissed and groups them by cause. `GET /api/jobs/failures`, `POST /api/jobs/dismiss`, `/api/jobs/undismiss` and `/api/jobs/retry` (by ids, group or all).
- The lock screen has a new background, Earth — a photo of the planet's limb from high above (by ActionVance on Unsplash, credited under the swatches) — and it is the default: a new buddi, and anyone who never picked a background, gets Earth. A background you picked stays. It is the same in light and dark, a phone gets its own portrait crop, and the time and the PIN keep light ink over it.
- Mail: a Show filter over the conversations — All, Needs a reply, Notifications. Needs a reply is exactly what the Waiting on you widget on Home counts. `email.list_threads` and `email.select_messages` take `needsReply`, and each conversation an agent reads says whether it needs you and why.
- Plugin host API 1.22: the tile icon `moon-cloud`, a partly cloudy night; and a page's tab bar may hold one tab with a pick, drawn as the pick alone — a filter over one view.
- Plugin host API 1.23: a watcher's finding carries an owner line (what the owner reads) apart from its brief for the agent, a kind and a subject that group repeats into one row, a group title, and the actions the owner can take from the row — open a page, run one of the plugin's own tools (gated ones still ask), a quick form, ask the agent, or set it aside.

### Changed

- Activity → Alerts lists only what needs a decision, in one plain line each — never the instructions a watcher writes for an agent — with repeats of one kind as one row ("9 balances not updated in 2+ weeks", the accounts inside). What the watchers notice in passing goes to the recap: the "Waiting for the weekly recap" table is now one line ("12 notes saved for Friday's recap · Preview"), and the info/urgent pills are gone, urgent kept as a quiet mark. Home's Needs you says the first decision in the same words; the recap reads the owner lines too.
- `buddi jobs retry --all` leaves dismissed failed jobs alone; retry one by its id to run it again.
- Settings → Keys and secrets is redesigned. Secrets sit in groups — Your secrets, Mail, Calendar links (and any other plugin's), Model accounts, Connections — each row named in plain words ("Gmail app password", a calendar's name, a model account's label) with one line on where it may go ("Sent only to calendar.google.com") and when it was last used, instead of stored names, binding chips and five buttons. A problem is one sentence with its one fix ("Held back 23 seconds ago: it was asked for at uploads.github.com, where it may not go." → Change where it may go; "No value stored." → Set a value; a mailbox its server turned down → Set password on the Email page). Model accounts and connections are read-only here and link to where they are managed. Each row has one ⋯ menu (a sheet on a phone); the stored name, bindings and ids sit under Details in the row's sheet with its usage history in words. A secret nothing uses any more — such as an old `GMAIL_APP_PASSWORD` no mailbox points to — says "Not used by anything" and offers Remove; nothing is removed by itself.
- Keys and secrets: a new place a secret may go starts at "asks you the first time" instead of the kind's loosest rule.
- Restarting buddi from the dashboard — Restart to load it on Plugins, Restart gateway, an upgrade, a restore, leaving recovery mode — now covers the window with a calm "Restarting buddi" screen (the Blob, what the restart is for, such as "Loading weather 0.1.3 and 4 more…", and the time it has taken), waits until the old process is gone and the new one answers, then reloads the page. After ninety seconds (five minutes for an upgrade) it says buddi may need a hand, names `buddi status` and offers Reload. Stop gateway shows the same screen, still, with `buddi service start`.
- A restart started elsewhere (another device, `buddi service restart`) shows the same screen instead of red "buddi isn't answering" banners: the gateway tells open pages it is closing, and a page that finds a new process after the link comes back reloads too (unless you are typing).
- `/_buddi/ready` also answers a random `boot` id for the running process, so a page can tell the process that went from the one that came back.

### Fixed

- Gemini 3 models no longer fail with "Function call is missing a thought_signature" on the turn after a tool call: the signature Google returns with each call is kept with it in the conversation and sent back to Google's endpoint only. A conversation from before this fix carries on too.
- Mail no longer says "Waiting on you" on every conversation. A conversation waits on you only when someone you've written to before wrote last, or triage judged the message to need a reply — never a no-reply address, a newsletter or mailing list, a muted thread or a sender you ignore, and nothing older than 30 days. Notifications and messages nobody expects an answer to carry no pill; the conversation's State says which it is and why ("Notification — no reply expected: a no-reply sender"). The Mail page, the Waiting on you widget, the waiting watcher and the agents' tools now count the same conversations.
- Mail: a genuine security notice ("2-Step Verification turned on") is no longer called phishing. A credential ask that only names a password is not raised at all, and one authenticated (DKIM/SPF/DMARC, read from the receiving server's own header) as coming from a well-known account provider or a domain you write to stays quiet; a transfer asked for from a correspondent's real domain still warns.
- The lock screen reads every time one way: the line under the PIN ("Locked by you at …"), the second clock, the focus and the widgets left on Profile now follow the big clock — 12-hour or 24-hour as picked in Settings → Lock screen, else your Profile, else your browser — instead of the line using another format than the clock (a page that opened locked showed "18:59" over "Locked by you at 6:59 PM").
- The lock screen centres its widgets when medium and small ones share rows (it used to size the grid for four columns and leave the fourth empty).
- Time format choices say what Profile means now — "Profile (12-hour)" in Settings → Lock screen and in a widget's settings — instead of a sample time.
- The weather widget's hourly strip shows the moon at night (a crescent on a clear night, the crescent over a cloud when partly cloudy) instead of the sun, and writes its hours your way ("6 PM", "12 AM" on a 12-hour clock); it has a Times setting of its own. The Weather page's hours, sunrise and sunset follow your Profile too.
- The calendar's "Next meeting" line on Home writes the time your way ("at 9:30 AM" on a 12-hour clock).
- After plugin updates, the "is installed — Restart to load it" notice comes from what buddi is actually running: it lists every plugin waiting for the restart and is gone once they are loaded, instead of staying after the restart. A plugin waiting for the restart says "loads at restart" on its row rather than "did not load".
- docs/api.md: saving Home's or the lock screen's widgets takes `{ placements: [{ key?, widget, size, settings? }] }`, as the gateway always did; the page said `placed`.

## 0.1.0-pre.29 — 2026-10-01

### Added

- Widgets on Home: small live panels from your plugins — the weather at home, today's calendar, who is waiting on your reply — in a Widgets section under Needs you. Pick, order and size them (small or medium) from Edit, by dragging, with the arrow keys or with the move buttons; a widget's ⋯ menu moves, resizes or hides it, with Undo. A widget that fails to refresh keeps its last panel and says how old it is, one that never loaded offers Try again, and a sensitive one is hidden until you show it. The layout is kept by the installation, so your phone shows what your laptop arranged.
- Widgets have settings of their own: each one on Home (and on the lock screen) can be set apart — the weather's place and units, which calendars and how far ahead, which mailbox, a time format — from Settings… in its ⋯ menu or the gear in Edit, in a sheet that shows it live. The same widget can sit twice ("Weather" and "Weather · Work"): Add another in Edit.
- Plugins can export widgets (plugin host API 1.17): a manifest's `widgets`, each a read-only `produce` answering a body from a fixed vocabulary — stat, list, strip, progress, text — that buddi caches for the widget's refresh interval and gives five seconds. The bundled mail plugin adds "Waiting on you".
- Plugin host API 1.19: a widget's settings schema (select, multi-select, toggle, text, place, time format), handed to `produce` resolved; `owner.formats()`; the tile icons `check` and `clock`.
- The World clock, a widget buddi provides itself: the time at your places in other zones, or towns you pick.
- The World clock has a Style: Digital, as before, or Analog — faces side by side like a phone's world clock widget, your own zone first and then your places, four at medium and two at small, with hour and minute hands and a thin accent second hand; a face is light while it is day there and dark at night, and under each sit the place, Today, Tomorrow or Yesterday, and the offset ("+6 h", "−1 h 30", "Here"). The faces tick on the page and stop their second hand under reduced motion; on the lock screen they are glass like the tiles. Each face is read aloud as "Tokyo, 04:05 tomorrow, 8 hours ahead".
- Plugin host API 1.21: a widget can answer a `clocks` body — the owner's zone and up to four faces, each a label and an IANA zone — and the page draws and ticks the analog faces itself.
- A PIN for the dashboard, kept on the server: once you set one, a dashboard session locks after a delay nobody used it for (5 minutes unless you pick 1, 15, 60 or never) or when you lock it, and every API call but the lock screen's own is refused until the PIN is typed — on every device, a remote one included. A new browser session starts locked, five wrong PINs bring a wait that doubles, and `buddi mcp` and Telegram are not covered. Forgot it: `buddi dashboard --unlock` opens the dashboard past it once (with a link for your other devices), `buddi dashboard --remove-pin` removes it.
- The lock screen: the date and time large, counts of approvals and notifications waiting, your focus, up to four of your widgets (never a sensitive one) and the PIN, on the background you pick (five built-in ones or your own picture), with a pad on a phone. Nothing of the dashboard is drawn under it. Set it up in Settings → Lock screen; lock from the owner menu, the padlock at the end of the status line, or ⌃⌘L (Ctrl+Alt+L off a Mac). Forgot PIN? on the lock screen says what to run.
- The lock screen keeps its own widgets, apart from Home's, and its own clock: in Settings → Lock screen → What it shows, a live preview beside the time format, the date style, a second clock (one of your places or any town) and up to four widgets, each with its own settings.
- A tip on Home, "Lock buddi with a PIN", while no PIN is set and once there is something to lock — a second device signed in, a mailbox or money connected, or a week of use; it opens Settings → Lock screen, and dismissing it silences it for good.
- On a phone, the status dot's menu ends with Lock now while a PIN is set, as the footer's padlock does on a wider screen.
- Screenshots of the lock screen (desk and phone) and of Home with widgets in the README and docs/dashboard.md, from a demo installation.
- Places in Settings → Profile: Home and Work (offered until you set them) and any other place you name, each with its address, the town it was found as on Open-Meteo, coordinates and its timezone. The front desk knows them, and plugins you allow can read them. The weather plugin's Home and Work move here once, at the first start.
- Time and Dates in Settings → Profile: Auto (from the browser), 12-hour or 24-hour, and "Thu, Oct 1", "Thursday, 1 October" or 2026-10-01. Every date and time on the dashboard — Home, the lock screen, the status line, the calendar, tables — reads that way, and agents write them that way too.
- Plugin host API 1.18: `ctx.buddi.owner.places()` behind the `owner:places` grant (shown on the install card), a manifest's `setup` answer, `requires` (repeated as `buddi.requires`), and `exports` — named read-only queries another plugin that requires it may call through `ctx.buddi.plugins.call`, on the read-only pool, with a timeout, never a tool.
- A plugin that cannot do anything yet says so: its row on the Plugins page reads "needs setup" with what to do first and a Set it up button, the notice after the restart that loads it says the same, and a Home tip can name it.
- A plugin can require another (`requires`, with a version range): the install card lists each requirement and offers "Install … first" for a missing one, and until each is installed, enabled, in range and set up the plugin waits — "needs weather" on its row, with the one fix — its tools and widgets off and its data kept. It comes in by itself the moment its requirement is ready.
- A plugin installed from a folder can be reinstalled from it at the same version: "Reinstall from folder" in its row's menu and its detail, and `buddi plugins update <name>`, read and approved like any update, the card saying it is the same version read again.
- A watcher's wakes can be gathered into one run: a sentinel that sets `coalesce` (plugin host API 1.20) has its wakes for the same agent folded together — the first waits two minutes for company, each that follows pushes it back by two more, none waits past ten — and the agent reads every finding in one run and sends one message. Finance's watchers do, so a bad week is one word from Ledger instead of one per card and bill. The wake mission can also be told to coalesce for every watcher.
- Owner API tokens, for using buddi from a script or another program without the dashboard: make one in Settings → API tokens or with `buddi api-token create <name>` (shown once, kept only as a SHA-256 fingerprint), send it as `Authorization: Bearer <token>`, list and revoke them in Settings or with `buddi api-token list|revoke`. A token acts as you but never approves anything, writes through a plugin page only by asking (an approval card, never a tool that runs at once), changes an agent's grants, installs code, changes how buddi is reached or unlocked, or reads a secret; a wrong or revoked one counts as a failed sign-in, and the lock screen does not cover it.
- docs/api.md, the HTTP API reference: every route the dashboard uses (255 of them) by area, with what it takes, what it answers, how it fails, since when, whether an API token may call it and a curl line, plus the base URL, how to authenticate, the error format and the sign-in lockout. Generated from the gateway's route table by `pnpm docs:api`; a test fails when a route has no entry or the page is behind.
- A spent daily quota is told apart from a short burst: when a provider says the day's allowance is used up (Gemini's free tier allows 20 requests a day), buddi stops calling that account until the quota resets instead of retrying, the run says so in plain words ("Gemini's free tier allows 20 requests a day; it resets at 09:00 …") with the fix, and the account is marked rate-limited until then — `buddi.accounts_list` on the MCP admin shows the state and the reset.
- Settings → Model accounts: an account its provider rate-limited reads "Rate-limited" with when it is back, and its detail says "Rate-limited until 14:20" with why in plain words and the fix (another account for its agent, or billing); a short burst says what buddi does about it. Each account shows its id, small, with Copy — what `buddi agents set <handle> --account <id>` takes.
- `buddi accounts` (and `buddi accounts show <id>`): every model account with its id, provider, sign-in type, default model, state — ready, rate-limited until a time, needs a credential or a new sign-in, disabled — and the agents on it, as text or `--json`; never a key or a token. The "Add a model account" recipe in docs/cli.md starts with it.
- Delete a group from its chat: ⋯ → Delete group… asks once, naming what goes (the group, its conversations, what it remembers) and that its agents and files stay; the page returns to the chat you were in and offers Undo for ten seconds, and after a minute the group is gone for good. `DELETE /api/groups/:id` now deletes (with `POST /api/groups/:id/restore`); archiving moved to `POST /api/groups/:id/archive`.
- Clear a group's history and keep the group: ⋯ → Clear history… (`POST /api/groups/:id/clear`) deletes its conversations; its members and memory stay.

### Changed

- The weather card beside Home's greeting is now the first widget, and the Blob stands there alone. A plugin's older glance card still reaches Home, as a small widget, and a glance whose widget is on Home leaves the date line.
- The lock screen: tapping the notifications count opens Notifications once you unlock (approvals open Needs you); a widget with only a sentence to say takes one column instead of a hollow card; the mail widget says "3 conversations", and "Nobody's waiting on you." at zero.
- The calendar's month title follows your Profile date format: "September 2026", "2026-09" with ISO dates, and your browser's own words on Auto.
- Times in failure messages — when a provider's limit resets, when lost background work happened — are written in your Profile's timezone, time format and date format, as the dashboard writes them; `buddi accounts` too.
- A plugin's requirements read in words: "weather 0.2 or newer" on the install card (the range itself on hover) and "Needs weather 0.2 or newer" on a waiting row, the upper limit said only when the installed version is past it.
- A group chat's ⋯ menu is about the group instead of linking to each member: Members (a sheet with the coordinator first, Make coordinator, Remove, Add a member), Rename…, Clear history… and Delete group…. On a phone, this menu and an agent's rise from the bottom as a sheet. The group sheet's edit mode and its Archive button are gone.
- A group that lost an agent to an uninstall says so: with its coordinator gone the composer gives way to "Choose a coordinator"; with one member left a line offers "Add a member". Such a group can be renamed and the missing agent taken out, which the server used to refuse.
- The signed-out page offers the way back in for how you arrived: on this computer the `buddi dashboard` command with a Copy button; over the tailnet with Tailscale sign-in on, "Sign in with Tailscale"; and while a lockout runs, "Too many tries — wait N min", saying that a fresh link works right away.
- While a mailbox has instant mail (IDLE), buddi also checks its Sent folder every minute over the same connection, so a reply you send from your phone moves the conversation to "waiting on them" within a minute instead of up to 15.
- Mail you archive, move or delete in another mail app now leaves buddi's inbox too: it stops counting as unread, `email.select_messages` no longer picks it, and the Mail page says where each message is now (archived, in Trash, in a label, or no longer in the inbox). On Gmail buddi finds where it went and keeps its labels; a message moved back into the inbox is the same one again, not a new arrival.
- On Gmail, moving mail to a label adds that label and takes it out of the inbox, keeping its other labels; Undo puts the inbox and the labels back exactly as they were.

### Fixed

- Your timezone in Settings → Profile now drives the server's clock: the time agents are told, `{{today}}` in their prompts, reminders, digests, widgets (the World clock's "here"), the dashboard's footer and lock screen, and the zone of missions kept in your old zone, which move with it — at the first start too, for the recap and digest an older buddi made in `BUDDI_TZ`'s zone. A change applies at once, without a restart. `BUDDI_TZ` only fills an empty profile and is the fallback while it names none; `buddi doctor` says which one is in use.
- The Analog World clock no longer cuts a place to "San Francis…": a place takes two lines (a size smaller with three or four faces) before it is cut, on Home and on the lock screen, and the faces stay aligned.
- The footer's "N agents working" counts every run in progress — Telegram's, the terminal's and the job queue's too — not only the dashboard's chats.
- A ChatGPT account that reaches its plan's usage limit is held until the limit resets, as a spent Gemini quota is: buddi reads the reset ChatGPT sends, stops calling the account until then, and says "This ChatGPT plan has reached its usage limit; it resets at 14:20" instead of a generic refusal, with Settings → Model accounts saying the same.
- A provider's "retry in 20s" is honoured: buddi waits the window a 429 names (Retry-After, OpenAI's and Anthropic's reset headers, Google's RetryInfo and "Please retry in …"), at most twice and never more than a minute in all; a longer window ends the turn saying when to try again, and a background run is requeued for that time instead of failing.
- A Tailscale dashboard session is no longer ended when the local Tailscale daemon is slow or cannot be asked (as on the first requests after a restart): the request answers "Tailscale didn't answer, try again" and the session stays. Questions about one address asked at once share one `tailscale whois`, a failed one is never remembered, and only an answer naming another login ends the session.
- The sign-in lockout counts only a wrong credential that was presented. A Tailscale session that ends, Tailscale being busy, the signed-out page and its Try again no longer count, a refused cookie is expired in the browser so a forgotten tab stops presenting it, and Tailscale sign-in works during a lockout. The "too many failed sign-ins from here to ask the local tailscaled" log line is gone with the cause.
- `buddi mcp` (Claude Code's `buddi` tools) signs in to a packaged install again: it first checks that the gateway on its port holds the same dashboard token before presenting a sign-in link, so a different buddi on that port is named in the error instead of collecting failed sign-ins; a failed sign-in is not retried for 30 seconds, and the error says what to do.
- Telegram reactions: a reaction (or taking it back, or a note on a 👎) shows under its message in an open dashboard tab at once; reactions on the first-run greeting and on a /recap answer are recorded too; the weekly digest and its Home card name agents by their display name.
- `buddi chat` writes the carry-over note when a conversation rolls over, as the dashboard and Telegram do, so the agent picks up where it stopped.
- Mail stored before buddi read the List-Unsubscribe and Precedence headers is read for them now, a few hundred messages a poll, so a newsletter that says so only in List-Unsubscribe is recognised and its waiting card keeps itself like a new one's.
- The daily "buddi learned" line: a rule that keeps itself after that day's end-of-day message went out no longer adds a second line for that date the next day; it folds into the next day's line.
- A mailbox without a stored password no longer writes "no IDLE … checking on the poll" to the log on every poll; it is said once, and again only when that changes.
- A mailbox change or undo interrupted part-way (a dropped connection, or buddi stopping) no longer loses track of what it did: the change is recorded before the server is touched, the next poll checks with the server and finishes the record, and an undo that stopped part-way can be run again to put back the rest. Recent changes shows "Partly done", "Partly undone", "Checking" or "Unconfirmed" when that happens, and Undo says beforehand when some messages were moved in another app since and will stay where they are.

## 0.1.0-pre.28 — 2026-10-01

### Added

- Reactions on Telegram count as feedback: 👍 (and ❤️ 🔥 👏 🎉 🙏) or 👎 (💩 🤮) on an agent's answer is recorded against that answer and the run behind it, shows under the same message on the dashboard, and taking it back clears it. The bot replies to nothing, except that a 👎 gets one "What was off?", and your Reply to it is kept as the note instead of starting a new turn. The weekly learning digest counts reactions per agent and quotes the 👎 notes.
- Agents can clean your mailbox, with your approval: mark mail read or unread, archive it (on Gmail it leaves the inbox and keeps its labels; elsewhere it goes to the server's Archive folder), move it to an existing folder or label, or move it to Trash. An agent first shows how many messages and five of them, then one approval covers up to 500, and the card says the count, the mailbox and why ("newsletters older than a week"). Nothing is ever deleted outright and no folder is created. Mark, archive and move can be allowed always; Trash is asked every time.
- The Mail page lists "Recent changes" buddi made to your mailbox, with Undo on each: marked mail goes back to how it was, archived or moved mail goes back to its folder, and trashed mail comes back while it is still in Trash (Gmail labels included). Agents can undo too, with your approval.
- A mail rule can also act on arrival: archive, mark read, or move each matching message to a folder as it comes in. The rule's approval card and its line on Settings → Email say so, Add a rule has the same choice, and each change shows under Recent changes with Undo.
- Plugins can keep a learned rule themselves where their own rule allows it, and core records who decided each proposal (you, or the plugin by itself). Your track record counts too: once you have kept five rules of one kind from a plugin, with no discard since, new ones of that kind keep themselves; a discard, or an Undo, turns that off again. Plugin host API 1.14.
- Settings → Proposals groups open rules of the same kind into one card with "Keep all (N)": one tap keeps them all, each applied as if kept on its own. Rules that kept themselves say so in the fold.
- Mail stops asking you about newsletters: when buddi learns to quiet a sender whose mail is sent to many (it carries an unsubscribe link or a mailing-list header, or comes from a no-reply address) and you have never written to them, the rule applies itself instead of waiting as a card. The Mail page lists these under "Learned", newest first, each with Undo, and you get at most one line a day ("buddi learned 7 rules: quieted 7 newsletters — review"). Senders you have written to, and anything other than quieting, still ask first. On the first start after upgrading, the newsletter cards already waiting are kept the same way.
- New mail reaches buddi within seconds: each mailbox keeps an IMAP IDLE connection on its inbox, so the server says when mail arrives (or leaves, or changes) and that mailbox is checked right away. The 5-minute check stays as the safety net (every 15 minutes while the live connection is up); a server without IDLE, or a connection that keeps dropping, simply stays on the 5-minute check while buddi reconnects with growing pauses. A rejected password shows "Password needed" and stops retrying until you set a new one. Settings → Email shows each mailbox as "Instant" or "Checking every 5 min". Plugin host API 1.15 (sources can have a long-lived watcher).
- Each agent has its own "New chat after" on Setup → Brain: 3 hours (the default), a day, a week, or never. A chat idle longer than that starts a fresh conversation with your next message; a transcript that grows too long still does, whatever the setting. Also `buddi agents set --idle-rollover` and `buddi.agent_update` over MCP. A plugin's proposed agent can ask for its own default; the Developer agent asks for a day. Plugin host API 1.16.
- When a chat rolls over (idle or size), the new conversation opens with a short note the agent's own model wrote from the old one: what you were doing, decisions, open threads, what's next. It shows as a folded "Carried over" item above the chat that you can read and delete, and the agent reads it as context. Plugins can add lines of their own; the developer plugin adds the workspace, branch, last commit and uncommitted files. If the summary can't be written, the chat still rolls over (with the old copied note after a long transcript, or nothing after an idle gap). Plugin host API 1.16.
- Settings → Email can change a mailbox's password: "Set password" on each row opens a small form that signs in with the new app password against the mailbox's own server first, keeps it only if that works (otherwise the old one stays and the server's reason is shown), and leaves the mailbox's mail where it is. A mailbox whose password buddi can't read says "Password needed" with the same button. Agents can't use it.
- A thin status line at the foot of every dashboard page, each item a link: how this page reaches buddi (Local, Tailnet, or Reconnecting…), the focus that is on and until when, the work (agents working, the queue running or paused, failed jobs), approvals waiting, the version with a dot when a newer buddi is ready, and the time in your timezone, naming it when this device's differs. On a phone it folds into a dot on the rail that opens the same items.
- `docs/cli.md` gives every command its own linked section (usage, flags, an example, what it tells you to do next such as `buddi service restart`, exit codes, JSON fields), from the same table as `buddi help`, and opens with common tasks: add a model account, change an agent's model or step budget, back up and restore, pair Telegram, add a local connection, upgrade. `buddi help <command>` now says what to do next too, and every command has an example.

### Fixed

- Settings → Email now says "Password needed" when your mail provider rejects the saved password while checking mail (an app password revoked at Google, say); it used to keep saying the password was in the vault while nothing was read. The next sign-in that works, or Set password, clears it.
- Restarting or upgrading buddi no longer signs you out of the dashboard: sessions are kept in the database (only a hash of each session id is stored, and the CSRF value is derived rather than stored), with the same 30-day / 12-hour idle lifetimes and the 7-day Tailscale cap. Sessions from before this version end once at the upgrade. Backups do not carry them.
- Opening the dashboard while signed out now shows a buddi page ("You're signed out of this buddi … run `buddi dashboard` for a sign-in link", with Try again) instead of the browser's "This site can't be reached"; through Tailscale with a login that isn't allowed, it says so. API calls still get an empty 401, and the lockout counts the same.
- A restored plugin's settings no longer wait forever because the plugin seeded a default at install: a settings table (a single text `key` plus a `value`, like finance's preferences) gets the backup's missing keys added, keeps the values already there, and leaves the recovery checklist. Other tables that already have rows are still kept aside.
- `buddi doctor` on a packaged install now prints "Kept plugin data: …" while a restore's plugin data is waiting; the packaged doctor never ran the row the checkout's doctor had.
- `buddi help vault get` said it prints the secret; it says whether the secret is set, never its value, and the help now says so. `buddi help agents set` lists `--idle-rollover` and points `--account` at Settings → Model accounts; `buddi help upgrade` mentions the packaged `buddi upgrade <version>`; the exit codes of `plugins list`, `plugins approve`, `plugins update`, `telegram unpair`, `backup verify`, `vault set` and `doctor` are written down.
- A plugin installed from a folder now shows the folder's current version (its package.json) on the Plugins page and in `buddi plugins list`, with "installed as" beside it when that differs from the version recorded at install; a dev install used to show every such plugin as 0.1.0. Reinstalling from the folder records the folder's package.json version, even when the plugin's manifest spells an older one.
- The recovery checklist no longer asks you to install a plugin again right after `buddi plugins approve` or the dashboard installed it: it reads the plugins record, says "installed — loads at the next restart", and links Restart to Settings → System.
- The recovery checklist now lists mailbox passwords ("Gmail — app password for you@…") and connection credentials ("GitHub — sign-in", "Trokky — TROKKY_TOKEN") that this machine cannot read, which used to fail silently after a restore. A mailbox's Fix opens Set password for that mailbox on Settings → Email; a connection's opens its sheet in Settings → Connections (new `?connection=` link), and an OAuth one says Sign in again.
- `buddi backup create` on a packaged install now prints what the docs promise: the archive's size and how long it took, what is inside, and the `buddi backup verify` line to check it. It used to print only the path.

### Changed

- One banner slot at the top of the dashboard replaces the separate banners: recovery, a lost connection and a paused queue use the same strip, shown only while it matters, the most important first with "+N more" for the rest. The paused queue's Resume moved there from Home's "Needs you".
- The Continue on the "Turn budget reached" line is now an outlined button you can see and tap (taller on a touch screen), not a word that read as plain text.
- Agent Father can now give an agent up to 500 steps per reply when it creates or updates one (it was capped at 64), the same range as Setup → Brain; the approval card names the number.
- Hiding a glance on Home with its × now leaves "<Title> hidden · Undo" in its place for about eight seconds; Undo brings it back (the same setting as Settings → Appearance).
- `TELEGRAM_OWNER_USER_ID` and `TELEGRAM_OWNER_CHAT_ID` are no longer read: a phone you unpaired in Settings → Telegram used to come back at the next restart. The first start of this version pairs the account they name once (if it is not paired yet) and records it; after that pairing is only by code or QR (Settings → Telegram, `buddi telegram pair`), and `buddi doctor` warns while the lines are still in `.env`.
- Settings → Plugins opens only the plugin you just read as the full review card; every other package read but not installed waits as a compact row under "Waiting for you", above Installed, with Review (the full card in the side sheet) and Not this one. A stage you opened is kept a day; one nobody opened (made by a script or the CLI) is deleted after two hours, and `buddi plugins staged` prints when each one goes.

## 0.1.0-pre.27 — 2026-10-01

### Added

- A reply that stops because it used all its steps now offers **Continue**: a button on the "Turn budget reached" line under the conversation's latest reply (while nothing is running), and a Continue button under the answer on Telegram. Either sends "continue" as you into the same conversation, once, and the agent picks up with the whole history.

### Changed

- The agent's Setup → Brain shows "Steps per reply" (was "Max turns"), with the built-in default of 40 named when the file sets none, a 10 to 500 range, and a hint that each tool call is a step. It saves through the same path as `buddi agents set --max-turns`.
- The Developer agent the developer plugin proposes asks for 150 steps per reply instead of the default 40. An agent already installed keeps its file as it is.

- Home opens on a glance: the date, a large greeting and what needs you as one line of counts, each a link to its list (failed jobs, urgent alerts, proposals; approvals and messages scroll to "Needs you"). On the right, the Weather plugin's card — now, sky and place, the next twelve hours as a small line, high and low — with the Blob in it; without the plugin the Blob stands there alone. The composer moved under the glance and is one line that grows as you type, with the Continue chips under it. On a phone it stacks.
- The "Keep buddi one click away" card left the top of Home. Home now shows one quiet line at the foot, "Install buddi as an app, one click from your dock", only when the browser has offered an install; the owner menu has "Install the app" whenever it does, and Settings → System has "The dashboard as an app" with the bookmark tip and, on the Mac, `buddi dashboard --install-app`.
- A plugin's Home glance can carry a card (a figure, one line, a run of numbers drawn as a sparkline, a foot); Home draws the first one on the right of the greeting. The Weather plugin sends one from its next release, and its glance opens the Weather page.

### Fixed

- Restoring a backup before reinstalling its plugins (the normal order on a new machine) skipped those plugins' data, and installing them afterwards gave empty tables. The restore now keeps each missing plugin's data under the data dir and loads it when the plugin is installed (or at the next start), into empty tables only; the recovery checklist says "finance — 1,544 rows waiting, loaded when you install it", a table that already had rows stays aside and is listed on its own, and `buddi doctor` shows what is still waiting.
- An upgrade could leave Postgres unable to start ("Library not loaded: …libicuuc.77.dylib"), because npm did not run the Postgres package's script that makes its library links and buddi's own copy pointed back into npm's folder. buddi now makes the missing links itself before every Postgres start and keeps its copy self-contained, and an upgrade first checks that the new version's Postgres starts; if it does not, buddi puts the previous version back, keeps running, and the upgrade result says why.
- A message an agent sent you repeated its "@handle:" at the start of the title on the dashboard, right under the agent's name. Home's Needs you, Settings → Notifications and the toasts now leave the signature off; Telegram keeps it.

## 0.1.0-pre.26 — 2026-09-30

### Added

- A message an agent sent you (`owner.notify`) opens on the canvas as the message itself, with where it went as a status (sent, held, in a summary, refused) and the call's details folded; its chat row says where it went.
- The front desk holds `owner.notify` without a line in its file, the way every agent reads the time, so an installation whose Buddi file predates the tool can still be asked to "send me that on my phone". Other agents get it on their Tools tab.
- Agents can message you themselves with the new `owner.notify` tool: asked "send me a message on Telegram now", an agent sends it and says truthfully where it went. It is shown as "@agent: title" in plain text, follows your notification routing (and skips the dashboard hold when you asked in the conversation), and is limited to 6 urgent messages an hour and 20 a day per agent. Settings → Notifications has a "Messages from your agents" section (on or off, the highest urgency, a mute per agent), and each agent's Tools tab has its mute. The front desk, your first assistant and the starter agents have it.
- An agent's Setup → Tools now lists every connection with a switch for whether this agent holds it, saved as you flip it. A connection that needs review or a sign-in is shown with why and a link to Connections; the connection sheet's "Held by" shows the same.

### Fixed

- On Telegram, an agent's signature ("@buddi: …") was turned into a link to whoever owns that public username. It still reads the same, but is no longer a mention.
- A forgotten tab, an unpaired Chrome extension or any poller with no sign-in could lock the owner out of the dashboard: every refused request counted as a failed sign-in, and all tailnet and SSH-tunnel traffic shares one address. Now only a request that presents a credential counts, and the same stale cookie counts once however often it is sent; guessing still locks the address.
- The installed app showed the browser's error page when buddi answered with an empty "too many requests" or a server error. It now shows its own offline page for those too.
- After a restore, the recovery checklist listed every working model account as a key to paste again, because it looked for the account's key under its own name while buddi keeps it as an owner secret. It now asks the way buddi reads the key, so only what is really missing is listed, in words ("Gemini — API key"). Each item has a Fix that opens that account, the Telegram setting, Keys and secrets, or the plugin's install, and the checklist reads itself again when you come back to it.

### Changed

- Telegram has its own page in Settings, beside Notifications: it is where you talk to buddi, not only how it reaches you. Notifications links to it while Telegram is not set up, and the recovery checklist's Telegram fix opens it.
- An agent's connection tools that ask first are one folded group per connection, with how many ask and which are remembered in its summary; tools that delete or destroy are named once at the bottom instead of a disabled row and a sentence each.
- An agent's Setup is four tabs instead of three: Identity, Brain, Tools (roles, tools and connections) and Team (who it may ask). The built-in context moved to Brain, and old links to Access open Tools.
- The agents reference documents `{{today}}`, the one placeholder a persona can use.
- Mailboxes now exist only as accounts added in Settings → Email; `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env` are no longer read. On the first start after upgrading, a mailbox `.env` named is adopted once as a Settings → Email account, keeping its mail, its sync position and its triage (nothing is read or triaged again), and its password moves to that account's own secret; the log says the `GMAIL_*` lines can be deleted. If its password cannot be read, nothing is created and the log says to add the mailbox in Settings → Email, where adding it keeps its mail. `buddi doctor` warns while those lines are still in `.env`, and the start-up summary says how many mailboxes are configured.
- `buddi doctor` finds a mailbox's password among the owner's secrets, where buddi keeps it, instead of reporting it missing.

## 0.1.0-pre.25 — 2026-09-30

### Fixed

- Right after a device-code sign-in, a connection could briefly read "done" beside "not signed in", because the page read the connection before the sign-in landed and its state after. The state is now taken first, and a stale read no longer overwrites a fresher cached connection.
- A connection's idle clock started when a request began, so a slow first start or a long call could be stopped under itself. It now starts only when the last request ends.
- Once a connection was given to agents there was no way to change who holds it. Its sheet now has Change beside "Held by": tick an agent to give it the tools, untick one to take them away, in one save.
- The floating Buddi button covered the footer of sheets and dialogs. It steps aside while one is open.
- A catalog service could be connected only once from the page. Its sheet now offers "Add another account" through the same sign-in, and rows with the same name show their name in buddi.
- The approval on the canvas repeated the raw tool name three times, shouted its state, and wedged its buttons under it. It now reads like the dock: the action in words, a status pill and the expiry in a short head, the preview as its body, and the decision on the right with Approve last; the raw tool name is in the envelope's details.
- The approval card for a connected service's tool showed its arguments as raw, cut-off JSON. It now says what the call does and where, then one short line per argument; the exact arguments stay on the envelope beside it.
- A question that needed a link to answer (a sign-in page, an approval code) could reach the owner without the link, which sat in a tool result they never see. Agents are now told to put the link and the code in the question itself, and the question card makes https links clickable.
- Agents on Claude Sonnet 5.5, Opus 5.5 and other current Claude models failed every run with "provider rejected the request as invalid", because thinking was still asked for with a token budget. buddi now sends adaptive thinking to Claude 4.6 and later, `between_tools` to turn it off on Sonnet 5.5, and nothing on models where it cannot be turned off.
- A model account could not be removed while an agent that had since been deleted was still recorded against it. A deleted agent no longer counts as using an account, the account list stops counting it, and removing the account clears what it left behind.
- Restoring a backup into a packaged install failed on the mail tables (a thread points at its last message, a message at its thread) because an ordinary database role cannot switch off foreign-key checks and no table order satisfies a cycle. The restore now holds those keys off during the load and adds them back before the commit, which re-checks every row.
- The extension knocks on buddi's HTTP side before each reconnect and opens the socket only when something answers, so a buddi that is off or restarting no longer fills chrome://extensions' error list with refused connections.
- Listing the models of an OpenAI-compatible account asked every model Ollama's capability question, which on mlxh made its manager load a worker for each one, image models and the largest included. Only a host that answers as Ollama is asked now.
- Test connection gives an account on this computer two minutes instead of fifteen seconds, since a local model loads on its first request.
- When a model's provider refuses a call because of the account ("Third-party apps now draw from your extra usage…"), the chat shows that sentence and points at Settings → Model accounts, instead of a generic line about the connection or a wrong one about the .env.
- Giving a connection's tools to an agent failed with "matches no registered tool" whenever a chat or a run had happened between buddi starting and the review being kept, and worked again after a restart: the tools were being registered into that run's own copy of the registry. They now go to buddi's own registry, and every run started afterwards gets them.
- Adding a service that was already added and never reviewed reuses that connection instead of making a second one.
- The page a service sends you back to after a sign-in (`/connections/callback`) was blank: the dashboard's files are addressed relatively and the browser looked for them under `/connections/`. It now finishes the sign-in and closes itself as meant.

### Added

- Connections can be a program on this computer: **A program on this computer** in Settings → Connections (name, command, arguments, environment variables with a Secret switch) and `buddi connections add <name> [--env K=V]... [--secret K]... -- <command> <args…>`. Secret variables are kept in the vault; the review is the program's first run, shows its command line in full, and a changed command, arguments or variable name asks for another review. buddi starts it as you in its own process group with only the named variables, stops it after ten idle minutes and on shutdown, and keeps its last stderr lines on the row when it fails. The paste box and `--json` also read a `command` entry and a `claude mcp add … -- <command>` line.
- The installed app claims links to its own address (`handle_links: preferred`) and reuses its open window (`launch_handler: navigate-existing`), so "Open buddi" in the extension and any buddi link land in the app once Chrome's "Open supported links" is on for it.
- Each release attaches `buddi-extension-<version>.zip`, the Chrome Web Store upload of the extension (the unpacked folder in the tarball is unchanged), and the dashboard is ready to recognise the store's extension id once the listing exists.
- mlxh, local MLX models on a Mac, as a model account: Settings → Model accounts has a **mlxh, local MLX models on this Mac** choice (address filled in, no key, the model list next), and first run's "On this computer" card finds mlxh beside Ollama and starts on its first language model. `GET /api/onboarding/mlxh` says whether mlxh answers here and what it serves.
- An mlxh account's context window follows mlxh's `max_prompt_tokens` when the server reports it, else its 8,192 default, and Settings says how to raise it; image models on mlxh are flagged in the model list as belonging to the Image plugin.
- First run's "What should I take on for you?": tick My days, My mail, My money, Voice, My code or Pictures, and buddi fetches their plugins from withbuddi.com and installs them in the background while you answer the next chapters. It approves on your behalf only plugins made by buddi whose download matches the hash withbuddi.com lists; anything else waits on its card in Settings → Plugins, and every install shows there with its hash as usual. `POST`/`GET /api/onboarding/take-on`.
- GitHub connects with a code instead of a token: Settings → Connections and `buddi connections add github` show a code and open github.com/login/device, you type it and say yes, and buddi signs in with its own GitHub app (the OAuth device flow). Token and Client id stay available; `--token` still forces the token.
- `buddi connections list|add|review|give|remove` connects an MCP service from the terminal, through the running buddi and the same four steps as Settings → Connections; a sign-in on the service's page lands in any dashboard session, once, within ten minutes.
- A plugin that ships a settings tab has a Settings action on its row (in place of Open when it has no page of its own), in its ⋯ menu and in its detail sheet, so setting one up after an install is one click.
- Connections sign in with a token: paste one on the sign-in screen and buddi tries it on the server before it keeps it, as one of your secrets sent only to that server's host. GitHub opens on Token, with a link to the page where you make one.
- "I have a config" on Settings → Connections reads the `mcpServers` block another MCP client uses: it fills the address and name, and a header becomes the token. A local `command` and SSE-only servers are refused with a sentence.

### Changed

- Settings → Connections is laid out like Plugins: each connection is a compact row (its face, host or command, how many tools, where it stands) that opens a sheet with the details and Review again, Reconnect or Change, and Disconnect, which asks in the same small dialog. Services already connected are no longer offered again, the catalog tiles are smaller, and an address, a program or a pasted config sit behind one "Add your own" block. The page no longer shows tool-name badges, and a line on Connections and on Plugins says which is which.
- buddi no longer reads CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from .env or the vault, and `buddi init` no longer asks for them: Anthropic credentials are added as a model account (the first-run wizard, or Settings → Model accounts). The old "existing API key" and "existing subscription token" accounts are removed, and agents that used them need a model account chosen again.
- The chat roster reads lighter: 36px faces instead of 24px, the name without the @handle (still in the chat header, the @-picker, the tooltip and what a screen reader hears), and a short quiet second line ("18 min ago", "yesterday", or the description for an agent that never spoke). A dot on the face says its state: the Home badge's colour when it needs you, the accent while it is working in the open conversation. Groups draw their faces in the same square.
- The Chrome extension's popup is redrawn in buddi's own type and colours, with the Blob, in light and dark, and shows one state at a time: the address and Connect, Connecting, the pairing code (large, with Copy and **Open buddi settings**), or Connected with how many tabs it is working in and Forget this buddi. It no longer shows a pairing section with a placeholder code while already paired.
- The extension's version is buddi's, in the four integers Chrome accepts: `0.1.0-pre.24` is `0.1.0.24` (the full string is its version name). Settings → Computer & browser says when the extension and buddi are different versions, and carries on.
- A popup that cannot reach buddi says "buddi did not answer at this address. Is it running?" and offers Try again.
- First run is five chapters with a map: Hello (your name and clock on one card), A brain (five cards, each tested with one small call before "Use this brain" lights), What I take on, Reach me, and Your assistant (a name, a Blob colour and the persona). The map ticks each answered chapter with its answer and "change"; Back, Set up later, Start over and "I have a backup" are always where the kit puts them; at phone width the map folds into a strip of dots.
- The first hello knows what exists: your clock, the weather at home when Weather was installed, and whether Mail Triage has a mailbox. Under it, four first questions you can tap, and one card with the things still waiting ("Mail Triage is waiting for a mailbox"), with Open Home.
- The phone, a mailbox, the app and the browser are one optional chapter, before the assistant is made, instead of a Telegram offer after its hello; a mailbox is added with the email plugin's own form, in a sheet.
- The sign-in screen of a connection asks for everything it needs (a token, a client id) before it opens a tab, and opens the tab only onto the service's page. GitHub's sign-in tab no longer opens and closes by itself.
- Updating to a version listed on withbuddi.com takes it from npm even when the plugin was installed from a directory or a file; the staged card says what it replaces, and on approval the plugin's source becomes the registry.
- Browse trusts its copy of the withbuddi.com list for an hour, not a day, and has a Refresh link beside the line that says it fetched it.

## 0.1.0-pre.24 — 2026-09-29

### Added

- Settings → Plugins has a Browse tab: the plugin list from withbuddi.com, fetched only when you open it and kept a day, as one grid of cards with each listing's icon behind a search and filter chips (All, Recommended — what buddi publishes that you do not have — and each category). A card opens a sheet with its screenshot, its tools, the hosts it talks to, what it reaches in buddi, its dependencies and its licence; the icons and screenshots come through buddi, never straight from the page. Install stages the listed version onto the usual card.
- A newer version listed on withbuddi.com shows as "Update to <version>" in Browse and on the installed plugin's row, once Browse has been opened.
- "A directory I built" has a Browse… button: it lists the folders under your home directory on the computer buddi runs on, marks the ones with a package.json, and fills the field with the one you choose.
- A link to `#/settings/plugins?install=<npm name>@<version>`, which withbuddi.com's "Install in buddi" opens, stages that version at once.
- `buddi plugins describe <spec> [--json]` stages a plugin, reads its manifest, prints what it brings and deletes the stage; `--json` is what a market listing's claims are made of.
- A Home tip points at Browse on an installation with none of the recommended plugins.

### Changed

- Settings → Plugins is redrawn from the design kit: one "Add a plugin" panel with the trust sentence under the field, the staged card with its facts beside what the package says about itself, installed plugins as compact rows (status, Update, Open and a ⋯ menu) that open a detail sheet, and "Ships with buddi" folded. Disable and Remove ask in a small dialog; Remove offers "Disable instead".
- An installed plugin's row offers an Update only when withbuddi.com lists a newer version; its detail sheet has "Check for an update" otherwise.

### Fixed

- Disabling or enabling a plugin takes effect at once, no restart: its pages leave the rail, its tools leave the agents, its watchers stop.

## 0.1.0-pre.23 — 2026-09-29

### Added

- A plugin says who made it: the install card and the Plugins page show the author from its manifest.
- Disable a plugin without removing it: its tools, pages and watchers stop, its data stays, its missions pause, and agents that use it carry on without those tools.
- A Weather page in the rail: today by the hour, the week, and ten days ahead, per place, drawn from the design kit; plugin pages can show tiles, a hero and a two-series chart.
- Plugin pages can show a calendar: week, month and list views drawn from the design kit; the Calendar page uses it.
- Focus modes for notifications: Do not disturb or Urgent only, for an hour, until tomorrow or until you turn it off, from the owner menu or /focus on Telegram, plus schedules that replace quiet hours; when a focus ends, one message says what waited.
- An agent's tool grant can end in `?` (`weather.*?`) to mean "if provided": a family no installed plugin provides is skipped instead of holding the agent back.
- Planner's morning brief reads today's weather for your home place and today's meetings with their gaps when the Weather and Calendar plugins are installed, then ends with what to do first; without them it leaves those lines out and never mentions them. A Planner added earlier gains this by adding `weather.*?, calendar.*?` to its tools.
- Plugins can keep a private link, such as a calendar's secret ICS address, as an owner secret they fetch without ever reading it (host API 1.9, `auth: { secret, as: 'url' }`, kind `http.url`).
- Plugins can draw results as tiles on the canvas and add a one-line glance next to Home's greeting; Weather shows its forecast as daily tiles and the temperature at home beside the date, and Calendar your next meeting.
- A Calendar page in the rail shows today and the week ahead from your linked calendars.
- Settings → Appearance chooses which plugin pages sit in the rail.

### Changed

- Weather's Today view is one panel: the day's chart with its values written on it and the hourly strip below share one highlight when you hover or pick an hour.
- `buddi plugins init` writes a plugin whose manifest version is read from its package.json (`src/version.ts`), so the installed card can no longer show a stale version.
- `buddi speech install` downloads through an `http` area of its own, with the same address rules as the gateway, refusing any host the speech plugin does not declare.
- Until 0.1.0, pre-releases are installed with plain `npm install -g @withbuddi/buddi`; the `next` tag is only meaningful after 0.1.0.
- After buddi restarts on a new build, the dashboard knows within seconds and reloads itself when you are not in the middle of something.

## 0.1.0-pre.22 — 2026-09-28

### Added

- Installed as an app, buddi opens even when the gateway is out of reach and says what to check, Tailscale or the Mac, then comes back on its own when it answers.
- A lightbulb on the greeting row opens a section of tip cards on Home: what is due, what was dismissed with a way back, and the switch.
- Running as an installed app, the owner menu has Reload; after an upgrade it reads Reload to update in any mode.
- A tip can be previewed on Home with `#/?tip=<id>` (the ids are in the tips rules), touching nothing, so its copy and layout can be checked before its day comes.
- Home may show one tip a day when something in buddi has gone unused, a second agent, a group, a mission, voice; each is one sentence with one action, 'Not this again' removes it for good, and Settings → Notifications turns tips off.
- First run has Start over at the foot of every step; what you already connected stays in Settings.
- Install buddi as an app: browsers offer it, Home suggests it once, and the dashboard opens in its own window with the Blob as its icon.
- buddi's Blob moves: it breathes on Home and the first-run page, thinks while an agent works in the chat and in the corner button, and on Telegram a thinking-Blob sticker replaces the hourglass until the answer arrives. Reduced-motion settings keep the still.
- Add a teammate: the Agents page and Home offer a starter team, Scout for research, Planner for your day with a morning brief, Keeper for one domain's history, plus the plugin agents when their plugin is there, each added in one tap through Agent Father. The Groups heading now says what it needs instead of hiding.
- Settings → Speech: with no language listed, listening and speaking take the one your profile answers in, and the page says "From your profile: French." Plugins read it with `ctx.buddi.owner.language()` (host API 1.5).
- Settings → Speech: Off as the service for listening or speaking, which keeps that side off even with Whisper or Kokoro installed on this computer.
- A buddi button in the corner of every page opens a small chat with your front desk over what you are doing, so a quick question needs no page change; `/` opens it too.
- Plugin pages can draw a small chart, a line or bars with a dashed target line, and a screen reader hears it as a sentence.
- Goals page: each goal with recorded values shows a chart under its figures, a line over its window or a bar per week for a goal counted per week, with the target dashed.
- Home: a message folded across agents says who else sent it, "Finance Advisor · also Mail Triage".
- The finance plugin proposes Ledger, a cash-flow advisor with the plugin's tools, skills and its daily check and Friday recap, so installing finance comes with someone to use it; the Add-a-teammate card lights up.
- Connections: connect a service that speaks MCP, GitHub, Notion, Linear or any remote server, sign in with its own consent page, read every tool it brings and its tier, and give those tools to your agents; each call runs under the same approval cards as everything else.
- Plugins can add and remove tools while buddi runs (host API 1.6), and a tool may describe its input with JSON Schema; the first user is the coming Connections feature.
- Connections: when a service changes its tools after your review, the new and changed ones wait while the rest keep working, and Review again shows what changed; a connection that needs a sign-in or a review says so on Home and with the dot on Settings; an unreachable one is retried in the background and says since when.
- Connections: a tool that asks you first can have its approval remembered for one agent, on the Give screen or the agent's Access page; one the service says destroys something shows why it cannot.
- Plugins can ask for one picture from a ChatGPT subscription account without seeing its sign-in (host API 1.8, `ctx.buddi.accounts.generateCodexImage`); `withCodexProfile` stays for compatibility and is deprecated. The account listing now carries an HTTP account's address.

### Changed

- The image plugin makes pictures with a ChatGPT subscription directly, without the codex command, and draws with Gemini's Imagen or any service that offers an OpenAI-compatible images endpoint.
- Your front desk and Agent Father may ask any agent, new ones included, without being added to a list; other agents keep their explicit 'Can ask' list. The Access page shows it and lets you narrow it.
- The Agents page always shows the starter team under your agents, not behind a button.
- First run: after your assistant says hello, buddi introduces the phone step before offering Telegram, and the hello no longer ends with a question you cannot answer there.
- Agent replies share one layout with the moment before them: the agent's mark on the left, then the name and the text; while it works, the mark moves and the text says so in place.
- Home: what needs you is a deck of cards you read in full and move through with Done, with the list one toggle away; the conversations to continue sit as chips under the composer.
- The install guide and the computer-control part of the browser guide now say what buddi does, how to set it up, what leaves your machine and where the limits are, instead of reading like a plan.
- The agent's face in a reply's label is 32 px, per the design kit, so the working Blob is seen in the chat.
- The Claude and ChatGPT sign-ins share one OAuth module with the refresh discipline written once.
- Connections declare their service's host like a plugin's network (host API 1.7, `ctx.buddi.network`), so Settings → Plugins lists the services you connected under what leaves your machine. The GitHub card asks for a client id up front, and every card's address was checked; an agent held back for a missing connection says to reconnect it in Settings → Connections.

### Fixed

- A plugin page part this dashboard does not know yet says so instead of drawing nothing, and the installed app's worker answers a failed fetch as an error rather than throwing while buddi restarts.
- A plugin packed with npm installs: buddi no longer lets npm fetch its core package or read a plugin's development links, and the plugin template packs cleanly. Installing never asks npm for a package named @buddi/core.
- The Connections page in the docs has its title, so withbuddi.com builds again; a test now refuses a docs page without one.
- A pasted key is tried with one small call before buddi offers the model list, so a wrong Ollama Cloud or compatible key is refused where you typed it, not on the first chat.
- First run: the Claude sign-in step has a Back button while it waits for the code, so changing your mind is one click.
- Notifications no longer cover the corner buddi button or its chat: they stack above it, and on a phone they drop from the top.
- A delegation that came back after you approved something now opens on who was asked, the question, the answer, the files and how long it took, with the raw JSON folded under Details.
- The same reminder from two agents is one line on Home: a message about the same thing as one from the last two days is folded into it, says "also from" the other agent, and reaches your phone once.
- The queue test for retries past the sixth minute no longer fails now and then on CI: it waits for each failure to be recorded before pulling the retry forward.
- The chat test for an agent holding a question no longer fails now and then: it waits for the question to be recorded, which happens after the run reports finished.
- Finance: a statement line that is a pending charge now posting is no longer skipped as a duplicate; it settles the pending row, also when the posted line reads differently or is dated up to two days earlier. A deleted row never counts as already imported.
- Home's update notice reads on one line.
- The Gemini card starts a free Google AI key on the newest Flash when Google refuses Pro, and says why in plain words; a rate-limit answer from any provider now reads as a sentence about the key and the model, not about responses.
- The moving Blob is drawn at a size where the motion shows: avatar-sized in the chat's thinking line and on first run, larger in the corner button.

## 0.1.0-pre.21 — 2026-09-27

### Changed

- Recording in the composer is now a clear Listening state with a live waveform, a ✓ to transcribe and a × to discard, with Enter and Escape doing the same.
- The dot on Settings, which means a newer buddi is ready, now shows on the System entry too, so it leads to the Version panel instead of pointing at nothing.

- Asking an agent to open an app you have not allowed for computer control now asks you with a card, Once or Always, instead of sending you to Settings. Always adds the app to the list.
- Plugin pages can show a progress bar; the Speech page uses it for the model downloads.
- Settings → Speech asks which languages you speak instead of one language hint, so a French note and an English one are both heard right on this computer, and it lists the models your account offers instead of asking you to type one.
- Plugin pages can offer a select that takes several choices (`multiple: true`).
- Settings → Speech: a play button beside the voice speaks a short sample in the browser with the chosen service and voice; nothing is saved. The old Test that wrote a file to Files is gone.
- Plugin pages can play a sound a tool returns (`play: { mime, data }`), and a select can carry a small button of its own (`action`) that runs a tool with the form's unsaved values.
- Choosing several things on a plugin page, the languages you speak for example, is done with chips and an Add list instead of a scrolling box.
- A voice note on Telegram tells the agent which language you spoke in, so it answers in it.
- Settings → Speech: with Kokoro, you choose a voice for each language you speak, English and French each with their own, and a reply picks the voice of its language.
- Plugin page forms can lay fields out three to a row; Settings → Speech uses it for the speaking voices.
- Voice on Telegram: a voice note is no longer echoed back as text; `/voice` chooses when to speak (spoken, always, off) and what to send (the voice note alone, or with the text), also on Settings → Speech. What is spoken is rewritten for the ear first: handles read as names, dates and amounts as words, links as their site, no markdown.

### Added

- First run and Add account offer Gemini: paste a Google AI key and buddi connects through Google's OpenAI-compatible endpoint, lists the models and picks the newest Pro. Gemini's context window and prices are known to the usage view.
- Kokoro on this computer now speaks French, Spanish, Italian, Portuguese and Hindi with its own voices for those languages (espeak-ng, fetched with the model, does the pronunciation); a reply in one of them picks the matching voice. Japanese and Chinese still need a cloud speaker.
- Home has a composer: write to your front desk straight from the first page, by keyboard or voice, and the conversation opens with the answer. `/` focuses the composer anywhere.
- On the dashboard, a microphone in the composer turns what you say into text (Shift to send at once), and a speaker toggle reads each reply aloud, through the listening and speaking you chose in Settings → Speech.
- Prompt caching: buddi marks the tool list, the instructions and the earlier conversation for Anthropic's cache and keys OpenAI's automatic cache by conversation, so a long conversation's repeated prompt is billed at the cached rate. Usage shows cached tokens separately and the cost estimate prices them.
- Voice on Telegram: a voice note is transcribed and answered, spoken back as a voice note when you spoke (`/voice` chooses spoken, always or off). Listening and speaking can run on this computer: Settings → Speech installs Whisper and Kokoro (about 250 MB and 90 MB) with one button or `buddi speech install`; nothing leaves the machine then.
- A speech plugin: agents can listen to an audio file (`speech.transcribe`) and answer with a voice (`speech.say`) through an OpenAI or OpenAI-compatible account chosen on Settings → Speech, with daily caps.
- Under each reply, Copy and Read aloud. buddi's front desk can now make an audio file on request (`speech.say`), and an audio file in a conversation shows as a small player with a download link.

### Fixed

- Local Whisper and Kokoro now run in their own thread. A long reply read aloud used to freeze the whole of buddi, dashboard and Telegram included, until it finished.
- Computer control: an app name with a typo now gets the close matches back ("Did you mean Vocito?"), and when your own window pushed the agent's app behind, the agent brings it forward again itself instead of asking you to.

## 0.1.0-pre.20 — 2026-09-27

### Changed

- The thinking switch appears only where it is honoured, on Anthropic and OpenAI accounts. On an OpenAI-compatible host, Ollama Cloud and local Ollama included, the Brain page says thinking is up to the model, and the composer shows no switch.
- On the first-run page buddi speaks with the Blob as its face instead of a letter tile. A locally packed build (the Docker trial) calls itself `0.1.0-dev.<commit>` so it is never mistaken for a release.
- A ChatGPT subscription account no longer needs the `codex` command: buddi signs in with the same device code and talks to OpenAI's Codex backend itself. Accounts already connected keep working. Model turns can now run tools in parallel and report token usage.

### Added

- First run offers **ChatGPT — I pay for ChatGPT** right after Claude: buddi shows a code, you enter it on openai.com, and buddi picks a model from your plan. The same code flow is on the account page in Settings.
- The first-run page shows the running buddi version under its title.
- An Ollama Cloud account can connect with a device key instead of a pasted key, the way `ollama login` does: buddi makes a key pair in the vault, you press Connect on ollama.com, and each request is signed with the key. `buddi status` and the account say "connected as <your ollama.com name>, device buddi on <this computer>". Disconnecting asks ollama.com to forget the device, as `ollama signout` does, and removes the key from buddi either way.
- First run offers "Ollama Cloud, one tap" (free to start, no key) right after Ollama on this computer: tap it, press Connect on the ollama.com page that opens, and buddi says which model your assistant will think with, with the list to pick another. The address-and-key card is now "Another service, or Ollama Cloud with a key". In Settings → Model accounts, a new Ollama Cloud account connects the same way, with "Use a key instead" for a key.

### Removed

- The `codex-cli 0.155.0` version pin and the App Server runner.

### Fixed

- A ChatGPT subscription account's context window now comes from OpenAI's own model list instead of a guess from the model name, on the account page and in the conversation budget. The label says whether the number is the provider's or assumed.
- A picture or file a colleague makes through a delegation now reaches the conversation that asked for it. It shows under the asking agent's message and on the Delegation card, the Files page lists it under both conversations, and the asking agent is told it is attached (and sees an image when its model takes images) instead of telling you to ask the colleague.
- Asking an agent for a colleague that is not on its delegate list now gets a clear answer: the refusal names who it may ask and says the colleague can be added on its Access page, and the agent is told to say that rather than improvise or try another colleague to find out. An allowed colleague's handle, like `@art`, now works where its id was needed.

## 0.1.0-pre.19 — 2026-09-26

### Added

- `buddi uninstall` removes buddi from the machine: the background service, the data directory with its bundled Postgres, the secrets in the keychain (the file vault on Linux), the dashboard app, the extension pairing and the Telegram menu. It prints every path first and removes nothing until you type yes (or pass `--yes`). It takes one last backup and moves it to `~/buddi-backups`, where it stays; `--no-backup` skips it and `--keep-data` keeps the data directory and its secrets for a reinstall. In a source checkout it removes the service and the keychain entries, stops the Docker Postgres, and leaves the repository and `.env` alone.
- [docs/dashboard.md](docs/dashboard.md): the dashboard place by place, with one thing to try in each. The docs index has a new group, "Where you talk to buddi": the dashboard, Telegram (now with example exchanges), the command line (now opening with what it is for and five examples), Claude Code and notifications.
- `secret.list` tells an agent which of your secrets the browser may fill, by name, and where each may go, so it no longer asks you for the names. It never returns a value.
- A goal can watch a number you report yourself, like your weight. When no plugin measures it, the agent creates the metric as it proposes the goal and takes the number you just said as the start; the card says "measured by you, when you tell buddi", and `goal.metrics` lists these metrics with the source `owner`.
- `goal.record` writes down a number you tell any agent ("285 this morning", "ran today"), names the goal or the metric rather than whose goal it is, and answers with where the goal stands in one sentence. A number more than half away from the last one, or of the other sign, is asked about before it is kept.
- When a week (or a day, for a daily goal) passes without you telling buddi the number, the goal's agent says so once, in the end-of-day message: "You have not told me your weight this week." A watcher finding can ask for this with `notify: { urgency: 'today' }`.
- Frequency goals: "run three times a week". A goal can count how many times you tell buddi something in each week (Monday to Sunday, your timezone) or month. The card says "3 times a week"; a week that closes short is said once, a streak milestone ("4 weeks in a row") once, and at the deadline the goal is met when more weeks met the count than fell short.
- The Goals page shows the numbers you told buddi for a goal you measure, and a frequency goal's weeks as met, short or partial. In chat, `goal.status` draws your own values, or the count for each week, against the target.
- Settings → Notifications has a Telegram panel: save or replace the bot token, see the phones you paired and unpair one, and pair another with the same QR code first run shows. Telegram appears in "Where buddi reaches you" as soon as the bot starts, without a restart.
- On Telegram, the files a run saved arrive after its answer: pictures as photos, everything else as documents under their own names. A file over Telegram's 50 MB limit is named in one sentence that points to the Files page.
- On Telegram, a table an agent draws arrives as monospace text when it fits one message, and as a CSV named after the table when it does not. A chart or another view answers with one line, and the dashboard link when a public address is set.
- On Telegram, the answer streams into one message as the model writes it, updated at most every 1.5 seconds; the last update is the whole answer.
- A new learning proposal (a skill, a rule for a plugin, a change to an agent's file) is a notification that waits for the end of your day and keeps quiet hours. On Telegram it arrives as a card with Keep and Discard; a tap decides it exactly as the Proposals page does, and a plain "yes" in the chat decides nothing.
- [docs/telegram.md](docs/telegram.md): what the Telegram surface is and is not, pairing, what arrives on the phone, what you can send, the commands, the limits and what leaves this computer.
- Three read-only Telegram commands: `/missions` lists the next five scheduled missions with their times and agents, `/goals` each open goal with its number and whether it is on track, behind or ahead, and `/where` the dashboard address when your phone can reach it.

### Changed

- The Claude and ChatGPT subscription pages ([anthropic-oauth.md](docs/anthropic-oauth.md), [codex-accounts.md](docs/codex-accounts.md)) are rewritten as reference: setup as the dashboard shows it, what it costs, what buddi keeps, what leaves the machine, limits and how to turn the sign-ins off. Across the docs, the packaged install comes first, `buddi init` and other checkout commands appear only as the source checkout path, and migration numbers and dated test notes are gone.
- When a site mails a one-time code, an agent with the email tools reads it from your inbox before asking you: the newest message from that site, from the last ten minutes. The code is never stored or reused. The browser's guidance, `email.search` and the first assistant's "How you work" say so.
- Every browser observation says when it was taken ("Observed 12:04:35 UTC.", and `observedAt` on the observation), and the agent observes once more after a click that submits or navigates before it says whether it worked, judging from the newest observation only. A sign-in that succeeded is no longer reported as failed from an older page.
- A browser binding for a secret can name a wildcard origin, like `*.wikimedia.org`, so one binding covers a site's sign-in host and its pages. `*.` stands for the leftmost part only and may not sit on a public suffix such as `*.com` or `*.github.io`; the card and the use log still name the real site. A form data binding's origin is read the same way as a field binding's.
- A secret's browser binding takes the site as you type it: a bare host becomes its https origin, a full address is cut to its origin, and anything else is refused with an example.
- On Telegram a browser screenshot's caption no longer counts steps; the count appears only when five or fewer are left.
- Signing in with Claude from the first run starts the account on the model catalogue's default for Claude, rather than a fixed Sonnet 5; Sonnet 5 is used only when the catalogue names none.
- A goal that stays off track wakes its agent at most once per cadence for the same drift: once a week for a weekly goal, once a day for a daily one. The first drift still wakes it at once. A watcher's finding can set its own `cooldownMs`.
- On Telegram, an answer longer than 4,096 characters keeps its first part in the message that said "Working on it" and sends the rest after it, split between paragraphs, instead of deleting that message.
- The model list knows Claude Opus 5.5 (`claude-opus-5-5`, $4 and $20 a million tokens) and Fable 5.1; Sonnet 5 stays the default, at half the price. The context table knows Fable 5.1, Opus 5.5 and Sonnet 5 hold a million tokens.
- Signing in with Claude from the first run opens the consent page itself; the button stays for a browser that blocks the window.
- Signing in with a Claude or ChatGPT subscription is offered by default; `BUDDI_SUBSCRIPTION_SIGNINS=off` hides both. The setup wizard shows the Claude card first, with a line on the plan's monthly Agent SDK credits. `buddi doctor` says whether the sign-ins are offered or hidden.

### Deprecated

- `BUDDI_ANTHROPIC_OAUTH_EXPERIMENT` and `BUDDI_CODEX_EXPERIMENT` are no longer needed. For one release, setting either to `0` still hides that one sign-in, and `buddi doctor` names the new variable.

### Fixed

- A model account imported from an environment variable no longer writes a refused use to the Keys and secrets log on every reload: its key answers from the vault directly, as the docs say.
- When you are looking at the tab an agent wants to act or fill in, the agent now asks you once to switch to another tab or window, instead of failing twice and retrying.
- `secret.fill` fills a username. A secret bound to a site as a browser field now goes into any field on that site, not only a password field, and the card names the field.
- The first assistant is granted `secret.*`, so it can fill a sign-in from Keys and secrets; the browser's notice tells every agent that is how a stored password goes in. Existing assistants get the family from their Setup tab.
- Settings → Keys and secrets saves again: the page's writes now run as the owner, so `secrets.put` and its siblings are no longer refused as unknown tools.
- In your own Chrome, an observation that finds the page not ready (a heavy page like cnn.com, or a tab the page script missed) injects the script again and reads the page up to three more times, after 0.5, 1 and 2 seconds, before it says "The page has not answered after three tries. Wait a few seconds and observe again."
- A browser observation that does not answer, after navigating, observing or an input action, no longer pauses control. The agent is told "The page has not answered yet. Wait a few seconds and observe again." and must observe before it acts. Control pauses only when the tab or window is gone, after three failed observations in a row, or when you take over.

## 0.1.0-pre.18 — 2026-09-26

### Added

- One `buddi` command tree, the same words in a packaged install and in a source checkout. `buddi help` lists what applies where you run it, in five groups; `buddi help <command>` and `buddi <command> --help` explain one command with an example and its exit codes. A mistyped command answers "Did you mean buddi …?". Every command is in [docs/cli.md](docs/cli.md).
- `buddi status` is one screen: the version, the service, the database, which agents can run, what needs you, the last recap, and whether a newer buddi is out. `buddi doctor` stays the deep check.
- `--json` on `buddi status`, `buddi jobs`, `buddi backup list`, `buddi telegram devices` and the `buddi service` verbs. `BUDDI_JSON=1` does the same for the commands that read.
- In a packaged install, `buddi backup create`, `buddi backup list`, `buddi backup verify`, `buddi backup prune` and `buddi service logs` work.
- `buddi ask` is made for scripts: `--json` prints `{ text, runId, conversationId, artifacts }`, a question can come on stdin, `--file <path>` attaches a file the way a file dropped on the dashboard is kept, and `--wait <seconds>` waits for an approval you give elsewhere and then finishes the answer.
- `--json` on `buddi agents`, `buddi agents show`, `buddi agents models`, `buddi missions list`, `buddi reminders` and `buddi plugins list`.
- With a mail account set up, buddi can reach you by mail to yourself: a plain-text mail from that account to its own address, and to no other, at most one a minute. Pick it in Settings → Notifications. A plugin can add a channel like it through `ctx.buddi.channels` once it declares `owner:channel`; the install card says "adds a way for buddi to reach you". The host API is now 1.3.
- buddi can reach you with a system notification on the computer it runs on: `terminal-notifier` or `osascript` on a Mac, `notify-send` on Linux with a desktop. It shows up in Settings → Notifications only where it can show something, and nothing leaves the machine. Telegram stays the default when both are there.
- The dashboard tells buddi when you are looking at it. A message that arrives while you are there shows as a card at the top right, with the agent's face and a link, instead of going to Telegram; one you have not seen after ten minutes still goes.
- Home's "Needs you" lists what buddi kept for you: watcher finds, reminders, reports, failures and plugin messages, and what waits for the end of the day.
- Settings → Notifications: where buddi reaches you, with a "Send a test" button for each channel; a channel or Off for each kind; quiet hours and the end of the day; and the last twenty messages with where each went and whether you saw it.

- Everything buddi tells you unasked, from approvals and watcher alarms to reminders, reports and failed jobs, is now kept as one list of notifications, with where each went, when, and whether you saw it.
- Items that can wait for the end of the day go out together at 18:00 your time, as one message with a line each.
- A plugin can send you a message through `ctx.buddi.owner.notify` once it declares `owner:notify`. The install card says "can send you messages when you are away", the message carries the plugin's name, and your settings choose where it goes, never the plugin. The host API is now 1.2.
- A camera button in the composer snaps one picture of another tab in your browser and attaches it to the message. The browser's own chooser picks the tab; nothing is recorded.
- The menu under your initial at the foot of the rail names the running buddi version, and the newer one when the daily check found it.
- Settings → System → Version shows what changes in a newer buddi before you upgrade to it.
- When a newer buddi is ready, Home says so under the greeting and Settings gets a dot in the sidebar.

### Changed

- On Telegram the agents are told the owner reads on a phone and keep answers short, leading with the point; `/help` says so, and asking for more gets more.
- When the keychain is locked for a terminal session, the vault's sentence names the command that unlocks it.
- `buddi version` prints the real version: the installed one, or in a source checkout the version and its commit.
- A command that does not apply to a packaged install, like `buddi init` or `buddi db up`, says what to do instead and exits 2, instead of "checkout-oriented command not yet supported". Exit codes are the same everywhere: 0 done, 1 failed, 2 not typed right, 3 needs something first.
- In a packaged install, `buddi service status` answers in a sentence; `--json` prints what it printed before.
- In a source checkout, `buddi` with no arguments opens the dashboard, as it does in a packaged install.
- `buddi ask` exits 3 when a run stops for an approval, not 2, and says where to approve it and how to finish with `buddi ask --resume <conversationId>`. A database that is not reachable, or an agent that does not exist or cannot run, is also exit 3; a mistyped option is exit 2.
- Tables on the canvas are compact: one line per row, smaller type, dates with their year, long cells cut with an ellipsis that shows the whole text on hover.
- Without Telegram, an approval or a report no longer fails to send: it is kept for the dashboard, and the list says there was no channel to reach you.
- The same alert firing more than three times in an hour waits for the end-of-day message instead, and says so once.
- The Settings entry in the rail is a gear, the sign everyone knows, instead of three sliders.
- An agent's Setup tab is three shorter pages: Identity, Brain and Access. Each saves its own fields, and the address keeps the page you are on.
- The dashboard's type is DM Sans, with DM Mono for code, shipped inside the package. It loads no font from the internet, as before.
- The agents' Chromium now lives in the data directory, at `browser/engines`, so a container that keeps its data volume keeps the browser too.
- On an agent's Setup tab, Roles are four chips (front desk, overview, recap, maker) that say what each one does and which agent holds it now. Any other role goes in a line of text below.

### Fixed

- When the browser pauses because a page would not confirm it loaded, the sentence on Telegram says to send /browser resume, not to tap a dashboard button.
- A line under "Needs you" on Home leaves when you click it, link or not, and a reminder's or a mission's line opens the conversation that wrote it.
- An answer whose reasoning ends in a lone `</think>`, as Ollama Cloud sends for glm and qwen, keeps that reasoning as thinking instead of printing it as the reply.
- `buddi status` and `buddi agents` read the provider keys from the vault the way the service does, instead of saying a key is not set when it lives in the keychain.
- A tool call cut off by the reply length limit no longer sits at "Awaiting result" and stops the run. It shows as failed, the agent is told to send fewer items or pass a file, and it gets another turn to do so.
- In the collapsed agent rail, the groups separator, the + button and a group's faces now sit on the rail's centre line.
- Settings → Version now reads the running version from the installed package, which is named `@withbuddi/buddi`, instead of falling back to the core library's version.
- When the system will not let Chromium start its sandbox, the browser status says so in one sentence with the command to run, and the check now tests the browser with the sandbox on.
- A model that turns images down no longer stops the run: buddi sends the turn again with each screenshot replaced by a line of text.
- With a public origin set, the dashboard on 127.0.0.1 no longer refuses writes with a bare 403 when another buddi's cookie is in the browser. Cookies are named after the port the page is on, and a write refused for stale cookies now says to reload the page.

Releases up to 0.1.0-pre.17 are described on their GitHub release pages: https://github.com/withbuddi/buddi/releases

### Removed

- "Run setup again" in the owner menu and in Settings → System: it only bounced back to the dashboard on a finished installation, and everything the first run sets has its own page now.

