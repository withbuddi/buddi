# First run: you meet buddi

Status: screen script, agreed 2026-09-20. Replaces the seven-screen wizard on
branch `wizard`. The onboarding API (`/api/onboarding/*`) stays; only what the
owner sees changes, plus the shipping fixes in §6.

The person opening this has just typed `npm install -g buddi` and `buddi`, or
was sent a link by someone who did. They are not a developer. They are about to
meet their own assistant for the first time, and that is what the screen should
feel like: an introduction, not a settings tour.

---

## 1. The shape

One screen, one thread. buddi speaks in message bubbles, scripted, no model
behind it yet. It asks for one thing at a time, and the answer is given inline
where a reply would go: a field, a set of cards, a button. Each answer becomes
a bubble on the owner's side, so the thread reads back as a conversation.

- No progress bar, no step names, no Back. The thread scrolls; earlier answers
  are visible above and each carries a small "change" link.
- One primary action at a time, on the right, in the composer's place.
- "Set up later" is a quiet link under the composer, present throughout.
- The screen is the chat layout the owner will use afterwards: same column
  width, same bubbles, same composer. When the real assistant takes over, the
  screen does not change; the speaker does.
- Reload resumes at the first unanswered question with the earlier bubbles
  replayed from the onboarding record and the settings they wrote.
- Tone: short, warm, plain. No "loopback", "vault", "provider", "endpoint",
  "handle", "credential". Those words appear nowhere on this screen.

## 2. The script

Speaker `B` is buddi (scripted). Speaker `A` is the assistant (the model, once
it exists). Owner replies are shown as `→`.

**Opening**

> B: Hi. I'm buddi. I live on this computer, and I'm about to introduce you to
> your first assistant.
>
> B: Nothing you tell me leaves this machine, except what your assistant sends
> to the AI you pick in a minute.
>
> B: First, what should we call you?

Inline: one text field, placeholder "Your first name", primary button "That's
me". Enter submits.

> → Amen
>
> B: Nice to meet you, Amen. I'll set your clock to **America/New_York**,
> which is what this browser says. Right?

Inline: "Yes" primary, "Pick another" opens the timezone select in place.
Saved through the existing owner profile.

**The brain**

> B: Your assistant needs a brain: an AI it thinks with. Which of these do you
> already have?

Inline: cards, two per row, each with a logo, a title and one line. Order:

1. **Claude** — "I pay for Claude". Sign in with the existing Claude
   subscription flow. Shown only when that flow is enabled in this build;
   otherwise the card is absent, not disabled.
2. **A key from Anthropic or OpenAI** — "I have an API key". One field, the key
   pasted, provider detected from its prefix (`sk-ant-` is Anthropic, `sk-` is
   OpenAI), with a small "which?" toggle if detection is wrong.
3. **Ollama** — "Free, on this computer". If Ollama answers on its default
   port, the card says "Found it, running now" and one tap connects. If not, it
   says "Install Ollama, then come back" with the download link, and polls.
4. **Ollama Cloud, or another service** — "I have an address and a key".
   Address and key, for OpenAI-compatible endpoints.

ChatGPT subscriptions are not offered: the adapter they need is not in the
packaged build. When it is, it becomes card 2 and "A key" moves down.

After any card is completed, buddi tests it with one small call and answers in
the thread:

> B: That works. Your assistant will think with **claude-sonnet-5**.

A failure stays in the thread in plain words ("That key was refused. Check it
and paste it again.") with the field still open. The chosen model is the
account's default; "change" opens the model list in place. No account admin
appears here. The accounts page in Settings is unchanged for later.

**The assistant**

> B: Last thing: your assistant. I've picked a name and a face; change either,
> or keep them.

Inline: a name field prefilled with one from a short list buddi rotates
through (Ada, Sam, Noor, Kit, Juno, Remy), a face picker with the same emoji
set as today, and one line "What should it help you with?" prefilled with
"Whatever I ask, and remembering what I tell it." Primary: "Introduce us".

This creates the assistant through `/api/onboarding/agent`, bound to the
account just tested, as the installation's default agent.

**The switch**

The thread does not change. A typing indicator appears under the assistant's
name and face, and the assistant speaks first, on the model, with a first
message it is prompted to make: introduce itself by the name it was given,
say one thing it can do today, and ask one question. buddi's scripted bubbles
stop here.

The composer is now the real composer. The onboarding record is marked done
when the first assistant message has arrived. If the model never answers, the
thread says so in buddi's voice ("Your assistant isn't answering. The AI you
picked may be down; try again, or pick another brain above.") and offers the
brain cards again.

**Offers, in the assistant's first message**

The assistant's first message ends with two offer chips, the same chip style
the chat already has for offers:

- **Talk to me from your phone** — opens the Telegram card in the thread:
  "Two minutes: open Telegram, message @BotFather, send /newbot, paste the
  token it gives you here." A field for the token. Once saved, buddi shows a
  QR code and the deep link: "Scan this with your phone and press Start."
  The pairing completes when the phone says hello; the thread confirms it.
- **Not now** — dismisses the chips. Nothing else is offered on first run.

The thread is the owner's first conversation; it stays in their history like
any other.

## 3. What the screen must never do

- Show an account that does not work. Placeholder accounts named after
  environment variables do not exist on a packaged install (§6).
- Let the owner talk to an assistant with no working brain, here or anywhere
  in the dashboard (§6).
- Mention the terminal. The one command that exists for later (`buddi`) is
  said once by the assistant if asked, never by the screen.
- Ask twice. Name, clock, brain, assistant. Four questions, then it is theirs.

## 4. Resume and "change"

Every answered question stays in the thread with a "change" link on the
owner's bubble. Change reopens that question in place; later answers are
kept unless they depend on it (changing the brain re-tests it and re-binds
the assistant; changing the name re-greets). Reload replays answered
questions from the record and the profile, and asks the first unanswered one.

## 5. Acceptance

1. A clean install reaches the assistant's first message with four answers
   and no other page.
2. Every word on the screen passes a non-developer reading it aloud; the
   banned words in §1 appear nowhere.
3. A refused key, an absent Ollama and a model that never answers each leave
   the owner with a way forward in the thread.
4. Telegram pairing completes from the thread with a token and a QR, no
   terminal.
5. Reload mid-way resumes at the right question with earlier answers shown.
6. The tarball smoke covers the API path; the web tests cover the thread's
   state machine and the resume rule.

## 6. Shipping fixes that go with it

These are not the wizard, but the wizard cannot be honest without them.

- **Only platform plugins ship.** The release list carries no domain plugin.
  The Money block and finance watchers are the owner's own plugin — `finance`
  lives in the `buddi-plugins` repository, is installed like any other, and is
  never in the tarball.
- **No ghost accounts.** The legacy accounts named after `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN` and `OPENAI_API_KEY` are seeded only when that
  variable is actually set. A fresh install has zero accounts until the owner
  adds one.
- **Examples do not pretend.** The shipped Concierge is the assistant the
  wizard creates: it is renamed, re-faced and bound to the chosen account
  rather than a second agent appearing beside it. Agent Father is not listed
  until an account exists and the owner has met their assistant; it is the
  "make me another one" that comes later.
- **No brain, no composer.** An agent whose account is missing, disabled or
  unconfigured is shown greyed in every roster, its page says what is missing
  with a link to fix it, and its composer is replaced by that sentence. This
  applies to the developer checkout too.
