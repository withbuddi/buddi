---
title: "Speech"
status: reference
updated: 2026-09-27
---

# Speech

The speech plugin lets your agents listen and talk. An agent with `speech.*`
can turn a recording into text (`speech.transcribe`) and answer with a voice
(`speech.say`), which lands in your Files library as an audio file. It also
gives Telegram its ears and voice ([Voice on Telegram](telegram.md#voice)).
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
3. Open **Settings → Speech**. Under **Listening**, pick the service and the
   account; leave the model blank for the default (`gpt-4o-mini-transcribe` on
   OpenAI) or type the one your server names. A language (`en`, `fr`) helps
   short clips; blank lets the service detect it. Under **Speaking**, pick the
   service, the account, the model (blank for `gpt-4o-mini-tts`) and a voice.
   Save each side.
4. Press **Test** on each side. Listening sends a two-second clip that says
   "Hello from buddi. This is a test." and shows what was heard. Speaking says
   "This is buddi." and saves it to your Files.
5. Give `speech.*` to the agents that should use it, on their Access page.

A ChatGPT subscription, a Claude sign-in and Ollama Cloud are not offered:
none of them serves audio.

## On this computer

**Whisper** (small, multilingual) listens and **Kokoro** (82M, English)
speaks without anything leaving the machine, on macOS and Linux alike, the
Docker image included. buddi downloads each once: **Settings → Speech → On
this computer → Install**, with a progress line, or from a terminal:

```sh
buddi speech install           # both
buddi speech install whisper   # 252 MB
buddi speech install kokoro    # 92 MB
buddi speech                   # which are here
```

The files come from Hugging Face at a pinned version, each checked against
its SHA-256 before it is kept; a failed check keeps nothing. They live in the
data directory under `plugins-data/speech/`. **Remove** on the page deletes
one. Installed, and with no other service chosen for that side, they are
used; you can also choose them by name.

- Whisper reads OGG/Opus (Telegram's voice notes), MP3 and WAV, up to ten
  minutes a recording, one at a time. It detects the language, or follows the
  one you set under Listening. On an Apple M-series Mac a short voice note
  takes under a second once the model is loaded, a little more for the first.
- Kokoro speaks English only, with American and British voices. Asked to say
  something in another language, it refuses rather than read it wrong;
  Telegram then sends the answer as text. A short reply takes about half a
  second. Its voice notes are OGG/Opus at 24 kbps.
- Both run on the CPU, through ONNX Runtime's prebuilt binaries: nothing is
  compiled on install and ffmpeg is not needed.

## What it costs

On OpenAI, listening is billed by the minute of audio and speaking by the
length of the text, on your API key, at OpenAI's current audio prices. A
compatible server costs what that server costs you; Whisper and Kokoro on
this computer, nothing but the download and some CPU.

Two daily limits bound it: 200 transcriptions and 200 spoken replies a day by
default, counted from your midnight, yours and every agent's together. Change
them under **Daily limits**. Past a limit the tool says so and does nothing.

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
  Bella, Emma, George…). A compatible server names its own.
