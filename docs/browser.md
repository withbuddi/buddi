# Computer and browser control

## Default: native computer control (2026-09-18)

The owner clarified that the original OS-first design is the requirement.
**Computer** is now the default mode. The earlier headed Playwright driver is
preserved as an explicit **Browser automation** option. Buddi never silently
switches modes when permissions, accessibility or a website fail.

The existing `browser.status` / `browser.act` grants and `#/browser` route are
kept for compatibility. In Computer mode these tools operate allowed native apps
as well as browsers. The canvas tab is labeled **Computer**. All actions still
require an authenticated interactive owner task; existing step/time/ownership,
delegation restrictions and owner Stop apply in both modes.

### Setup and mode selection

1. Build on **macOS 14+**, with Xcode Command Line Tools (`xcrun swiftc`). The
   browser package builds a fixed, ad-hoc-signed Swift executable at
   `packages/tools/browser/dist/native/buddi-computer`. No downloaded actuator,
   AppleScript, shell command, browser extension, CDP or WebDriver is used by
   Computer mode. Non-macOS hosts must explicitly select Playwright.
2. Open **Host browser → Computer & browser settings**. Choose Computer control
   (default), the browser app, and allowed application bundle IDs. Chrome and
   Safari are initially allowed, Chrome is initially selected. Native apps such
   as `com.apple.TextEdit` and `com.apple.calculator` require an owner settings
   change. Agents cannot change the mode or allowlist.
3. Click **Check permissions**, then **Request macOS permissions** if needed.
   Grant macOS **Accessibility** and **Screen Recording** to the helper/service
   identified by the system prompt. This may be attributed to its launching app
   or service. Restart Buddi and check again if macOS requires it. Buddi cannot
   grant these permissions itself. Native rebuilds may require permission renewal.
4. Send a fresh task to an agent granted `browser.*`. `navigate` opens an ordinary
   tab through macOS LaunchServices, in the selected browser's existing profile.
   `open` selects an owner-allowed app. No debugging connection is created.

Settings persist in `<BUDDI_DATA_DIR>/browser/settings.json` (owner-only). Active
sessions must be released before changing settings or requesting permissions.
Switching modes does not lift a persisted Stop; old requests cannot be replayed
to obtain a new budget after a mode switch. Playwright uses its existing separate
profile, not the native browser's profile.

### Native actions and handoff

```json
{"action":"open","appId":"com.apple.calculator"}
{"action":"navigate","url":"https://en.wikipedia.org"}
{"action":"observe"}
{"action":"click","observation":"LATEST_ID","target":{"ref":"ax12"}}
{"action":"click","observation":"LATEST_ID","target":{"x":120,"y":180}}
{"action":"fill","observation":"LATEST_ID","target":{"ref":"ax5"},"value":"search text"}
{"action":"close"}
```

Refs come from the macOS accessibility tree of the selected app's focused window.
Clicks use accessibility actions where supported, otherwise OS mouse events.
Fill and restricted keys use OS keyboard events, not the clipboard. Window
identity, focus and the observed target are rechecked before input. Pixel clicks
are relative to the window screenshot, and require an unchanged screenshot;
animation can therefore make a coordinate click fail safely. Prefer refs. DOM
`select` and Playwright tab IDs are unavailable: click visible options/tabs.

Only **one conversation** owns native computer control at a time. It retains the
lock between tool calls and during takeover. Other conversations cannot steal
the desktop or switch modes to evade that lock. **Take over** interrupts input;
**Resume access** requires a fresh observation; **Release control** and `close`
end control **without closing windows or applications**. **Stop computer control**
revokes access across restarts until owner resume. Apps, documents and browser
tabs remain open. Already dispatched actions cannot be undone. Do not use the
same mouse/keyboard while the agent is driving. A focus change causes refusal,
not automatic refocusing; use takeover, then resume in the intended app.

An observation or screenshot failure preserves the helper's actual error and
pauses control instead of returning a successful empty observation. The agent
cannot retry or click blindly while paused. Inspect the reported cause and the
selected window, use **Resume access**, then request a fresh observation. Resume
clears old screenshots and target evidence. Release remains available. If input
already completed before capture failed, the result explicitly preserves that
fact: do not repeat the input just to recover a screenshot.

Automatic **size-based transcript rollover** in Telegram and the dashboard
continues the same agent's existing computer/browser task. The surface moves the
session before adopting the new transcript and carries at most six short text
messages plus the task description, never old tool calls or accessibility trees.
Session identity, expiry and paused state survive; old requests are fenced and
the next action must be a fresh observation (or release). No click is replayed.
Idle rollover, explicit reset, another chat or another agent do not adopt control,
and conversation-scoped host execution permissions are not transferred.

### Native boundaries and current limitations

- Captures only the selected window, not the whole desktop. Its screenshot and
  bounded accessibility text go to the configured model provider. Secure AX
  fields are masked and cannot be filled; other sensitive visible information
  can still be captured. Use human takeover for credentials/MFA.
- The helper is a short-lived fixed native executable, with bounded JSON input,
  output and timeout. Cancellation terminates outstanding helper processes.
  No arbitrary script, arbitrary hotkey, clipboard or file-transfer operation is
  exposed. The owner allowlist restricts which app Buddi selects, **not what an
  allowed app itself can do**. This is not an OS sandbox or a guarantee that UI
  gestures match the owner's natural-language intent.
- Native apps use their normal network and sessions. Public-URL/host validation
  applies to explicit `navigate` calls only. **The Playwright SOCKS guard cannot
  constrain native app redirects, clicked links, background traffic or external
  app launches.** Do not assume the two modes have identical confinement.
- App menus, complex popovers, minimized/off-screen windows and custom widgets
  may not expose usable AX targets. Only the uniquely matched focused window is
  captured. The initial implementation has no drag, right-click, arbitrary
  keyboard shortcuts, multi-monitor desktop overview or remote interactive feed.
- Native OS input does not make behavioral automation detection impossible.
  It removes the browser debugging connection, not websites' other signals.
- Unit/contract tests use a fake native bridge. The Swift helper compiles and
  the non-prompting permission probe runs on the host. **Live native input and
  capture acceptance remain pending owner-granted macOS permissions.**

First acceptance test after granting permissions: allow `com.apple.calculator`,
ask an agent to open Calculator, calculate `12 × 7` by clicking visible buttons,
report the result, and release control while leaving Calculator open. Then test
Wikipedia: ask the agent to open it and wait, take over and choose an article,
resume, and ask it to observe and summarize without navigating away.

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
   for five minutes. Type it into **Pair your browser** on the settings page.

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
refuses with a precondition error, and you sign in yourself.

## Optional: Playwright browser automation

**Everything below describes the explicit Playwright mode**, not the native
default. Release native sessions, select Browser automation in the settings,
then follow this setup. The previous implementation is retained.

Buddi can drive a **real, visible Chromium window on the machine running
`buddi serve`**. Dashboard and paired-owner Telegram requests use the same
controller. The host must be awake and have an available desktop session.

## Setup

After installing dependencies and building the workspace:

```sh
pnpm --filter @buddi/tool-browser exec playwright install chromium
buddi service restart
```

Grant `browser.*` to the agent you want to use, in its private `agent.md` tools
list, or ask the agent-maker to update that grant and approve the configuration
change. No agent gains browser access merely because this plugin is installed.
For longer tasks, consider increasing that agent's `maxTurns`; its usual turn
limit still applies. Do not replace its existing tools list with just browser
tools. Reload/restart after a manual configuration edit.

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

## Logins and controls

The browser has its own persistent profile under
`<BUDDI_DATA_DIR>/browser/profile` (default: `data/browser/profile`). It is not
your everyday Chrome profile. Sign in there directly on the host. Persistent
cookies survive a normal restart; session cookies and website-expired logins do
not. The directory is owner-only, gitignored under the default data directory,
and outside the artifact store and normal Buddi backups. Protect a custom data
directory accordingly. No tool exports passwords, cookies or profile files.

- **Take over** pauses input for the selected conversation. When idle, its tabs stay open so you can
  sign in, handle MFA/CAPTCHA or make a manual choice. During an in-flight action,
  interruption closes that conversation's tabs to prevent delayed input after takeover.
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

## Verification

The opt-in integration suite opens a local booking fixture, fills and submits
it once, checks its receipt, verifies persistent login and blocked destinations,
then repeats the booking through the actual agent loop with a scripted provider.
It does not call a paid model, contact Telegram, send mail or make a real booking.

```sh
BUDDI_BROWSER_TEST=1 BUDDI_BROWSER_HEADED=1 pnpm --filter @buddi/tool-browser test
```

Without `BUDDI_BROWSER_HEADED=1`, the opt-in browser fixture runs headless for CI.
Production launch remains headed. The local-address exception exists only as an
injected test policy; no environment variable enables it in production.
