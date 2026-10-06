---
title: "The browser: one page, three routes"
status: reference
updated: 2026-10-03
---

# The browser: one page, three routes

The owner's model is one idea: **an agent is looking at a page**. There are no
modes to pick, no sessions to manage and no observation ids to copy. The owner
sees the page on the conversation's Canvas, gets one line in the chat when the
page was not in buddi's own browser, and is asked only when he is needed.

## Where agents look: routes, not modes

Three routes exist. The runtime picks one per task; the owner's settings are
permissions, not a choice.

| Route | When | Where it shows |
| --- | --- | --- |
| **Their own browser** (Playwright, buddi's profile) | Every page by default | The Canvas only: it runs headless, in the background |
| **Your Chrome** (the buddi extension) | A site that needs your sign-in, when allowed and connected; or the agent reads the task as yours (`prefer: "yours"`: your cart, your orders) | Background tabs in the **buddi** tab group; the Canvas |
| **Your apps** (only with the [Computer plugin](https://github.com/withbuddi/buddi-plugins/tree/main/computer), macOS) | App jobs only ("open Numbers") | The app window; the Canvas |

**The choice**, in order: an app job goes to your apps; a pin (below) narrows
or orders; a site on your **sites that need my sign-in** list, a site buddi
met a login wall on before (remembered in `browser/sign-in-sites.json`), or
the agent's `prefer: "yours"` goes to your Chrome; everything else to the own
browser. A run with no owner behind it (a mission) is kept in the own browser
(see [Missions](#missions-browsing-while-you-are-away)).

**Fallback, without a stop.** Your Chrome asked for but not connected, or
turned off: the own browser, and the chat line says so ("Your Chrome isn't
connected, so I used my own browser for shop.test."). Chrome going away in the
middle of a task: the same address re-opens in the own browser. A sign-in wall
in the own browser with your Chrome allowed and connected: the same address
re-opens in a background tab of your Chrome, where you are signed in, and the
site is remembered. Your apps unavailable for an app job: the one sentence
that names the fix, because no other route opens an app.

**The chat line.** Only when the route was not the own browser or changed:
"I used your Chrome for amazon.com (sign-in)." Once per site and route in a
conversation, as `routeNote` on the tool result.

**Pins.** Most specific wins: this conversation (`POST /api/browser/pin`
`{conversationId, route: own|chrome|apps|auto}`, the chip under the composer in
the kit's design), the agent (`browser: own|chrome|apps` in its `agent.md`),
then the global default (`defaultRoute` in Settings). A pin never allows a
route the switches forbid.

**Several agents at once.** The own browser gives each conversation its own
page, three at once by default (`maxOwnPages`); a fourth waits its turn, and a
page nobody touched for two minutes is let go for it and re-opens where it was
when its conversation comes back. Your Chrome takes several background tabs at
once, with a per-site lock so two agents never act on the same origin at the
same time (the second waits). One page is in your hands at a time (take-over),
and your apps serve one conversation at a time, the next queued.

## Background by default

The own browser runs headless and is seen only through the Canvas screencast
(`showWindow` in Settings, or `BUDDI_BROWSER_HEADED=1`, shows the window for a
site that refuses headless browsers; a Linux machine with no display is always
headless). Your Chrome works in background tabs. **Your active tab is never
typed into behind your back:** when an agent needs a buddi tab you are looking
at, the extension waits up to 30 seconds for you to leave it, and after 3
seconds shows a thin bar in the tab: *buddi is working here · Take over · Let
it continue*. **Let it continue** lets the agent act in view, in that tab;
**Take over** is the Canvas button. Taking over is the only foreground moment.

**Taking over a page in your Chrome** brings it forward where it is: the tab
becomes the active one and its window comes to the front (a background tab
cannot be captured, so there is no picture to stream). The take-over's status
carries `held: { by: 'owner', where: 'chrome' }` and no hand; the bar in the
tab says *buddi is waiting · Give it back*. **Give it back** there, or in the
Canvas (`resume`), takes the bar down and lets the agent carry on in that tab
although you are looking at it. Since the extension from 0.1.0-pre.39 (`hold`, `unhold`,
and the `giveback` event); an older extension leaves the page paused and the
status message says where it is.

## When you are asked: four cards

Everything else retries or falls back silently. You are asked, with one card
in the chat, the corner chat and on Telegram (one photo of the page, then the
card's buttons), on four occasions only:

| Card | When | Buttons |
| --- | --- | --- |
| **I'm not sure that went through. Look?** | A click or fill that failed part-way, or a page that did not answer six reads over fifteen seconds | Look (take over) · Carry on |
| **Keep going?** | The task used its 200 actions or its hour, or eight targeting refusals in a row | Keep going · Stop here |
| **Sign in** (*amazon.com needs your sign-in* / *asks for a code*) | A login wall with no stored login and no Chrome to move to | Take over · Use my Chrome (or Open Chrome and I'll use it there) · Save a login for next time |
| **Human check** (*… asks for a human*) | A captcha or "verify you are human" | Take over · Skip it |

The run stops on the card (the tool result carries `needsOwner`) and the page
stays parked for at least an hour. Your tap is your next message: Look and Take
over hand you the page, Use my Chrome pins the conversation to your Chrome,
Keep going renews the budget. After a take-over, **Give it back** renews the
budget and the agent's next action returns the page as you left it. A stored
login is used before any card: the agent is pointed at `secret.list` and
`secret.fill`, and a TOTP secret answers a code.

## Missions: browsing while you are away

A mission may look at pages unattended **only in buddi's own browser**, never
your Chrome and never your apps, and only when its package says so:
`"browser": "own"` on the mission in the catalogue package. Every other
mission opens no page (`browser.act` answers "this mission has not opted in
to browsing"), and the agent must hold `browser.act` in its own grant; the
opt-in adds no tool. The install and update cards say it in a line: *may look
at pages in buddi's own browser while you are away (never your Chrome or
apps); a sign-in or a check waits for you*.

**How it is allowed.** `browser.act` is a `session` tool: it runs inside a
live owner request. A mission has none, so core's session floor has one more
way through, and only one: the tool declares `unattended`, and the mission
executor lists it in the run's `unattendedSession` (only for an opted-in
mission). The agent's grant, an agent, a conversation and depth 0 are still
asked on every call.

**What it may not do.** Asked for your Chrome (`prefer: "yours"`) it is
refused with the reason; an app job is refused before any card (nobody is
there to answer one); a sign-in wall never moves to your Chrome; pins, the
agent's, the conversation's and the global one, are passed over. The owner's
own Stop holds for missions too: the run is told browsing is stopped and ends,
with no card.

**The four moments park the run.** Look?, Keep going?, Sign in and Human
check have no chat to sit in, so each becomes:

- the same question card `conversation.ask` records, open in the mission's
  own conversation for the parking time;
- a `question` notification with an action (it always reaches you, even in a
  focus): on Telegram the card's options are its buttons; on Home and Needs
  you the agent shows *Asked you a question* until the time is up;
- a suspended job (`awaiting-owner:<question id>`), holding no worker, no
  transaction and no model call.

Your answer, a tap on Telegram, the card in the conversation, or your own
words there, wakes the job: the page is touched with it (Take over hands you
the page; Keep going renews the budget) and the run carries on in the same
conversation with *The owner answered your card …* as its next turn. No
answer within the parking time and the run ends as **needed you**: the card
closes (a late tap is refused) and one report line is delivered, *Headlines
needed you and stopped: "amazon.com needs your sign-in." No answer came
within an hour, so it ended there.* Never silently. The parking time is
`missionWaitMinutes` in the browser settings (60 by default, 5 to 1,440); a
page is kept at least an hour, so after a longer wait the next action re-opens
the last address.

**Any mission may ask, not only one that browses.** An unattended run is told
it runs while you are away and may ask once (`conversation.ask`) when it is
stuck; its question parks the run the same way, with the question's choices
as the Telegram buttons, the same wait and the same *needed you* line. A
second question in the same turn is dropped (logged); `/recap` in an open
chat is not offered the tool.

Which lineup missions opt in (buddi-market): Travel planner's **Trip check**
(check-in windows and booking pages that do not read as plain pages).
Researcher's **Pages I'm watching** reads pages with `web.read` and Anchor's
editions read `news.read`; neither needs a browser, and the rest of the lineup
does not look at pages on a schedule.

## Delegates

A delegated run (one agent asking a colleague) holds no `session` tool, with
one exception: when the asking conversation is **an owner conversation with a
browser session open** (a live owner request, depth 0, and a page of its own
in that conversation), the colleague may use `browser.act` too, one level
down, under the same owner request. The reasoning:

- The owner is there and already watching a page in that conversation, so a
  colleague looking at another page is the same task, seen on the same
  Canvas, renewed by the same owner touches; nothing happens that the owner
  would not see.
- Anywhere else it stays blocked: a mission's delegate (no owner request), a
  delegate of a conversation with no page (the owner never let a browser into
  this task), and two levels down. A mission's `unattendedSession` is never
  passed to a delegate, so a mission cannot reach the browser through a
  colleague either.
- Core checks the owner request on every call (`delegatedSession`, set only by
  the delegation tool); a request that expired ends it.

## Stop agents' browsing

The Stop closes every page and **expires**: an hour by default
(`stopExpiryMinutes`; 0 is "until I say", and `POST /api/browser/stop
{forever: true}` asks for that once). While it holds, an agent that needs a
page gets one card: *Browsing is stopped (by you, 2 minutes ago, until 11:00
UTC). Resume?* with **Resume**. Telegram keeps `/browser resume`. A Stop kept
from before expiries counts an hour from when it was written. The per-page
Stop on the Canvas ends only that page.

## Budgets

Per task: 200 actions and 60 minutes, renewed by any message or card tap of
yours in that conversation (the owner request lives an hour too). The agent
run's `maxTurns` does not count `browser.act` turns (`ownBudget`; capped at 240
extra turns); the browser's budget is the ceiling, and its card is Keep going?.

## Settings: Browser & apps

`browser/settings.json` is `{version: 2, yourChrome, yourApps: off|ask|on,
signInSites, defaultRoute, stopExpiryMinutes, maxOwnPages, showWindow,
missionWaitMinutes}`;
`POST /api/browser/settings` takes a partial object. No lock: a change
applies with pages open, and turning a route off closes its pages.
**Your apps** is a switch on the page, shown only when a plugin provides the
route: **on** opens the apps on the plugin's list and treats the rest as the
plugin says (a card, or a refusal); **ask** (API only) asks for every app each
conversation. Without the plugin the page has one line instead: "Agents can
also work in apps on this Mac with the Computer plugin. See plugins". The
list of apps, the browser app, the helper and the macOS permissions are the
plugin's own settings page (Settings → Computer).

The old `{mode}` file is migrated once, kept beside it as `settings.v1.json`:
*Your browser* → your Chrome on, apps off; *Use my apps* → your Chrome on when
a pairing exists, apps on; *their own browser* → your Chrome on when a pairing
exists, apps off. The apps list computer control kept in this file
(`browserApp`, `allowedApps`, `browserProfile`) is dropped, and a v2 file that
still has it is rewritten once without it (kept as `settings.apps.json`); the
Computer plugin seeds its own list from those files the first time it starts. The
profile and the pairing are untouched. An owner with apps on and no plugin
providing them gets one Home card, once: "Computer control is now a plugin —
install it to keep using your apps", whose button opens the plugin's install
card (tip `computer-plugin`).

`browser.status` reports `routes`: each one's switch (`allowed`), whether it
could serve now (`available`), who provides it (`installed: false` on the apps
route when nothing does), and the one fix when it is down (`repair`: install,
sandbox, pair, permissions, helper).

## On the dashboard

What the owner sees and touches, as the kit draws it (buddi-design
`Browser.jsx`).

**Settings → Browser & apps** (the sidebar entry; the page's lede is "Where
agents may look", and its route stays `#/settings/computer`, with
`#/settings/browser` landing there too). One panel, a row per route, a repair
where health is red; no radio buttons.

- **buddi's own browser** — always on: *ready*; *Chromium isn't installed*
  with **Install · 150 MB**; installing, with the percent; on Linux with
  AppArmor, the one `sysctl` command to copy and **Check again**.
- **Your Chrome** — *Used only for sites that need your sign-in*, and the
  sites you listed. Before a pairing it reads **Add to Chrome ↗** (the store,
  in a new tab). While the extension asks to pair, the page reads the code it
  shows in that same browser and pairs by itself; from another browser you type
  the six digits once. Paired: a switch, *connected* or *Chrome closed*. When
  the extension in this browser has forgotten a pairing buddi still holds:
  *Chrome forgot the pairing* with **Pair again**. ⋯ has Pair again, Install
  unpacked… (a developer build) and Forget this Chrome… (asks once more).
- **Your apps** — only with the Computer plugin: its health and fix (*Allow
  in macOS* opens the plugin's page), a switch, and **Settings ›** to the
  plugin's own page (the helper, the macOS permissions, the allowed apps).
  Without the plugin, on a Mac, one line offers it.
- While a Stop holds, a warning with **Resume** says since when and until when.
- **Advanced**: the first choice for every agent (Let them choose · Own
  browser only · Your Chrome first), the agents with their own rule (a select
  and Remove per row, Give an agent its own rule — the same `browser:` the
  agent's page writes), the sites that need your sign-in, how long Stop lasts
  (an hour or until you say), pages open at once in buddi's own browser, and
  showing it as a window.

**The Page tab.** The page's letter, its title and one quiet line: *Looking at
amazon.com · in buddi's browser*, *· in your Chrome · background tab*,
*Working in Numbers · its own window*, *Waiting for you · it asks for your
sign-in*. **Stop** closes this conversation's page; **Take over** (the accent
while it waits for you) puts the remote hand in the same frame — *You have the
page*, *Nothing you type here is kept. Home Manager carries on when you give it
back*, **Give it back** (and, on a phone, **Type into the page** to raise the
keyboard). The picture sits in a small browser window: back, forward, reload
and the address on a bar above it, asleep while the agent drives (a click on
the address copies it) and live while you hold a page in buddi's browser — the
buttons and a typed address go down the remote hand as `nav` input, through the
same address check an agent's navigate passes. An Enlarge button (and ⋯ → full
page view) opens the same window over the whole dashboard; Esc brings it back.
After a dashboard reload with a page in your hands, a desktop reattaches the
hand by itself. No step list, counter, mode or observation time. While a Stop holds, a conversation that asked for a page
shows *Browsing is paused* with **Resume** there too.

**The cards.** One at a time in the dock above the composer (and in the corner
chat): *Amazon needs your sign-in* (Save a login for next time · Use my Chrome
· Take over; with Chrome closed, Use Chrome when it's open), *This page asks
for a human* (Skip this site · Take over), *I'm not sure that went through.
Look?* (Carry on · Look), *Keep going?* (Stop here · Keep going) and *Browsing
is paused since 10:12* (Keep paused · Resume). They are ordinary questions
underneath (`ctx.ask`), so a tap answers with the label.

**Pins.** *Use my Chrome* under the composer pins one conversation to your
Chrome (offered once your Chrome is allowed and paired); an agent's page →
Tools → **Where it may look** pins the agent. A pin narrows; it never allows
what the switches forbid.

## A route a plugin provides

A plugin may declare `routes: [{ kind: 'apps', label, platforms?, exclusive?,
health, look, do, release?, reach?, takeover?, resume?, handMessage?,
focused?, typeSecret? }]` (host API 1.29; types in `@buddi/core/plugin`).
The runtime routes app jobs to the first one for this platform; core has no
apps route of its own. Core keeps the choice, the queue (`exclusive`: one
conversation at a time), the cards and the Once answers; the provider answers
the rest:

- **`reach`**: who a name stands for (`resolve`, refusing none or several with
  the close names), whether an app is on the owner's list (`listed`), what to
  do with one that is not (`unlisted`: `ask` → the Once / Always card,
  `refuse` → refused without a card), and `remember` for an Always. Core calls
  `do` with `open` only for an app it let through.
- **Take-over**: a provided route has no remote hand. The Canvas shows the
  route's frames (the picture `look` returns) and, on Take over, `handMessage`
  ("Take over at the Mac"); `takeover` and `resume` pause and continue it.
- **`focused` / `typeSecret`**: `secret.type` reads the app in front from the
  route and types the owner's value into its focused field; a route without
  them refuses `secret.type`.

The [Computer plugin](https://github.com/withbuddi/buddi-plugins/tree/main/computer)
(`@withbuddi/plugin-computer`) is the one that exists: the native macOS
helper, the list of apps and its settings page, readiness ("helper present,
Accessibility and Screen Recording allowed"). Its README has the install,
permissions and limits.

## The agent's tools

`browser.act` stays one tool. Its description is the owner's model: look at a
page or act on it; buddi chooses where it opens and says so in `route`; every
action returns the page afterwards; `observation` is optional; when the result
has `needsOwner`, say its question in one sentence and stop. Input gains
`prefer: own|yours`; output gains `route`, `routeNote`, `needsOwner` and,
when the page downloaded a file, `downloads` (see Downloads below).
`browser.status` stays for "is a browser available at all" and is never a
required first call. The try-first rule says: look with `browser.act`; buddi
picks the browser and signs in with a stored login or asks once with a card.

## Downloads

A page an agent works on can hand it a file: the bank's transactions CSV, a
statement PDF, an export. buddi keeps it so the agent can pass it on.

- **Where it lands.** `<data>/downloads/<agent>/<yyyy-mm-dd>/`, the agents'
  downloads area. Each file is written `0600` and never executable; a name
  that repeats on the same day becomes `name (2).csv`. At most 50 MB a file
  and 500 MB per agent; a download over either is refused, nothing partial is
  kept, and the agent hears why in one sentence. Days older than 30 are swept
  when buddi starts and once a day after.
- **Files.** Each saved download is also registered in Files (the artifacts
  store): credited to the agent, in the conversation, with the caption
  "Downloaded from bank.example", source surface `browser`, the run id as its
  chat id and the address it came from without its query (signed links carry
  tokens there). The Files copy stays until the owner deletes it; the
  downloads area is only the landing folder.
- **What the agent reads.** `browser.act`'s result gains `downloads`, on the
  action that started the download or the next one (a slow export arrives a
  moment later): `[{ artifactId, name, size, type }]`, or
  `{ name, refused }` for one that was not kept, plus a line in `message`.
  The agent passes `artifactId` to the owning plugin's import tool (finance
  imports statements) and does not paste the file into its reply.
- **Settings → Browser & apps → Downloads** shows what the area holds, its
  rules, and **Clear** (`GET /api/browser/downloads`,
  `POST /api/browser/downloads/clear`). Clearing leaves Files alone.

**buddi's own browser** accepts downloads into its profile's temporary folder
and copies each finished one into the area; a download from a tab no
conversation holds is cancelled, as before.

**Your Chrome.** The extension needs Chrome's optional `downloads` permission,
which it never asks for at install: the popup shows **Allow downloads**, and
Chrome only asks from a click there. Once granted, while an agent's
`navigate`, `click`, `press`, `select` or `fill` runs in one of its session's
tabs, and for 15 seconds after, a download that starts from the same site as
one of those tabs is the agent's. When it completes the extension sends buddi
a `download` frame with the path Chrome saved it at, its address, type and
size; buddi reads that file only if it is under the owner's home folder, is a
plain file (not a link), was written in the last 15 minutes and is exactly the
size Chrome reported, and only within five minutes of that session's last
action. The file also stays in the owner's own Downloads folder, where Chrome
put it. Downloads the owner starts are not touched: none while no agent acts,
none from another site, none another extension started. Chrome's download
record names no tab, so a download the owner starts from the very site the
agent is on, in those same seconds, would be taken for the agent's.

What this cannot do without a native component: the extension reads nothing
itself, buddi reads the finished file from disk, which works because the
extension only ever talks to a buddi on the same machine (loopback). A buddi
reached through an SSH tunnel from another machine cannot read that path, and
the download is dropped; sending the bytes over the socket instead would need
the extension to re-fetch the file (which breaks for a POST export or a
revoked `blob:` link) or a native messaging host to read it.

## Telemetry: stop causes

Every stop is counted (`browser/telemetry.jsonl`, host only, never a URL),
with every route choice and every finished task. A row from a mission run
carries `mission: true`. `buddi doctor` has a browser
row; `buddi doctor browser` and `GET /api/browser/telemetry` give the last
week's stops by cause, cards and routes, and stops per task (the target is
under 0.2).

| Cause | Now | What it was |
| --- | --- | --- |
| start-with-navigate | removed | An action before any page was open |
| slot-limit | removed | All pages in use; now a queue |
| mode-lock | removed | Settings locked while a page was open |
| controls-changing | removed | Owner controls changing during an action |
| access-changed-opening | removed | Access changed while a page opened |
| request-ended | removed | A request ended after a close, sweep or rollover; the next action re-opens |
| never-switch-modes | removed | The prompt rule against switching modes |
| status-first | removed | `browser.status` as a required first call |
| owner-watching | removed | "You are looking at this tab"; now wait, then the bar |
| route-unavailable | removed | A route down with another able to serve; now fallback |
| page-not-answered | retry | Re-read at 0.5, 1, 2, 4 and 8 s |
| observation-failures | retry | Six reads, then the Look? card |
| stale-ref, redirect, stale-observation | retry | Re-observed; the fresh page comes back, nothing dispatched |
| not-connected | retry | Your Chrome gone; the own browser |
| screen-gone, app-behind | retry | A closed tab re-opened at its address; an app brought forward again |
| uncertain-input | card | Look? |
| budget, targeting-cap | card | Keep going? |
| sign-in | card | Sign in |
| human-check | card | Human check |
| owner-stop, session-stop, takeover | kept | The owner's own stops |
| no-owner-request, no-browser, apps-unavailable | kept | No authority, nothing installed, no apps route |

# Technical appendix

The sections below describe each route's machinery. Where they say "mode",
read the route: *Your browser* is the owner's Chrome, *Playwright / their own
browser* buddi's own browser. Computer control (*Use my apps*, the apps route)
is the Computer plugin's: see its
[README](https://github.com/withbuddi/buddi-plugins/tree/main/computer#readme).

## Optional: "Your browser", the Chrome extension

The **Your Chrome** row of Settings → Browser & apps: agents work in
the Chrome you are already signed in to, through a Manifest V3 extension.
**[Add it to Chrome from the Chrome Web Store](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah)**; it
updates itself from there. It works in Chrome, Edge, Brave and Arc on macOS,
Linux and Windows, because it is the browser doing the work. The same extension
also ships unpacked in `<install root>/extension`, for developers.

Setup, in the owner's words:

1. Turn on **Your Chrome** in Browser & apps (it reads Add to Chrome
   until a Chrome is paired).
2. Press **Add to Chrome** on the settings page, which opens the
   [store listing](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah) in a new tab, and install it there.
   (Developer install, under the row's ⋯ when buddi runs from a source
   checkout: open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked**, and pick the folder the settings page prints.) In Firefox or Safari the page says the extension
   needs Chrome, Edge, Brave or Arc; on a phone it leaves the install out.
3. Press **Connect** in the extension popup. It shows a six-digit code, valid
   for five minutes, with a **Copy** button and **Open buddi settings** beside
   it, which opens buddi.app on this page through a `buddi://settings/browser`
   link when the app is installed and the dashboard in a new tab otherwise. If
   the dashboard is open in that same Chrome it fills the code in for you;
   otherwise type it into **Enter the code** on the Your Chrome row, which is
   always there until a Chrome is paired (that is how you pair from the
   buddi.app window). The extension and buddi keep the socket busy while the
   code waits, so the code stays good for its five minutes. Once
   paired, the popup shows only which buddi it is connected to, how many tabs
   it is working in, and **Forget this buddi**.

The settings page finds the extension itself. Its manifest pins a public key,
so its id is the same on every machine, and it accepts one message —
`{type:'buddi.status'}` — from loopback pages only, which the worker checks
against `sender.origin` as well. The page sends that message every three
seconds while **Your browser** is selected, and says either *Extension found,
version x.y.z* or that it is not installed in this browser, with **Add to
Chrome**. The extension's version is buddi's in the four integers
Chrome accepts (`0.1.0-pre.24` is `0.1.0.24`); when it differs from the
running buddi's, the page says so in one line and carries on. A Chrome Web
Store install has its own id, `pbfpjefkiijjgefblpnlnlpmeaddfbah` (the store
build carries no key); the page asks both ids, and the gateway pairs either. Each release attaches the store upload,
`buddi-extension-<version>.zip`. It passes on the code while the extension is showing one,
says so when the browser is already paired, and, when the extension is aimed at
a different address than the dashboard is served from, says which and asks for
it to be changed in the popup. The answer carries no token.

The extension keeps a token in `chrome.storage.local` and reconnects with it
from then on. Buddi stores only a SHA-256 of that token, in
`<BUDDI_DATA_DIR>/extension.json` (owner-only), together with when it was
paired, which extension build it is, which extension id it is, and when it was
last seen. **Forget this browser** deletes that record and closes the socket;
the extension then asks to pair again. `buddi doctor`'s `browser` row says the
same thing from the command line.

Five wrong codes spend the code: the extension is told to start over and shows
a new one, and the wrong tries count against the dashboard's own rate limiter.
A code lives five minutes and so does the connection waiting on it. The pairing
binds the extension's id, so a second unpacked copy cannot take over the
pairing; it is refused until you forget this browser.

Both ends prove themselves at every connection, and neither trusts the other
first. The extension's `hello` carries a random nonce and no token; buddi
answers with that nonce signed by the stored hash, which is the only secret it
has; the extension checks the signature against the token it kept, and only then
sends the token, which buddi checks against the hash. A socket that has not
finished both halves is never sent a command, and the extension runs none.

The wire is one WebSocket on `ws://127.0.0.1:<port>/api/extension/socket`,
upgraded only from a loopback socket with no proxy headers and only from a
`chrome-extension://` origin. One extension at a time: a newer connection that
completes the handshake replaces the older one. Buddi pings every 20 seconds and
closes a browser that misses three; a command that goes unanswered for a minute
fails with a sentence rather than hanging, and the browser is told to abandon
it. Nothing else is sent until it confirms it has, or ten seconds pass, so the
next command never lands on a page nobody has seen.

Tabs open in the background, in a tab group named **buddi**, one group per
conversation. `close` removes that group's tabs; a dropped socket leaves them
open, because by then they are yours, and buddi forgets which tabs and refs were
whose. Those tabs stay yours in the other direction too: drag one out of the
**buddi** group and agents refuse to act in it or close it, and while you are
looking at one of their tabs in the window you are using, input is refused
rather than typed under your hands. A ref belongs to the page it was read from,
so a redirect between observing and acting is refused instead of clicked
through. Observations carry the same `e12` refs, tree, tabs and screenshots as
Playwright mode, and `open` (native apps) and coordinate targets are refused here
exactly as they are there. The extension never fills a password field: it
refuses with a precondition error, and you sign in yourself. The one exception
is `secret.fill` with one of the owner's own secrets
([owner-secrets.md](owner-secrets.md)), whose names and places `secret.list`
gives the agent without any value: the owner's card, the origin the
extension itself re-reads before anything is focused or cleared, and the value
typed in one piece through the debugger — never a value the agent typed.

## Optional: Playwright browser automation

**Everything below describes the explicit Playwright mode**, not the native
default. Release native sessions, select Browser automation in the settings,
then follow this setup. The previous implementation is retained.

Buddi can drive a **real, visible Chromium window on the machine running
`buddi serve`**. Dashboard and paired-owner Telegram requests use the same
controller. The host must be awake.

## Setup

The agents' browser is Playwright's bundled Chromium when it is installed,
else Google Chrome where it is installed (`/Applications/Google Chrome.app`
on macOS, `/opt/google/chrome` or `google-chrome`/`google-chrome-stable` on
PATH on Linux). With neither, `browser.status` and Settings → Computer &
browser say "No browser installed for the agents yet", and `browser.act`
fails with one sentence the agent relays instead of a Playwright stack trace.

Install Chromium from that page's **Install Chromium** button
(`POST /api/browser/install`), or from a terminal — a checkout and a packaged
install alike:

```sh
buddi browser install     # Playwright's installer for chromium, about 150 MB
buddi browser             # which browser the agents will use
```

No restart is needed: the browser is looked for at each launch. A packaged
install prints one line about it on its first run, and downloads it then only
when asked (`BUDDI_BROWSER_INSTALL=1 buddi`).

On Linux, a launch that fails for missing shared libraries says so in the
status with the command to run once with sudo
(`playwright install-deps chromium`, from the Playwright buddi ships). buddi
never runs sudo itself.

Chromium runs its pages in a sandbox, and buddi always keeps it on. Some
systems do not let a program set that sandbox up, and then the browser stops at
launch with "No usable sandbox". The status, the first-run check and
`browser.act` say so in one sentence with the command to copy. On Ubuntu 23.10
or newer, AppArmor is what blocks it; run once, with sudo:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

That lasts until the next reboot. To keep it, put the line
`kernel.apparmor_restrict_unprivileged_userns=0` in a file such as
`/etc/sysctl.d/60-buddi-browser.conf`. In a Docker container, the default
seccomp profile is what blocks it; start the container with
`--security-opt seccomp=unconfined`.

On Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY` set — a headless server —
the browser launches headless and the status says so. Watching and taking over
from the Canvas go through CDP (screencast and Playwright's mouse and
keyboard), so both work headless; only a window on the server's own screen is
missing.

Grant `browser.*` to the agent you want to use, in its private `agent.md` tools
list, or ask the agent-maker to update that grant and approve the configuration
change. No agent gains browser access merely because this plugin is installed.
A browser task spends a turn on every page it reads, so it eats the agent's
turn budget — 40 steps per run unless its `agent.md` pins another `maxTurns`.
A run that reaches the budget stops there and says so in the chat, with the
work it got to; ask it to continue, or raise that agent's `maxTurns`. Do not
replace its existing tools list with just browser tools. Reload/restart after a
manual configuration edit.

Then ask the agent in dashboard chat or Telegram to open a website and perform a
specific task. The request authorizes navigation, form entry and the requested
submission; it does not produce another approval dialog for every click.

Open **Host browser** in the dashboard rail (or `#/browser`) to see the current
agent, task, URL, step budget and latest page snapshot.

In chat, an open page also opens a **Page** tab in the right-hand canvas,
beside charts and artifacts. It follows only the selected agent and conversation,
updates the picture after actions, and holds Stop and Take over; ⋯ on the strip
holds Stop agents' browsing, Show the window and the full page view (the Page
tab enlarged over the whole window). You can
switch canvas tabs without the polling pulling you back. On smaller screens, use
the chat's Canvas button. When the page closes the tab keeps its last picture,
unpinned.

**One tab, pinned, for as long as the session lives.** A browser session used to
open a tab per `browser.act` — a row of "Browser · Act" cards, each showing one
input and "Completed: yes", with the tab that mattered buried behind them. It
now owns a single **Browser** tab, marked `pinned` while the session is alive:
`splitTabs` in `packages/web/src/canvas/Canvas.tsx` holds it on the strip even
when the strip is short, and it cannot be closed from the strip while it is
live. The calls it covers do not open tabs of their own — the page passes their
tool names as `folded` to `renderablesFrom`
(`packages/web/src/canvas/renderables.ts`), so a dozen "Browser · Act" cards no
longer bury the panel showing the screen. A call stopped on an approval is
never folded: a decision waiting on the owner outranks any panel. When the
session ends the mark is cleared and the tab becomes ordinary history, keeping
its last screenshot. A failure is not pinned — it would crowd out the work —
but the overflow menu carries its red dot, so the strip says a failure is back
there before it is opened.

## Logins and controls

The browser has its own persistent profile under
`<BUDDI_DATA_DIR>/browser/profile` (default: `data/browser/profile`). It is not
your everyday Chrome profile. Sign in there directly on the host. Persistent
cookies survive a normal restart; session cookies and website-expired logins do
not. The directory is owner-only, gitignored under the default data directory,
and outside the artifact store and normal Buddi backups. Protect a custom data
directory accordingly. No tool exports passwords, cookies or profile files.

- **Take over** pauses input for the selected conversation. Its tabs stay open so you can
  sign in, handle MFA/CAPTCHA or make a manual choice. An action in flight is interrupted —
  a pending load is stopped and the agent's evidence is void — but the page it was on is kept,
  because that page is usually the reason you pressed the button.
  Other conversations can continue in their own tabs. Use the selected tab for
  manual work: new manually-created tabs without an opener are not assigned to an agent.
- **Resume access** is an owner-only control. Send a new message to the agent
  afterward; the UI does not silently replay the interrupted task. The agent
  must observe again before acting.
- **Stop agents' browsing** (⋯ on the Page tab, for an hour or until you say) closes every conversation's tabs and revokes browser access, including across
  service restarts, until you explicitly resume access. It cannot undo a form
  submission that has already reached a website.
- **Close & release** ends only the selected conversation's task and closes its
  tabs. Other conversations keep working. It does not undo a global Stop.

### Saving a sign-in

While you hold a page, buddi itself — never a model — watches for a sign-in
going out: a form with a filled password field submitted (Enter or a click on
its button; not a show-password eye, Forgot or Cancel), or a fetch right after
the password changed that left the field gone. In buddi's own browser the watch
runs over the remote hand's CDP session in an isolated world the page's scripts
cannot see, reporting through a binding exposed to that world alone; the user
name and the password stop in the browser host's login keeper
(`packages/tools/browser/src/logins.ts`), held in memory for two minutes. The
hand socket says `{ type: "loginSeen", id, site, username }` — never the
password — and the Page tab shows "Save this login for amazon.com?" above the
window: **Save**, **Not now**, **Never for this site** (`POST
/api/browser/login { id, decision }`, the dashboard session and CSRF only).
In your Chrome the same watch runs in a tab you hold (injected beside the
"buddi is waiting" bar, which asks the question itself); Save sends the pair
from the tab to the worker and on to buddi over the extension's paired socket
(a `login` frame, believed only from the held tab, with the origin Chrome
reports for it), Never sends the site alone, Not now sends nothing. Save hands
the pair to the owner-secret store through core's `secrets.put`, as the owner:
the password becomes the secret `login · amazon.com`, bound as `browser.field`
to the origin the form sat on and asking the first time, exactly the binding
the sign-in card's "Save a login for next time" makes, so `secret.fill` finds
it; the user name is kept beside it as a label (`<data>/browser/logins.json`,
with the never-list), and `secret.list` tells the agent that user name so it
can type it. Nothing of this passes through a model, a transcript, a tool
result or a log line, and the scrubber covers the value from the moment it is
stored. Settings → Keys and secrets lists it as "Login · amazon.com · for sam@…
· saved 3 Oct" with Remove.

### The remote hand: driving from the dashboard

**Take over** now offers more than a pause. In buddi's own browser the Page
tab answers it with a live picture of the
page and takes your pointer and keyboard on it, so a login, an MFA prompt or a
consent banner can be dealt with from a phone instead of by walking to the
machine. A thin bar over the picture says *You are driving. Nothing you type
here is kept*, with **Give it back** beside it and, on a phone, a **Type into
the page** toggle that raises the keyboard. **Give it back** is `resume`: the agent's evidence is
invalidated and it must observe again before acting.

A page in your Chrome is not streamed: Take over brings its tab to the front
of your Chrome instead (see "Work in view" above), and the status says so with
`held`.

**With no browser connected.** In "Your browser" mode with the extension
offline (Chrome closed on the host), Take over still pauses the agent but there
is no tab to show. The gateway says so (`handReason: 'browser-offline'` on the
take-over's answer) and the panel shows *Your browser isn't connected* with two
ways out: open Chrome on the host (the extension reconnects by itself) and
**Try again**, or **Use buddi's browser instead**, which releases this
conversation's session and switches the mode to Playwright (the mode is one
setting for the installation and changes only with no session open, so another
conversation's open session refuses it with that sentence).

A route a plugin provides (the Computer plugin's apps) has no remote hand and
says so with the route's own sentence (its `handMessage`, *Take over at the
computer for your apps* when it gives none), while the Canvas keeps showing
the frames the route sends. Telegram is unchanged; it still says to take over
from the dashboard.

**Nothing typed during a take-over is kept.** The keystroke goes from the page
to the socket to the host browser and is gone: it is never written to a log, an
event row, the transcript or the model's context, and the gateway holds it in
no field on its way through. What reaches the socket is validated first —
bounded coordinates, an allow list of key names, and a single character for a
typed one — so nothing longer than a keystroke can be pushed through that
field.

The wire is one WebSocket at `/api/browser/hand`, on the same upgrade listener
as the extension socket and gated the way every dashboard write is: the session
cookie on the upgrade request, an `Origin` this gateway would accept a write
from, the CSRF token as the socket's first frame, and a tailnet session
re-confirmed against the daemon. One hand at a time — a second dashboard tab is
told *Another tab is driving* rather than fighting it for the mouse — and only
for the session that holds the take-over. A frame is one binary message: a short
header carrying the page metadata, then the JPEG it describes. The dashboard
decodes it with `createImageBitmap` and draws it onto a canvas, and maps clicks
back to page coordinates through that metadata and the size the picture is
displayed at. When the socket drops the picture freezes with *Connection lost*
and a **Reconnect** button. `resume`, `release` and **Stop** all end the hand
and close the socket.

**The picture is paced by the link, not by the host.** A browser paints sixty
frames a second and a phone two hops away carries a fraction of that, so
feeding every frame to the socket does not make the picture faster — it makes
it *older*, by however much backlog has piled up since you pressed Take over.
So exactly one frame is on the wire at a time and only the newest one waits
behind it; everything painted in between is dropped, because a picture nobody
will see is not worth a second of your link. Frames start at 960×600 at JPEG
quality 50, and drop to 640×400 at 40 when the socket stays more than 256 KB
behind for a second, growing back once it has been clear for five. What you
lose is frames you would never have seen; what you gain is that the picture is
always now.

Your own events are paced too. A finger dragging across the picture fires a
move per pixel: the dashboard sends at most one position every 33 ms and always
the latest, and the gateway coalesces again on its side, so the pointer goes
where your finger is rather than replaying where it has been. A press, a
release, a wheel or a key is never coalesced, and takes any pending position
with it so the button lands where you are pointing. Keys and moves are
forwarded without waiting for the previous one's result — in order, but
pipelined, so typing is not one host round trip per character.

The socket does not outlive what let it in. It holds a lease on the dashboard
session: that session is checked again at most a second after any input and at
least every thirty seconds, so an expired session, a signed-out device, a
tailnet login that is no longer allowed and Tailscale being switched off all
end the hand — immediately, at the moment the session is forgotten, rather than
at the socket's next idea. Two hours is the most any single take-over lasts, ten
minutes of nobody touching it ends it, and a client that stops answering pings
(every fifteen seconds, two missed) or falls two megabytes behind is given up
on: frames are dropped rather than queued, and the screencast is stopped rather
than left running for a phone that walked out of range.

Ending is ordered, because the agent must never start acting into the owner's
half-finished input. Messages are handled one at a time; **Give it back** marks
the hand closing, refuses anything new, waits for what is already executing,
releases whatever is still held down — a mouse button, a Shift — and only then
stops the screencast and lets `resume` return. In Playwright mode the hand
holds the exact page it is showing: if that page closes, navigates outside the
allowed websites, or loses its debugger connection, the hand ends and the owner
must take over again. It never follows the browser to another tab.

**Take over while the agent is working** is the normal case, not an edge one —
the agent reached the login and is still going round on it, and that page is
what you want your hands on. The action in flight is abandoned and the page is
kept: in Playwright mode a pending load is stopped at once rather than at its
timeout, the tab, its context and its cookies stay exactly as they were, and
the live view paints the page the agent was on. In "Your browser" the extension
is told to stop the command and your tab is left alone. Either way the agent's
evidence is void and it must observe again after you resume. If the interrupt
leaves nothing to paint — the tab really did close — the Page tab says so at
once instead of offering a live view that never draws its first frame.

In "Your browser" the frames are Chrome's own `Page.startScreencast` through
the extension's debugger, acked the moment they arrive — before the throttle,
because Chrome paints nothing more until a frame is acknowledged — and
throttled to ten a second,
and the input is `Input.dispatchMouseEvent`/`dispatchKeyEvent` on the session's
tab; input is refused unless a screencast is running. The extension's rule that
it will not type into a tab you are looking at does not apply to your own hand.
In Playwright mode the screencast is a CDP session on the page and the input is
Playwright's own mouse and keyboard.

The agent should close its tabs when its task is finished, unless you asked to
leave them open. Up to eight conversations can share one host profile, each
with its own tabs, observation IDs, screenshots, step budget and takeover state.
The full Browser page lets you select a conversation; the chat canvas is scoped
to that chat. The same agent can use separate dashboard and Telegram conversations.
Ownership also expires
after at most 20 minutes; a request gets at most 80 tool steps. A fresh owner
message can start a new bounded task, but an agent cannot mint another request
or override an owner Stop itself. A session marked **Ready** is waiting with its
tabs open, not necessarily running an agent turn. **Working** means a browser
action is in flight. Closing/releasing clears current errors; historical failed
tool-result cards remain labeled as history in the conversation.

Tabs are capability-separated, **not separate accounts or browser sandboxes**:
they share cookies, saved logins, local storage and website-side state. Signing
out or changing a shopping cart in one tab can affect another. Do not ask two
agents to make conflicting changes to the same account at once. Popups inherit
their opener's conversation; agents cannot enumerate or select another
conversation's tabs. Unknown manual tabs are not automatically assigned.

Snapshots update after agent actions, not as a live video feed. They show the
capture time, and password inputs are masked. The page text and latest screenshot
are sent to the agent's configured model provider. Screenshot bytes are
ephemeral, not base64 saved in the conversation database. Form tool arguments,
page text, and ordinary conversation/audit records can still contain sensitive
information. Do not put passwords or MFA codes in chat.

## On Telegram: the same screen, from the phone

A conversation bound to a Telegram chat gets what the dashboard's Page tab
shows, in the two forms a phone has.

**A photo per step.** After every `browser.act`, the observation the agent just
looked at is sent as a photo, captioned with the page title, the action in
words, `Step n of max`, and the failure reason when the step failed. One photo
per step: an `observe` of a page already sent is skipped, because the page id
did not change.

**Nothing is sent that the agent was not allowed to see.** A screenshot is page
content going to a third party's servers, so it is checked again on the way
out: a page whose host is not in `BUDDI_BROWSER_HOSTS` is not sent, and on the
apps route — where the screenshot is a whole application window — the window's
bundle ID must be one the conversation was let into (`session.allowedApps`: on
the Computer plugin's list, or allowed by card) or allowed Once
(`session.allowedOnce`). Anything unreadable or missing
fails closed and the step is reported in words only.

**A "Take over" button** under the photo links to that conversation's Browser
tab on the dashboard: `https://<host>:<port>/#/chat/<agent>/<conversation>?tab=browser`
when `BUDDI_WEB_PUBLIC_ORIGIN` is configured (the tailnet address, which a phone
signed in through Tailscale opens signed in, and where the remote hand is built
for touch). With no public origin the link is the loopback address and the
caption says *open this on the computer buddi runs on*.

**The controls**, owner-only like every other Telegram command:

| Command | Same as the dashboard's |
| --- | --- |
| `/browser` | the panel's own state: mode, who is driving, whether access is stopped |
| `/browser stop` | **Stop agents' browsing** |
| `/browser resume` | **Resume access** |
| `/browser release` | **Close & release** / **Release control** |

Take over is deliberately not a command: driving by hand needs a canvas, and
that is what the button's link is for.

Where it lives: `packages/gateway/src/telegram/browser-view.ts` (the photo, the
throttle by observation id, the allow-list check, the button and the four
commands), `browserTabUrl` in `packages/gateway/src/web/config.ts` (public
origin, else loopback with the caption line), and `?tab=browser` on the chat
route, honoured once by `ChatPage`. Panels other than the browser — tables,
charts — keep their text rendering on Telegram; a photo of a canvas is still a
later step.

When access is stopped, the refusal the agent reads names the way back on the
surface it is answering on — `/browser resume` on Telegram, the Settings page
on the dashboard.

## Tools and limits

`browser.status` is a read-only availability/status tool. `browser.act` is a
session tool with navigate, observe, click, fill, select, press, scroll, tab and
close operations. Targets use exact accessible roles/names, labels, placeholders
or text, with frame numbers. Prefer the explicit `targets` list returned in each
observation: `{"action":"click","observation":"<latest id>","target":{"ref":"e12"}}`.
Each ref binds one observed element, including repeated link labels. The driver
also accepts `by:"link"` as a compatibility shorthand for `by:"role",role:"link"`;
it does not relax uniqueness or observation checks. The driver
checks that the element is still connected and its identifying attributes and
form destination have not changed. Unrelated ticker/text changes do not stale
a ref. Legacy semantic targets still require an unchanged accessibility tree.
A mutating call uses the latest observation (filled in when the agent leaves
it out). A precondition failure dispatches no input and returns the fresh page
instead of retrying the action; eight in a row ask the owner Keep going?. An
input that may have landed part-way is the Look? card, never an automatic
retry of a possible submission. No arbitrary JavaScript, OS-wide input, file upload or automatic
download capability is exposed.

Pages are opened for authenticated interactive dashboard/Telegram requests.
The route chooser keeps an unattended run (a mission) in buddi's own browser,
never the owner's Chrome; core's session tier still decides whether such a run
may call `browser.act` at all, and today it does not, nor does a delegate.
A standalone CLI process does not launch a second controller: use the dashboard
or Telegram served by `buddi serve`.

Public HTTP/HTTPS destinations on ports 80/443 are permitted by default. The
browser connects through a local SOCKS proxy that checks DNS at the actual
socket lookup, rejects private/local addresses and disallows UDP. Chromium's
implicit loopback bypass is removed, non-proxied WebRTC/QUIC are disabled, and
service workers are blocked. Navigations, redirects and popups also go through
URL checks. This is browser egress confinement, **not an OS sandbox for arbitrary
plugins or a guarantee against browser vulnerabilities**.

Optional installation settings:

```dotenv
# Exact navigation hosts, including any required login/iframe hosts.
# Omit to allow the public web within the rules above.
BUDDI_BROWSER_HOSTS=example.com,accounts.example.com
# Optional: use an installed Google Chrome instead of bundled Chromium.
BUDDI_BROWSER_CHANNEL=chrome
```

Host restrictions come from installation configuration, not model-supplied
arguments. Natural-language task limits (which appointment, budget, recipient,
etc.) remain agent judgment; the code does not prove that an arbitrary website
click satisfies them. Untrusted page text cannot grant tools or change the
deterministic ownership, lifetime, network or revocation rules. Sites may refuse
automation, and login challenges may need your participation. There is no remote
desktop or remote credential-entry UI in this version.

To revoke a specific agent, remove its browser grants and reload/restart. To
clear saved logins, first stop browser access and stop the service, then move the
dedicated `browser/profile` directory to a private backup location. Do not touch
your everyday Chrome profile. Keeping the moved directory permits recovery.
