---
title: "First run: you meet buddi"
status: reference
updated: 2026-09-29
---

# First run: you meet buddi

The person opening this has just typed `npm install -g @withbuddi/buddi` and `buddi`, or
was sent a link by someone who did. They are not a developer. They are about to
meet their own assistant for the first time, and that is what the screen should
feel like: an introduction, not a settings tour.

---

## 1. The shape

One screen, five chapters and a handover, still buddi's voice in bubbles and
still one thing at a time. The kit's `Setup.jsx` (buddi-design) is the pixel
source of truth.

- **A map** on the left: the five chapters, numbered. The open one is lit; an
  answered one shows a tick, its answer in a few words (the name and the
  clock under it, the brain, "My days, my mail" with "Installing, 1 of 2
  ready" under it while chapter 3's plugins arrive, "Phone paired", the
  assistant's name) and **change**. Under them one note about the open
  chapter, then the way out: **Set up later** always; **I have a backup** in
  chapter 1 while nothing is answered; **Start over** from then on. At phone
  width the map folds into a strip: the mark, five dots and "3 · What I take
  on", with the way out under the card.
- **One card** on the field: the chapter's title, buddi's bubbles (the real
  Buddi Blob beside each, moving while buddi works on something), the inputs,
  and a **dock**: "Chapter n of 5" on the left; Back, the chapter's secondary
  action and its primary on the right, on one line. The primary is accent and
  carries an arrow.
- While something is saved and tried, three dots and a line say what is
  happening ("Checking that key…"), until the verdict arrives as a bubble.
- Reload opens the first unanswered chapter with the map replayed from the
  onboarding record, the profile and the accounts.
- Tone: short, warm, plain. No "loopback", "vault", "provider", "endpoint",
  "handle", "credential". Those words appear nowhere on this screen, and
  every sentence reads aloud. All of it is in
  `packages/web/src/views/meet/script.ts`, which a test reads against that list.

## 2. The chapters

Speaker `B` is buddi (scripted). Speaker `A` is the assistant (the model, once
it exists).

**1. Hello** — "Hi. I'm buddi."

> B: I live on this computer and I'm about to introduce you to your first
> assistant. Nothing you tell me leaves this machine, except what your
> assistant sends to the AI you pick next.
>
> B: First, what should we call you, and what time is it where you are?

Two fields on one row: **Your first name** (the caret is in it) and **Your
clock**, prefilled with the browser's zone and "What this browser says. 18:22
right now." under it; **Change** beside it turns it into the zone picker.
Primary "That's me". One save through the owner profile (`preferredName` and
`timezone`), recorded as the `you` step.

**2. A brain** — "Which AI should your team think with?"

> B: Pick what you already have. I test it with one small call before we go on.

Five cards, two per row, in this order:

1. **Free to start, no key** — Ollama Cloud, one tap, marked "Recommended to
   begin". The tap opens a window on ollama.com's connect page with this
   computer named "buddi on <this computer>"; the owner presses Connect there
   and the card notices within two seconds, settles on `gpt-oss:120b` while
   ollama.com offers it, and tests it
   ([providers.md](providers.md#ollama-cloud-with-a-device-key)).
2. **I pay for Claude** — "Sign in with your Claude account. Uses its extra
   usage." Never "monthly credits". The existing sign-in: the consent page
   opens, the owner pastes the code back. Absent, not disabled, when the host
   sets `BUDDI_SUBSCRIPTION_SIGNINS=off`.
3. **I pay for ChatGPT** — a code to type on openai.com; the card checks every
   two seconds and names the plan's default model
   ([codex-accounts.md](codex-accounts.md)). Absent when the host sets
   `BUDDI_SUBSCRIPTION_SIGNINS=off`.
4. **I have an API key** — "Anthropic, OpenAI, Google AI, or another service
   with an address." Three kinds under it: **Anthropic or OpenAI** (one field;
   `sk-ant-` is Anthropic, anything else OpenAI, with "Not right?" to correct
   it), **Google AI** (a Google AI Studio key, the newest Gemini Pro, the
   newest Flash when a free key has no Pro allowance; shown whenever the
   gateway names the address; [providers.md](providers.md#gemini)) and
   **Another service** (an address and a key, the gateway's Ollama Cloud
   address prefilled).
5. **On this computer** — the whole row, with what the gateway found here,
   polled: "I found Ollama with 2 models", "I found mlxh with 5 models", both,
   or "Nothing local answered; Ollama or mlxh, once installed, shows here".
   **Use Ollama** asks which model when there are several; **Use mlxh** starts
   on its first language model ([providers.md](providers.md#mlxh)).

Every card ends in one small call (a ChatGPT plan has no per-turn cap to keep a
test small, so there the assistant's first answer is the test). A service
with several models and no default asks which, once. The verdict is a bubble
— "That works. Your assistant will think with claude-sonnet-5." — with the
model list under it for a brain that serves several; a refusal stays on the
card in plain words with the field still open. **Use this brain** lights only
after the call answered; the account is recorded as the `model` step. A card
tapped while another sign-in is waiting cancels that sign-in.

**3. What I take on** — "What should I take on for you?"

> B: Pick a few. Each one brings a plugin and, for some, a teammate who owns
> that job. Skip this and I stay a plain assistant; you can add any of it later.

Six tiles, three per row, the plugins named in small type: **My days**
(Weather · Calendar), **My mail** (Mail Triage, built in), **My money**
(Finance), **Voice** (Speech), **My code** (Developer, built in), **Pictures**
(Image). My days and My mail are on the first time. **Take these on** posts
`POST /api/onboarding/take-on` with the tiles and opens chapter 4 at once;
**Just an assistant for now** posts an empty list. Either is recorded as the
`take-on` step with the tiles.

The route answers straight away with a plugin job per plugin and runs them in
the background, one after the other: the market index (`/api/market`'s own
reader), then the listing staged like any install, then its approval, then a
live load through the Plugins page's enable path so the hello can already use
it. **buddi approves on the owner's behalf only a By-buddi listing, and only
when the staged tarball's integrity is exactly the one the listing names**;
anything else is refused and waits on its card in Settings → Plugins. The
staged card and its approval are still written, so Settings → Plugins shows
the plugin installed with its hash. A plugin this process cannot load live
says "Weather is installed; it wakes up on the next restart".

`GET /api/onboarding/take-on` answers the progress per plugin (`fetching`,
`reading`, `installing`, `ready`, `failed` with the reason) and what is still
waiting. The page reads it every two seconds while anything runs and draws
"Fetching Weather and Calendar from withbuddi.com and reading them. 1 of 2."
under the tiles and "Installing, 1 of 2 ready" under the map's row; a fetch
that fails is one line there and in the handover card, and never blocks a
chapter.

Teammates are not created by a tick: Chief of Staff (My days) is in the
catalogue, Ledger (My money) and Illustrator (Pictures) the offers
their plugins make on Home, exactly as before.

**4. Reach me** — "How do we reach each other?"

> B: Three things, each a minute. Do the ones you want; the rest wait in Settings.

Three rows, all optional, and **Continue**:

- **Your phone, through Telegram.** With the bot running, the pairing square
  is in the row; the row says "Paired" when the phone says hello, and a line
  under the rows says so. With no bot yet, **Set up Telegram** opens a sheet:
  the BotFather token, then the square, and "Not now" at either step.
- **A mailbox** ("for Mail Triage" when My mail was taken on). **Add a
  mailbox** opens the email plugin's own Settings page in a sheet — the form
  Settings → Mail adds an account with — and the row names the address once
  one is there.
- **buddi as an app, and a browser of its own.** **Install app** hands the
  browser's own install prompt over when it offered one. **Use Chrome** (or
  "Use its Chromium") launches the agents' browser once to be sure it opens;
  **Fetch a browser** installs Chromium with the bar in buddi's words
  ("Fetching Chromium… 45%"), then launches it. A browser on disk that cannot
  start says why, with the command to copy and **Try again**.

Continue records the `reach` step with which rows were done (`phone`,
`mailbox`, `app`, `browser`), and the `browser` step when the browser row was.

**5. Your assistant** — "Meet your assistant."

> B: I've picked a name, a face and a way of working. Change any of it, or
> keep them. Your team so far: Planner and Mail Triage, waiting to be
> introduced.

The Blob at the size of a face with five colour swatches (the agent accents:
blue, orange, green, violet, purple) under it; a **Name** field prefilled with
"buddi"; **How it works**, the persona, prefilled with
`SCRIPT.assistant.purposeValue` ("You're not a chatbot. You're becoming
someone this person can count on.") and editable. Primary **Introduce us**.

The persona is sent as `instructions` and written, verbatim, as the body of the
agent file, between the name line ("You are Ada. There is exactly one owner…")
and the "How you work" section. The file's `description`, the one line on the
Home and Agents cards, is "Your first assistant. Ask it anything; it
remembers." unless the owner sent one of their own. The persona stays editable
afterwards on the agent's Setup tab. Changing the assistant later through
`/api/onboarding/agent/update` rewrites the body only while it is still the
generated one; an untouched field sends no new persona.

This creates the assistant through `/api/onboarding/agent`, bound to the
account chapter 2 tested, and records it as the installation's default agent.
The colour is the Blob of that accent (`public/mascot/`), uploaded through
`/api/agents/:id/avatar`, so it is the agent's real picture everywhere. An
assistant that already wears a picture or an emoji keeps it unless a colour is
picked.

The assistant is the concierge, so it is granted nearly everything built in
(`FIRST_AGENT_TOOLS` in `packages/gateway/src/web/onboarding.ts`): `system.*`,
`email.*`, `memory.*`, `artifacts.*`, `web.*`, `browser.*`, `secret.*`, `host.*`,
`reminder.*`, `schedule.*`, `goal.*`, `learning.*`, `canvas.*`,
`agent.delegate`, the read-only platform tools and `owner.get_profile` /
`owner.set_profile`. Gated and session-tier tools (`host.exec`,
`email.send`, `browser.act`) still ask the owner first. Left out on purpose:
the platform tools that write agents and grants (Agent Father's), and
`owner.rename_me` / `owner.finish_onboarding`, which belong to the interview.

Being the default is an installation record (`core.web_settings`, key
`agents`), not a flag in the agent file: the owner changes it from the picker
at the head of the Agents page, and every surface reads the same row on its
next message with no restart.

**The handover**

The card does not leave: every chapter is ticked on the map, and the assistant
speaks first, on the model, with a first message it is prompted to make. The
server puts what exists in front of the instruction: the owner's name, the
assistant's, the owner's clock and the time there, the plugins chapter 3
installed, the weather at home when Weather is in and answers (the weather
page's own `today` read, never waited on for more than three seconds), and
whether Mail Triage has a mailbox. The assistant introduces itself in two or
three sentences, says what it already knows and can do today, and asks no
question.

Under the hello, four first questions: "What's my day like?" (or "What can you
do?"), "Meet Planner and Mail Triage" (the teammates chapter 3 named, or "Show
me around"), "Link my calendar" (or "Add my mailbox", or "What do you know
about me?"), "Remind me at 9 tomorrow". A tap sends it as the owner's first
message and opens that conversation in the dashboard. Under them, one warm
card, **"Two things still waiting."**, listing exactly what chapters 3 and 4
left open — "Mail Triage is waiting for a mailbox", "Calendar wants your
calendar's private link", "Planner is ready to be introduced", a plugin that
did not install and why — with **Open Home**. The dock holds **Open buddi**,
the same conversation with the rail around it.

The record is completed when the opening turn is claimed. If the model never
answers, the card says so in buddi's voice ("Your assistant isn't answering.
The AI you picked may be down; try again, or pick another brain.") and **Pick
another brain** reopens chapter 2.

## 3. What the screen must never do

- Show an account that does not work. Placeholder accounts named after
  environment variables do not exist on a packaged install (§6).
- Let the owner talk to an assistant with no working brain, here or anywhere
  in the dashboard (§6).
- Mention the terminal. The one command that exists for later (`buddi`) is
  said once by the assistant if asked, never by the screen.
- Ask twice. Five chapters, each answered once, then it is theirs.
- Block on something slow. Installs run behind the chapters; a failure is a
  line, never a gate.

After the first run, more agents come from the catalogue: ready-made agents
from withbuddi.com, each added with one approval ([agents](agents.md#the-catalogue)).

## 4. Resume and "change"

Every answered chapter stays on the map with a "change" link. Change reopens
that chapter in place with its answer filled in; later answers are kept
unless they depend on it (changing the brain re-tests it and re-binds the
assistant; changing the name re-greets). Back does the same for the chapter
before. Reload replays answered chapters from the record, the profile and the
accounts, and opens the first unanswered one; the installs of chapter 3 carry
on behind a reload, and the progress line reads the plugin jobs again.

Start over cancels a sign-in under way and clears the answers; what is
connected (accounts, the phone, the browser, installed plugins) stays, is named
once, and a brain that still answers is met again as answered.

## 5. Acceptance

1. A clean install reaches the hello in under three minutes with chapters 3
   and 4 skipped, and the hello names the weather at home when My days was kept.
2. No chapter can be left with a brain that does not answer; chapter 2 does
   not light "Use this brain" before the test call succeeds.
3. Ticking every tile never blocks a chapter; a failed fetch is one line and
   the handover card names it. Only By-buddi listings whose integrity matches
   are approved on the owner's behalf.
4. The map's "change" and Back work on every chapter; reload resumes.
5. The banned words in §1 appear nowhere; every sentence reads aloud.
6. The web tests cover the state machine, background installs and resume; the
   gateway tests cover the take-on route, its guard and the reach record; the
   tarball smoke covers the API path.

## 6. Shipping fixes that go with it

These are not the wizard, but the wizard cannot be honest without them.

- **Only platform plugins ship.** The release list carries no domain plugin.
  The Money block and finance watchers are the owner's own plugin — `finance`
  lives in the `buddi-plugins` repository, is installed like any other, and is
  never in the tarball.
- **No ghost accounts.** buddi reads no Anthropic credential from `.env` or
  the vault; Anthropic comes in only as a model account. The legacy account
  named after `OPENAI_API_KEY` is seeded only when that variable is actually
  set. A fresh install has zero accounts until the owner adds one.
- **Examples do not pretend.** The shipped Concierge is the assistant the
  wizard creates: it is renamed, re-faced and bound to the chosen account
  rather than a second agent appearing beside it. Agent Father is not listed
  until an account exists and the owner has met their assistant; it is the
  "make me another one" that comes later.
- **No brain, no composer.** An agent whose account is missing, disabled or
  unconfigured is shown greyed in every roster, its page says what is missing
  with a link to fix it, and its composer is replaced by that sentence. This
  applies to the developer checkout too.
