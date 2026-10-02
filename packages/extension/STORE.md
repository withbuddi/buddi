# The Chrome Web Store listing

**Live** since October 2026: [https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah),
item id `pbfpjefkiijjgefblpnlnlpmeaddfbah`. Each release's
`buddi-extension-<version>.zip` is uploaded as a new version of that item.

What the store's forms ask for, written once. The upload is
`buddi-extension-<version>.zip`, attached to every GitHub release (see the
README's "From the Chrome Web Store").

## Single purpose

Lets the owner's own buddi, a personal agent running on their computer, open and
operate web pages in background tabs of this browser when the owner asks it to.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `tabs` | Opens, switches between and closes the tabs the owner's buddi works in, and reads their address and title so the agent knows which page it is on. |
| `tabGroups` | Keeps every tab it opened in one group titled "buddi", so the owner can see what is being worked on and take a tab back by dragging it out. |
| `scripting` | Injects the page reader into a tab the extension opened, only when the agent asks to read that page, to build a text outline of its buttons, links and fields. No script is declared for every page. |
| `debugger` | Clicks, types, scrolls and takes screenshots in a background tab the way a person would. Synthetic DOM events do not reach a background tab and many sites refuse them. It attaches only to the extension's own tabs, never to the tab the owner is looking at. |
| `storage` | Remembers the address of the owner's buddi and the pairing token, in `chrome.storage.local`. |
| `alarms` | Wakes the service worker once a minute to reconnect to the owner's buddi after Chrome has put it to sleep. |
| Host permissions (`http://*/*`, `https://*/*`) | The sites it operates are the ones the owner asks their buddi for, and those can be any website. It opens none on its own. No other scheme (`file://`, `chrome://`) is requested. |

Remote code: **No.** Every script is in the package; nothing is fetched and
evaluated. The fonts and the mascot image ship inside it too.

## Data use

- **What it collects:** nothing. There is no analytics, no telemetry, no
  account, and no server run by us that it talks to.
- **What it sends, and to whom:** the pages it is asked to work on (their text
  outline, address, title and, when asked, a screenshot) go to the owner's own
  buddi, over a WebSocket to `127.0.0.1` on the owner's machine. Nowhere else.
  What the owner's buddi then does with them (for example, passing them to the
  model provider the owner chose) is the owner's own configuration.
- **What it stores:** the buddi address and a pairing token, in the browser's
  extension storage. Clearing the extension or pressing **Forget this buddi**
  deletes them.
- The store form's checkboxes: it handles **website content** (the pages the
  owner asks it to work on) and nothing in the other categories. It does not
  sell data, does not use it for anything unrelated to the single purpose, and
  does not use it for creditworthiness or lending.

## Short description (132 characters at most)

> Lets your buddi work in background tabs of this browser. The sites it opens are the ones you ask it for; it opens none on its own.

This is also the manifest's `description`; `manifest.test.ts` holds it to 132
characters.

## Long description

> buddi is a personal agent that runs on your own computer. This extension lets it
> work in the Chrome you already use, instead of a browser of its own.
>
> Ask your buddi to check an order, fill in a form or read a page, and it opens
> the site in a background tab, in a tab group called "buddi". You keep using
> your window while it works. Your sessions are already signed in, so there is
> nothing to log into twice.
>
> - It works only in its own background tabs. A tab you are looking at, or one
>   you drag out of the group, is yours, and it will not touch it.
> - It talks to one place: your buddi, on this machine. Nothing goes to us or
>   anyone else.
> - It never types a password on its own. A secret you saved in buddi goes into
>   a field only after you approve that one fill.
> - Pairing takes one code: press Connect, and type the six digits into buddi
>   under Settings → Computer & browser. If buddi is open in this Chrome, it
>   fills them in for you.
>
> You need buddi installed first: https://withbuddi.com

## Privacy page (withbuddi.com/extension/privacy)

> # The buddi extension and your data
>
> The buddi extension for Chrome lets the buddi running on your computer work in
> background tabs of your browser. This page says what it touches and where that
> goes.
>
> **What it reads.** Only the tabs it opened for your buddi, and only when your
> buddi asks: the page's address and title, an outline of its text, links,
> buttons and fields, and, when asked, a screenshot. It does not read the tab
> you are looking at, your history, your bookmarks or your other tabs.
>
> **Where it sends it.** To your own buddi, over a connection to `127.0.0.1` on
> your computer. It sends nothing to withbuddi.com, to us, or to anyone else.
> Your buddi may pass what it sees to the AI model provider you chose in its
> settings; that is between your buddi and that provider, on the terms you
> agreed with them.
>
> **What it keeps.** The address of your buddi and a pairing token, in your
> browser's extension storage. Your buddi keeps only a hash of that token.
> Pressing "Forget this buddi" in the extension, or "Forget this browser" in
> buddi's settings, ends the pairing; removing the extension deletes both.
>
> **What it does not do.** No analytics, no tracking, no advertising, no
> account, no sale or sharing of data. It loads no remote code. It types a
> password only when you have saved it in buddi and approved that one fill.
>
> **Questions.** Open an issue at https://github.com/withbuddi/buddi/issues.
