# The buddi Chrome extension

The third browser backend: **Your browser**. Instead of driving a browser of its
own, buddi works in the Chrome you already use, in background tabs grouped under
the buddi's name. Your sessions are already signed in, so there is nothing to
log into twice, and you keep using the window while it works.

One extension works for several buddis: a release and a checkout on one Mac,
say. Each is a row in the popup with its own pairing, its own tab groups and
colour, and a switch.

An agent cannot tell which backend answered it. The observation it reads (the
page tree, the `e12` refs, the tab list, the screenshot) has the same shape as
the one the Playwright driver builds, and it takes the same targets: a ref from
`observation.targets`, or a semantic one such as `by:"role", role:"link",
name:"Sign in"`, which is resolved against the roles and names the last
observation listed. An ambiguous name is refused with the refs to choose
between rather than guessed at. The same rules apply too: no native apps, no
coordinate clicking, no passwords.

## Loading it

**From the [Chrome Web Store](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah)**:
press Add to Chrome, and it updates itself. The store gives it an id of its own,
`pbfpjefkiijjgefblpnlnlpmeaddfbah` (see below), which the dashboard also asks
for. The dashboard's **Add to Chrome** opens the same listing.

**Unpacked** (developer install), from your installation:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Press **Load unpacked** and pick the `extension` folder inside your buddi
   installation. Settings, under Browser & apps, prints the exact path.

Every GitHub release also carries `buddi-extension-<version>.zip`, the store
upload: the same files, without the manifest's `key`
(`node scripts/release/extension-zip.mjs <version> [dir]` makes one from a
built `dist/`). `STORE.md` holds the listing text, the permission
justifications, the data-use answers and the privacy page.

## Its version

Chrome takes one to four integers, so the manifest carries buddi's version
mapped (`scripts/version.mjs`): `0.1.0` stays `0.1.0`, `0.1.0-pre.24` becomes
`0.1.0.24`, and `version_name` keeps the full string. The build reads
`BUDDI_RELEASE_VERSION` when a release names one, else the root
`package.json`. Settings says when the extension and buddi differ, and carries
on.

## The popup

One row per buddi this browser works for: a colour swatch (its tab groups'
colour), its name (what the buddi said in its handshake, `buddi` for a
release, `buddi-dev` for a checkout, its address until it said one), its
address, how it stands, and a switch. Each row is in one of four states, never
two at once:

1. **Not connected**: after a failure, the worker's sentence in red and **Try
   again**.
2. **Connecting**: "Asking this buddi for a code…".
3. **Pairing**: that buddi's six-digit code, large, with **Copy**, the line
   saying where to type it, and **Open buddi settings** (Browser & apps: in
   buddi.app when it is installed and this is the buddi on 4317, else in a new
   tab).
4. **Connected**: how many tabs it is working in, and **Open buddi**.

Switched off, a row says **Off** and nothing else happens for that buddi in this
browser: no socket, no tabs. **Remove** forgets it here (its address and its
token; its tabs stay, they are yours). **Add a buddi**, at the bottom, takes the
address of another buddi on this machine and starts its pairing; with no buddi
at all it is open on `http://127.0.0.1:4317`. When a buddi's dashboard in this
Chrome asks about itself and this browser has no pairing for it, Add a buddi
opens on that address for you to accept. A page can never add a buddi by
itself: a socket to any loopback port could answer as one, so a pairing is
always your press in the popup.

## Several buddis, and the move from one

The list lives in `chrome.storage.local` under `pairings`: `{ id, origin,
token?, name, colour, enabled }` per buddi (`src/pairings.ts`). The service
worker keeps one socket per buddi switched on (`src/link.ts`), each with its
own handshake, commands and reconnects; a tab belongs to exactly one buddi
(a registry of tab group ids says whose each group is, and no buddi acts in
another's group). An extension that held the single pairing of earlier
versions (`gateway` and `token`) keeps it as the first buddi, switched on, the
first time it starts; nothing has to be paired again. A fresh install starts
with the default address, unpaired, so it still knocks on the buddi at 4317 by
itself.

## Pairing it with your buddi

1. Click the buddi icon in Chrome's toolbar. A fresh install is already asking
   the buddi at 4317 for a code; for another buddi press **Add a buddi** and
   give its address.
2. That buddi answers with a six-digit code, which its row shows, with a
   **Copy** button beside it.
3. In that buddi, open Settings, Browser & apps (**Open buddi settings** in the
   row goes there). If you are reading the dashboard in the same Chrome, the
   code is already in **Pair your browser**; otherwise type it. The code is
   good for five minutes.

That is once per buddi. From then on the extension reconnects to each buddi
switched on, by itself, whenever Chrome and that buddi are both running.
**Remove** in the popup, or *Forget this Chrome* in that buddi's Settings, ends
it.

## Its id, and the key that fixes it

Chrome makes an unpacked extension's id out of the folder path unless the
manifest pins a public key, so the id used to change with the machine and with
every reinstall. `manifest.json` now carries a `key`: the public half of an RSA
pair generated once with

```
openssl genrsa -out buddi-extension.pem 2048
openssl rsa -in buddi-extension.pem -pubout -outform DER | base64
```

The id is Chrome's own derivation from those bytes — the SHA-256 of the DER
public key, first sixteen bytes, each hex digit mapped from `0`-`f` onto
`a`-`p` — and it is written down as `EXTENSION_ID` in `src/id.ts`, mirrored in
the dashboard, and checked against the manifest by `manifest.test.ts`:

```
kmbckpnnjfggeffkkbmkggojnolkdokb
```

**The private half is not in this repository and is not needed.** Loading
the folder unpacked uses the public key only, and the store build carries no
key at all: the store assigned its own id, `pbfpjefkiijjgefblpnlnlpmeaddfbah`,
which is `STORE_EXTENSION_ID` (`src/id.ts`, mirrored in the dashboard; the
manifest test checks the two agree). Nothing here is weakened by its absence, and nothing is gained by
keeping it around.

The fixed id is what lets the dashboard find the extension. `manifest.json`
allows loopback pages — `http://127.0.0.1/*`, `http://localhost/*`,
`http://[::1]/*`, and a match pattern carries no port, so every port matches —
to send one message, `{type:'buddi.status'}`. The worker checks `sender.origin`
is loopback itself and answers with whether it is connected, which version it
is and how it stands with the buddi that asked (matched by the page's origin),
plus that buddi's pairing code while one is on screen, and the list of buddis
it works for (address, name, state, switch). Another buddi's code is never in
the answer. Anything else, from anywhere else, is ignored. No token ever leaves
`chrome.storage.local`.

## What it can do, and what it asks for

| Permission | Why |
| --- | --- |
| `tabs`, `tabGroups` | Open, switch and close the agent's own tabs, and keep them in groups named after the buddi they belong to, in its colour. |
| `scripting` | Read the page when an agent observes. The reader is injected for that command only, not declared for every page you visit. |
| `debugger` | Click, type and screenshot the way a person does, and paint the agent's tab as a live picture for buddi's Canvas and your remote hand. Synthetic events do not reach a background tab, and half the web can tell them apart. Attached only to tabs it opened in its own groups, never to your other tabs; Chrome's "buddi started debugging this browser" bar shows while it is. |
| `storage` | Remember the addresses of your buddis, a pairing token for each, and which are switched on. |
| `alarms` | Wake up and reconnect after Chrome has put the extension to sleep. |
| `http://*/*`, `https://*/*` | The sites it operates are the ones you ask it for, and they can be any website. It opens none on its own, and it can reach no other kind of address. |

It talks only to buddis on this machine, over loopback, and it only ever works
in background tabs: a tab you are looking at, or one you have dragged out of a
buddi's group, is yours and it will refuse to touch it. It
loads no remote code, fetches no asset and reports to nobody. The tabs it opened
stay open if the connection drops, because by then they are yours.

Both ends prove themselves at every connection. The extension sends a fresh
random number and holds the token back; your buddi signs that number with the
token's hash, which is all it stores; only then does the extension send the
token, and only then will it run a command. A program that answers the port
without holding your pairing gets nothing out of this browser.

## The live picture and the remote hand

While an agent has a page open in your Chrome, the extension attaches Chrome's
debugger to that tab and paints it with `Page.startScreencast`, two frames a
second, for the Page tab on buddi's Canvas. A background tab (or one in a
minimised or covered window) is "hidden" to Chrome and paints nothing for a
screencast, so focus is emulated on that tab first
(`Emulation.setFocusEmulationEnabled`): the page renders as if it were in front,
and stays where it is. Every frame is acked on arrival, and goes to buddi as one
binary message in the layout the dashboard reads (`src/frames.ts`: a version
byte, the header's length, the header as JSON with the session, then the JPEG);
a gateway from before gets the old JSON frame.

**Take over** on the Canvas is then the remote hand, as for buddi's own
browser: the same tab painted ten times a second at the quality the gateway
picks for the link (sharp, normal, fast), and your clicks, wheel, keys, paste,
Cmd/Ctrl+C and the window's back, forward, reload and address coming back as
`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`,
`Runtime.evaluate` (the selection, never a password field) and `Page.*`
navigation. **Bring the tab to the front** is the secondary action for when you
are at the computer: the tab comes forward with its bar saying buddi waits.
**Capture** is a PNG from `Page.captureScreenshot` with password fields painted
over. The debugger lets go when the agent's page closes, when you close the
tab, or when you press Cancel on Chrome's bar (the picture then stops and the
Canvas falls back to the last observation).

## Working on it

```
pnpm --filter @buddi/extension build      # esbuild into dist/, icons and all
pnpm --filter @buddi/extension test       # protocol, pairings, links, frames, tree builder, popup rows, built manifest, store zip
pnpm --filter @buddi/extension typecheck
```

`dist/` is what you load unpacked and what the release tarball ships as
`extension/`. `src/protocol.ts` is the wire with no Chrome in it, `src/tree.ts`
the observation with no extension in it; both are tested on their own, which is
why neither test needs a browser or a network.
