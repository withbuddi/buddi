# Changelog

What changes in buddi from one release to the next, newest first.

## Unreleased

## 0.1.0-pre.25 — 2026-09-30

### Fixed

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

