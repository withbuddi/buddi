---
title: "Computer and browser control"
status: reference
updated: 2026-09-27
---

# Computer and browser control

## Default: the agents' own browser

A new installation starts in **Give agents their own browser** (Playwright) on
every platform. **Use my apps** (computer control) is offered only on macOS,
and only when you choose it. An existing `settings.json` keeps the mode it
holds; on a host that is not a Mac, a stored Use my apps choice runs and reads
as the agents' own browser, and the file is left as written.

## Computer control: Use my apps

**Use my apps** lets an agent drive your own apps on macOS, in the selected
browser's existing profile and in any other app you allow. The headed
Playwright browser stays available as **Browser automation**. buddi never
switches modes on its own when a permission, the accessibility tree or a
website fails.

The same tools do the work: `browser.status` and `browser.act`, granted to an
agent as `browser.*`, and the `#/browser` route. In this mode they operate the
apps you allowed as well as the browser, and the canvas tab reads
**Computer**. Every action needs an interactive task from you, signed in; the
step, time and ownership limits, the rules on delegation, and your Stop apply
exactly as in the other modes.

### Setting it up

1. **A Mac on macOS 14 or newer.** Computer control uses one fixed helper, an
   ad-hoc-signed Swift executable at
   `packages/tools/browser/dist/native/buddi-computer`, built with the Xcode
   Command Line Tools (`xcrun swiftc`). Nothing is downloaded to act for it: no
   AppleScript, shell command, browser extension, CDP or WebDriver. Other
   platforms are not offered it.
2. **Choose it.** Open **Host browser → Computer & browser settings** and pick
   Use my apps, the browser app, and the apps agents may use (by bundle id).
   Chrome and Safari are allowed to begin with, and Chrome is selected. Any
   other app, such as `com.apple.TextEdit`, you allow here ahead of time or
   answer on a card the first time an agent asks to open it (below). Agents
   cannot change the mode, and reach the list of allowed apps only through
   your Always on that card.
3. **Grant the permissions.** Click **Check permissions**, then **Request
   macOS permissions** if needed, and grant **Accessibility** and **Screen
   Recording** to the helper or service macOS names in its prompt; macOS may
   attribute it to the app or service that launched it. Restart buddi and
   check again if macOS asks you to. buddi cannot grant these itself, and a
   rebuilt helper may need them granted again.
4. **Ask an agent.** Send a fresh task to an agent granted `browser.*`.
   `navigate` opens an ordinary tab through macOS LaunchServices, in the
   selected browser's existing profile. `open` brings an app forward by bundle
   id (`appId`) or by name (`app`). No debugging connection is made.

**Allowed apps.** You can allow an app in Settings ahead of time, or answer the
card when an agent first asks. `open` with `app` finds the name through
Spotlight as exactly one installed application (the exact name, any case;
nothing is launched to find it, and it takes five seconds at most); none or
several is refused, and the refusal lists the candidates. An app not on the
list turns the call into a decision card in the agent's conversation — "Use
Voicito on your computer?" — naming the agent, the app and its bundle id as
found on this Mac, never as the agent wrote them, with **Once** (this
conversation only), **Always** (added to `allowedApps` in `settings.json`, so
Settings shows it; with the list full at 32 it counts as Once) and Reject. The
agent is told to wait. After a yes it calls `open` again; after a no, the next
`open` of that app is refused ("The owner said no to Voicito this time.") and
no second card is raised in that conversation. Your answers are read from the
approvals ledger (`ApprovalsArea.decisionsInConversation`), so they hold across
a restart; a Once is also kept on the conversation's session
(`session.allowedOnce`), so the Telegram photo guard treats that app as
allowed. The browser app itself is only ever a Settings choice: `navigate`
never asks. The agents' own browser and "Your browser" have no apps, so `open`
is refused there.

The settings live in `<BUDDI_DATA_DIR>/browser/settings.json`, readable only by
you. Release any active session before you change them or request permissions.
Switching modes does not lift a Stop you set, and old requests cannot be
replayed to get a fresh budget after a switch. The agents' own browser keeps
its separate profile; it never uses your browser's.

### What an agent can do, and taking over

```json
{"action":"open","appId":"com.apple.calculator"}
{"action":"navigate","url":"https://en.wikipedia.org"}
{"action":"observe"}
{"action":"click","observation":"LATEST_ID","target":{"ref":"ax12"}}
{"action":"click","observation":"LATEST_ID","target":{"x":120,"y":180}}
{"action":"fill","observation":"LATEST_ID","target":{"ref":"ax5"},"value":"search text"}
{"action":"close"}
```

Refs come from the macOS accessibility tree of the selected app's focused
window. A click uses the accessibility action where the app offers one, and
an OS mouse event otherwise. Fill and the allowed keys use OS keyboard events,
never the clipboard. Before any input, buddi checks again that it is the same
window, that it has focus and that the target is the one observed. A pixel
click is relative to the window's screenshot and needs that screenshot
unchanged, so an animation can make a coordinate click fail, safely; refs are
better. There is no DOM `select` and there are no Playwright tab ids: the agent
clicks the visible option or tab.

**One conversation at a time** controls your computer. It keeps the lock
between tool calls and while you have taken over; another conversation cannot
take the desktop or switch modes to get around it.

- **Take over** interrupts the agent's input.
- **Resume access** hands control back, and the agent must observe afresh.
- **Release control**, and the agent's `close`, end control **without closing
  any window or app**.
- **Stop computer control** revokes access, across restarts, until you resume.

Apps, documents and browser tabs stay open. An action already sent cannot be
undone. Do not use the mouse and keyboard while the agent is driving. If focus
moves, the next action is refused rather than refocused: take over, then
resume in the app you meant.

Every observation carries `observedAt`, and its result opens with "Observed
12:04:35 UTC.", so the agent can tell the newest screen from an older one.
After a click that submits or navigates, it observes once more before it
concludes, and judges from the newest observation only.

When a site mails a one-time code, an agent that has the email tools reads it
from your inbox before asking you: the newest message from that site, arrived
in the last ten minutes. The code is never stored and never reused. The agent
types it with `browser.act`, so it appears in that call's input in the
transcript; the scrubber only knows values saved under Keys and secrets.

When an observation or a screenshot fails, the agent gets the helper's actual
error, never an empty observation that looks like success. Most of these are a
page still loading or busy, so control stays with the agent: the result says
"The page has not answered yet. Wait a few seconds and observe again.", and the
next action must be a fresh observation, never a click on old evidence. If the
input went through before the capture failed, the result says so: the agent
must not repeat the input just to get a screenshot. In your own Chrome, the
extension injects its page script again and reads the page up to three more
times, after 0.5, 1 and 2 seconds, before it reports that the page has not
answered.

Control pauses when:

- the tab or window the agent was reading is gone (closed by you, or by the page);
- observation fails three times in a row in the same session;
- a click, fill, select or press failed part-way, since it may have half
  happened;
- targeting fails three times in a row;
- you take over.

While paused the agent cannot retry or click. Look at the reported cause and
the selected window, press **Resume access** (or send `/browser resume` on
Telegram), then ask for a fresh observation. Resuming clears old screenshots
and target evidence. Release is always available.

When a long conversation rolls over to a new transcript because of its size, in
Telegram or the dashboard, the same agent carries on with the same computer or
browser task. The session moves before the new transcript is taken up, carrying
at most six short text messages and the task description, never old tool calls
or accessibility trees. The session's identity, expiry and paused state
survive; old requests are fenced off, and the next action must be a fresh
observation (or a release). No click is replayed. A rollover after idle time,
an explicit reset, another chat or another agent does not take control over,
and permissions to run commands on the host for that conversation do not carry
over.

### What leaves the machine, and the limits

- **What is captured.** Only the selected window, never the whole desktop. Its
  screenshot and a bounded amount of accessibility text go to your configured
  model provider. Secure accessibility fields are masked and cannot be filled;
  anything else visible can still be captured, so take over yourself for
  passwords and two-factor codes.
- **What the helper can do.** It is a short-lived fixed executable with bounded
  JSON input, output and timeout; cancelling kills any helper still running.
  There is no arbitrary script, arbitrary hotkey, clipboard or file transfer.
  The list of allowed apps limits which app buddi picks, **not what an allowed
  app itself can do**. This is not an OS sandbox, and nothing guarantees that a
  gesture matches what you meant in words.
- **The network.** Your apps use their normal network and sessions. The
  public-URL and host checks apply to an explicit `navigate` only. **The
  Playwright SOCKS guard cannot constrain an app's redirects, clicked links,
  background traffic or the apps it launches.** The two modes are not confined
  the same way.
- **What it cannot reach.** App menus, complex popovers, minimised or
  off-screen windows and custom widgets may expose no usable accessibility
  target. Only the one focused window that matches is captured. There is no
  drag, no right-click, no arbitrary keyboard shortcut, no overview across
  several monitors and no live remote view.
- **Detection.** OS input does not make automation undetectable. It removes
  the browser's debugging connection, not the other signals a website reads.
- **Testing.** buddi's automated tests use a fake native bridge; only the
  helper's build and the permission probe, which never prompts, run against
  the real system.

**Try it.** After granting the permissions, allow `com.apple.calculator`, ask
an agent to open Calculator, work out `12 × 7` by clicking the visible buttons,
report the result, and release control with Calculator left open. Then
Wikipedia: ask the agent to open it and wait, take over and choose an article,
resume, and ask it to observe and summarise without navigating away.

## Optional: "Your browser", the Chrome extension

The third mode, shown in **Computer & browser** as **Your browser**: agents work
in the Chrome you are already signed in to, through a Manifest V3 extension that
ships unpacked in `<install root>/extension`. It works on macOS, Linux and
Windows, because it is Chrome doing the work.

Setup, in the owner's words:

1. Choose **Your browser** in Computer & browser. Release any active session
   first; modes never switch themselves.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load
   unpacked**, and pick the folder the settings page prints.
3. Press **Connect** in the extension popup. It shows a six-digit code, valid
   for five minutes, with a **Copy** button and **Open buddi settings** beside
   it. If the dashboard is open in that same Chrome it fills the code in for
   you; otherwise type it into **Pair your browser** on the settings page. Once
   paired, the popup shows only which buddi it is connected to, how many tabs
   it is working in, and **Forget this buddi**.

The settings page finds the extension itself. Its manifest pins a public key,
so its id is the same on every machine, and it accepts one message —
`{type:'buddi.status'}` — from loopback pages only, which the worker checks
against `sender.origin` as well. The page sends that message every three
seconds while **Your browser** is selected, and says either *Extension found,
version x.y.z* or that it is not installed in this browser, with the
load-unpacked line. The extension's version is buddi's in the four integers
Chrome accepts (`0.1.0-pre.24` is `0.1.0.24`); when it differs from the
running buddi's, the page says so in one line and carries on. A Chrome Web
Store install has its own id (the store build carries no key); the page asks
that id too once it is known. Each release attaches the store upload,
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

In chat, an active session also opens a **Browser** tab in the right-hand canvas,
beside charts and artifacts. It follows only the selected agent and conversation,
updates the snapshot after actions, and includes the same owner controls. You can
switch canvas tabs without the browser's polling pulling you back. On smaller
screens, use the chat's Canvas button. **Open full browser view** still opens the
separate page. Closing or releasing the session removes its live canvas tab.

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
- **Stop all browsers** closes every conversation's tabs and revokes browser access, including across
  service restarts, until you explicitly resume access. It cannot undo a form
  submission that has already reached a website.
- **Close & release** ends only the selected conversation's task and closes its
  tabs. Other conversations keep working. It does not undo a global Stop.

### The remote hand: driving from the dashboard

**Take over** now offers more than a pause. In the two browser modes — "Your
browser" and Playwright — the Browser tab answers it with a live picture of the
page and takes your pointer and keyboard on it, so a login, an MFA prompt or a
consent banner can be dealt with from a phone instead of by walking to the
machine. A thin bar over the picture says *You are driving. Nothing you type
here is kept*, with **Give it back** beside it and a **Keyboard** toggle that
raises a phone's keyboard. **Give it back** is `resume`: the agent's evidence is
invalidated and it must observe again before acting.

Computer mode has no remote hand and says so — *Take over at the computer for
this mode* — because the native helper acts on accessibility targets and has no
raw pointer or keystroke to forward. Telegram is unchanged; it still says to
take over from the dashboard.

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
leaves nothing to paint — the tab really did close — the Browser tab says so at
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

A conversation bound to a Telegram chat gets what the dashboard's Browser panel
shows, in the two forms a phone has.

**A photo per step.** After every `browser.act`, the observation the agent just
looked at is sent as a photo, captioned with the page title, the action in
words, `Step n of max`, and the failure reason when the step failed. One photo
per step: an `observe` of a page already sent is skipped, because the page id
did not change.

**Nothing is sent that the agent was not allowed to see.** A screenshot is page
content going to a third party's servers, so it is checked again on the way
out: a page whose host is not in `BUDDI_BROWSER_HOSTS` is not sent, and in
computer mode — where the screenshot is a whole application window — the window's
bundle ID must be in the owner's `allowedApps`, or allowed Once for that
conversation (`session.allowedOnce`). Anything unreadable or missing
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
| `/browser stop` | **Stop all browsers** / **Stop computer control** |
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
A mutating call must use the latest observation ID. A precondition failure
dispatches no input and returns fresh recovery evidence instead of retrying the
action. After three consecutive targeting failures the session pauses for owner
inspection. Uncertain input failures also pause the
controller for owner inspection, rather than automatically retrying a possible
submission. No arbitrary JavaScript, OS-wide input, file upload or automatic
download capability is exposed.

This version accepts authenticated interactive dashboard/Telegram requests.
Scheduled/source jobs and delegated agent runs cannot create browser authority.
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
