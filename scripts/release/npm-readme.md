<p align="center"><img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/header.png" alt="buddi, with the Buddi Blob" width="800"></p>

**A small AI team that lives on your computer.**

buddi is a personal agent platform you run yourself. Your teammates use
tools, work on schedules, remember what matters, and ask before doing
anything consequential.

[withbuddi.com](https://withbuddi.com) · [docs](https://withbuddi.com/docs/) · [plugins](https://withbuddi.com/plugins/) · [GitHub](https://github.com/withbuddi/buddi)

## Install

You need Node 22 or newer. Nothing else.

```sh
npm install -g @withbuddi/buddi && buddi
```

The first `buddi` sets up a private database, starts a background service
and opens the setup wizard in your browser. Every later `buddi` opens the
dashboard. macOS and Linux.

<img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/home.png" alt="Home: Good evening, Sam, with weather, what is coming up, a world clock and the team." width="100%">

## What it does

- **Agents.** Give each teammate a job: Planner prepares your mornings, Mail
  Triage watches your inbox, Ledger keeps an eye on your money. Agent Father
  makes new ones with you. Each is a markdown file you can read and edit.
- **Approvals.** Sending mail, running a command or acting in a browser stops
  at a card that shows exactly what will happen. You decide.
- **Telegram.** Pair your phone in the wizard. Chat, get the morning brief,
  approve cards, send voice notes.
- **Mail and calendar.** Mail is fetched and threaded on your machine; Mail
  Triage brings you only what needs you. Calendars feed the morning brief and
  Home.
- **Widgets and lock screen.** Weather, what is coming up, a world clock, on
  Home and on a lock screen with a PIN.
- **Plugins.** Weather, calendar, finance, speech, image and more from the
  [plugin market](https://withbuddi.com/plugins/). Each shows every tool, host
  and schedule it brings before you install it.
- **Browser extension.** Let an agent look at and act in your own browser.
  [Add to Chrome](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah).
- **Claude Code.** `buddi mcp` runs buddi as an MCP server.

<img src="https://withbuddi.com/shots/wizard-3-jobs.webp" alt="Setup wizard, chapter 3: What should I take on for you, with tiles for My days, My mail, My money, Voice, My code and Pictures." width="100%">

<img src="https://withbuddi.com/shots/plugins.webp" alt="The Plugins page's Browse tab: Finance, Calendar, Weather, Speech and Image, each by withbuddi." width="100%">

## Private by design

- **Runs on your machine.** Conversations, files and memory live in a private
  database in your data directory.
- **Your keys.** Use your Claude or ChatGPT account, an API key, or Ollama.
  Each agent talks only to the provider you chose for it.
- **Secrets stay in the vault.** Agents can use a password, never read it.
- **No telemetry.** Besides your chosen AI, buddi only checks npm for a new
  version once a day (you can turn it off) and fetches plugins when you ask.

<img src="https://raw.githubusercontent.com/withbuddi/buddi/main/docs/images/lock-screen.png" alt="The lock screen: the date and time, a world clock, the weather and the next events, and a PIN field." width="100%">

## Links

- Website: [withbuddi.com](https://withbuddi.com)
- Docs: [withbuddi.com/docs](https://withbuddi.com/docs/)
- Plugins: [withbuddi.com/plugins](https://withbuddi.com/plugins/)
- Source and issues: [github.com/withbuddi/buddi](https://github.com/withbuddi/buddi)
- Browser extension: [Chrome Web Store](https://chromewebstore.google.com/detail/pbfpjefkiijjgefblpnlnlpmeaddfbah)

buddi is a 0.1 pre-release. Apache-2.0.
