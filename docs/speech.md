---
title: "Speech"
status: reference
updated: 2026-09-27
---

# Speech

The speech plugin lets your agents listen and talk. An agent with `speech.*`
can turn a recording into text (`speech.transcribe`) and answer with a voice
(`speech.say`), which lands in your Files library as an audio file. It also
gives Telegram its ears and voice ([Voice on Telegram](telegram.md#voice)), and the dashboard's composer its
microphone and speaker switch ([Talking to buddi](dashboard.md#chat)).
It is a plugin, `@buddi/tool-speech` in the buddi-plugins repository,
installed like the image plugin. Listening and speaking run either through a
cloud account or on this computer, with nothing leaving it.

## Set it up

1. Install it: **Settings → Plugins → "A directory I built"** with the path of
   the built `buddi-plugins/speech`, or
   `buddi plugins install /path/to/buddi-plugins/speech`.
2. Either install the local models (next section), or have a model account
   that can do audio, in **Settings → Model accounts**: an **OpenAI** account
   with an API key, or an **OpenAI-compatible** account whose server answers
   OpenAI's two audio routes (a local Whisper server, LM Studio, speaches, a
   Kokoro server).
3. Open **Settings → Speech**. Under **Listening**, pick the service, the
   account and the model, then the languages you speak. Under **Speaking**,
   pick the service, the account, the model and a voice. With Kokoro, you
   pick a voice for each language you speak instead: an **English voice**,
   a **French voice** and so on, one row per language on your list that
   Kokoro has voices for. A cloud service keeps the one **Voice**, and so
   does Kokoro when your list is empty (its English voices). Save each side.

   **Models.** The Model list shows what your account offers: buddi asks its
   server (`GET /models`, kept ten minutes) and lists the ids with
   `transcribe` or `whisper` in them for listening, `tts` or `speech` for
   speaking, the default first (`gpt-4o-mini-transcribe` and
   `gpt-4o-mini-tts` on OpenAI). A new account's models appear once you have
   saved it. When the server lists nothing, only the default is offered;
   **Other…** takes any id you type.

   **Languages you speak.** Pick every language you send voice notes in, up
   to eight, from about 25 by name. None means the language your profile
   answers in ("Answer me in" on You), sent as the one language, and the
   Listening block says "From your profile: French."; with that blank too,
   any. With one, it is sent to
   the service as the language, which helps short clips. With several,
   Whisper on this computer picks the likeliest of yours for each recording
   (a French accent is not heard as Portuguese), and a cloud service is sent
   none and detects the language itself. With Kokoro as the speaker and a
   language on your list that no Kokoro voice speaks (Japanese, Chinese,
   German…), the Speaking block says so: "No German voice on this computer;
   German replies use the cloud speaker when one is set, else text."
4. Try each side. **Test** on Listening sends a two-second clip that says
   "Hello from buddi. This is a test." and shows what was heard. On Speaking,
   the play button beside **Voice** says "Hi, I'm buddi. This is how I
   sound." in your browser with the service, account, model and voice the
   form holds, saved or not; beside a language's voice (**French voice**) it
   says the same sentence in that language; press it again to stop. Nothing is kept, and it
   does not count against the daily limit.
5. Give `speech.*` to the agents that should use it, on their Access page.

A ChatGPT subscription, a Claude sign-in and Ollama Cloud are not offered:
none of them serves audio.

## On this computer

**Whisper** (small, multilingual) listens and **Kokoro** (82M: English,
French, Spanish, Italian, Portuguese and Hindi) speaks without anything leaving the machine, on macOS and Linux alike, the
Docker image included. buddi downloads each once: **Settings → Speech → On
this computer → Install**, with a progress line, or from a terminal:

```sh
buddi speech install           # both
buddi speech install whisper   # 252 MB
buddi speech install kokoro    # 105 MB: the model, and eSpeak NG
buddi speech                   # which are here
```

The files come from Hugging Face at a pinned version, each checked against
its SHA-256 before it is kept; a failed check keeps nothing. Kokoro comes
with eSpeak NG (13 MB, from the npm registry at a pinned version, checked
the same way), which pronounces its languages other than English. eSpeak NG
is GPL-3.0, so it is downloaded like the models rather than shipped inside
the plugin; its licence is kept beside it in `plugins-data/speech/espeak/`.
Kokoro installed before this version speaks English until you press
**Install** again (or run `buddi speech install kokoro`), which fetches only
eSpeak NG. They live in the
data directory under `plugins-data/speech/`. **Remove** on the page deletes
one. Installed, and with no other service chosen for that side, they are
used; you can also choose them by name. **Off** as the service turns that
side off even with its model here: `speech.transcribe` or `speech.say`, and
voice on Telegram and the dashboard, answer that it is not set up.

- Whisper reads OGG/Opus (Telegram's voice notes), MP3 and WAV, up to ten
  minutes a recording, one at a time. It detects the language among the ones
  you speak (any, when you listed none), or uses the one you listed. On an Apple M-series Mac a short voice note
  takes under a second once the model is loaded, a little more for the first.
- Kokoro speaks English with American and British voices, and French,
  Spanish, Italian, Portuguese (Brazilian) and Hindi with voices of their
  own: eSpeak NG turns the text into the sounds Kokoro reads, as Kokoro's own
  pipeline does. A reply is said with the voice you chose for its language
  (on Telegram, read aloud on the dashboard, or `speech.say`): an English
  reply with your English voice, a French one with your French voice. For a
  language Kokoro speaks that has no voice chosen, its first voice is used
  (Siwis for French, Dora for Spanish). An agent that names a voice keeps it
  when it speaks the reply's language.
  The language is what the reply looks like, or, when it is too short to
  tell, the one language you speak. Japanese and Chinese voices are in
  Kokoro's pack but not offered: they need a different pronunciation front
  end. Asked to say something in a language it has no voice for, Kokoro
  refuses rather than read it wrong; Telegram then sends the answer as text.
  A short reply takes about half a second. Its voice notes are OGG/Opus at
  24 kbps.
- Both run on the CPU, through ONNX Runtime's prebuilt binaries: nothing is
  compiled on install and ffmpeg is not needed.
- They run in a thread of their own, so the rest of buddi (the dashboard,
  Telegram) keeps answering while a long reply is read aloud; they use up to
  four cores and leave two free, and `SPEECH_THREADS` sets the number.

## What it costs

On OpenAI, listening is billed by the minute of audio and speaking by the
length of the text, on your API key, at OpenAI's current audio prices. A
compatible server costs what that server costs you; Whisper and Kokoro on
this computer, nothing but the download and some CPU.

Two daily limits bound it: 200 transcriptions and 200 spoken replies a day by
default, counted from your midnight, yours and every agent's together. Change
them under **Daily limits**. Past a limit the tool says so and does nothing.

## On Telegram

The **On Telegram** block chooses how your chat answers with a voice: when
(when you send a voice note, always, or never) and what (the voice note
alone, or with the text). `/voice` in the chat changes the same two choices
([Voice on Telegram](telegram.md#voice)).

## Text for the ear

Before any service speaks it, `speech.say` rewrites the text for the ear,
whichever service speaks:

- Markdown goes: emphasis, inline code, headings and quotes lose their
  marks, each bullet and each table row becomes its own sentence (a row's
  cells separated by commas), and a code block is said as "a code block".
- A link is read as its label, a bare address as its site ("buddi.com").
- `@buddi` is read as "buddi", an agent's handle as its name on Telegram
  (an agent calling `speech.say` can pass `handles` too), else as the bare
  word.
- `2026-09-27` is "September 27" this year and "September 27, 2026"
  otherwise; `10:53` stays. An amount with a currency is said in words:
  `$40`, `40 USD` and `USD 40` are "40 dollars", `-6626.35 USD` is "minus
  6,626 dollars and 35 cents" (euros and pounds alike). Another decimal is
  "6626 point 35", `72%` is "72 percent", `1,024` stays.
- Emoji go; → is "to", & "and", ≤ "at most", ≥ "at least", ° "degrees".

What was written is kept as the file's caption in Files; only what is said
changes.

## What it asks

The first transcription in a conversation is an approval card, and so is the
first spoken reply; after you approve one, the rest of that conversation runs.
A colleague your agent delegated to counts as the same conversation. A new
conversation asks again. Your own voice notes on Telegram ask nothing: that
is you, not an agent.

## What leaves this computer

With a cloud listener, the recording. With a cloud speaker, the text to say.
Each goes to the service of the account you chose: OpenAI (api.openai.com) or
the address of your compatible account, which sends back the text or the
audio. With Whisper and Kokoro on this computer: nothing. The page's **What
leaves** section says it for your current choice. Installing the local models
fetches files from huggingface.co and its download servers and sends nothing.

buddi keeps one row per use (who asked, in which conversation, which service
and model, how long) and the spoken reply in your Files. A transcript goes
back to the agent that asked; the plugin does not keep it.

## Limits

- A recording is at most 25 MB, the most OpenAI's route takes, and must be
  audio by its bytes: OGG, MP3, M4A, AAC, WAV, WebM or FLAC (Whisper on this
  computer: OGG/Opus, MP3 and WAV, up to ten minutes).
- A spoken reply is at most 4,000 characters. It is asked for as OGG/Opus,
  the voice-note format; a server that sends another audio format is kept as
  what it sent, and one that sends something that is not audio is refused.
- OpenAI's voices are its fixed list (alloy, ash, ballad, coral, echo, fable,
  nova, onyx, sage, shimmer, verse). Kokoro's are its voice pack (Heart,
  Bella, Emma, George…, Siwis in French, Dora and Alex in Spanish, Sara and
  Nicola in Italian, Dora and Alex in Portuguese, Alpha and Omega in Hindi). A compatible server names its own.
