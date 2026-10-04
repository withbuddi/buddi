# The buddi Chrome extension

The third browser backend: **Your browser**. Instead of driving a browser of its
own, buddi works in the Chrome you already use, in background tabs grouped under
`buddi`. Your sessions are already signed in, so there is nothing to log into
twice, and you keep using the window while it works.

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

One of four states, never two at once:

1. **Not connected**: the address of your buddi (`http://127.0.0.1:4317`
   unless you moved it) and **Connect**. After a failure, the worker's sentence
   in red and **Try again**.
2. **Connecting**: the address greyed out while your buddi mints a code.
3. **Pairing**: the six-digit code, large, with **Copy**, the line saying where
   to type it, **Open buddi settings** (Browser & apps: in buddi.app when it is installed, else in a new tab) and
   **Not this buddi** to go back to the address.
4. **Connected**: which buddi, how many tabs it is working in, **Open buddi**
   and **Forget this buddi**.

## Pairing it with your buddi

1. Click the buddi icon in Chrome's toolbar and press **Connect**.
2. Your buddi answers with a six-digit code, which the popup shows, with a
   **Copy** button beside it.
3. In buddi, open Settings, Browser & apps (**Open buddi settings** in the
   popup goes there). If you are reading the dashboard in the same Chrome, the
   code is already in **Pair your browser**; otherwise type it. The code is
   good for five minutes.

That is once. From then on the extension reconnects on its own whenever Chrome
and your buddi are both running. **Forget this buddi** in the popup, or *Forget
this browser* in Settings, ends it.

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
is and which buddi it is pointed at, plus the pairing code while one is on
screen. Anything else, from anywhere else, is ignored. No token ever leaves
`chrome.storage.local`.

## What it can do, and what it asks for

| Permission | Why |
| --- | --- |
| `tabs`, `tabGroups` | Open, switch and close the agent's own tabs, and keep them in one group called `buddi`. |
| `scripting` | Read the page when an agent observes. The reader is injected for that command only, not declared for every page you visit. |
| `debugger` | Click, type and screenshot the way a person does. Synthetic events do not reach a background tab, and half the web can tell them apart. |
| `storage` | Remember the address of your buddi and the pairing token. |
| `alarms` | Wake up and reconnect after Chrome has put the extension to sleep. |
| `http://*/*`, `https://*/*` | The sites it operates are the ones you ask it for, and they can be any website. It opens none on its own, and it can reach no other kind of address. |

It talks to one address only: a buddi on this machine, over loopback, and it
only ever works in background tabs: a tab you are looking at, or one you have
dragged out of the `buddi` group, is yours and it will refuse to touch it. It
loads no remote code, fetches no asset and reports to nobody. The tabs it opened
stay open if the connection drops, because by then they are yours.

Both ends prove themselves at every connection. The extension sends a fresh
random number and holds the token back; your buddi signs that number with the
token's hash, which is all it stores; only then does the extension send the
token, and only then will it run a command. A program that answers the port
without holding your pairing gets nothing out of this browser.

## Working on it

```
pnpm --filter @buddi/extension build      # esbuild into dist/, icons and all
pnpm --filter @buddi/extension test       # protocol, tree builder, popup states, built manifest, store zip
pnpm --filter @buddi/extension typecheck
```

`dist/` is what you load unpacked and what the release tarball ships as
`extension/`. `src/protocol.ts` is the wire with no Chrome in it, `src/tree.ts`
the observation with no extension in it; both are tested on their own, which is
why neither test needs a browser or a network.
