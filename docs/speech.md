---
title: "Speech"
status: reference
updated: 2026-09-27
---

# Speech

The speech plugin lets your agents listen and talk. An agent with `speech.*`
can turn a recording into text (`speech.transcribe`) and answer with a voice
(`speech.say`), which lands in your Files library as an audio file. It is a
plugin, `@buddi/tool-speech` in the buddi-plugins repository, installed like
the image plugin.

## Set it up

1. Install it: **Settings → Plugins → "A directory I built"** with the path of
   the built `buddi-plugins/speech`, or
   `buddi plugins install /path/to/buddi-plugins/speech`.
2. Have a model account that can do audio, in **Settings → Model accounts**:
   an **OpenAI** account with an API key, or an **OpenAI-compatible** account
   whose server answers OpenAI's two audio routes (a local Whisper server,
   LM Studio, speaches, a Kokoro server).
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
none of them serves audio. Listening and speaking on this computer, with
Whisper and Kokoro and nothing leaving it, come in the next update; the page
already lists them as not installed.

## What it costs

On OpenAI, listening is billed by the minute of audio and speaking by the
length of the text, on your API key, at OpenAI's current audio prices. A
compatible server costs what that server costs you; a local one, nothing.

Two daily limits bound it: 200 transcriptions and 200 spoken replies a day by
default, counted from your midnight, yours and every agent's together. Change
them under **Daily limits**. Past a limit the tool says so and does nothing.

## What it asks

The first transcription in a conversation is an approval card, and so is the
first spoken reply; after you approve one, the rest of that conversation runs.
A colleague your agent delegated to counts as the same conversation. A new
conversation asks again.

## What leaves this computer

With a cloud listener, the recording. With a cloud speaker, the text to say.
Each goes to the service of the account you chose: OpenAI (api.openai.com) or
the address of your compatible account, which sends back the text or the
audio. The page's **What leaves** section says it for your current choice.

buddi keeps one row per use (who asked, in which conversation, which service
and model, how long) and the spoken reply in your Files. A transcript goes
back to the agent that asked; the plugin does not keep it.

## Limits

- A recording is at most 25 MB, the most OpenAI's route takes, and must be
  audio by its bytes: OGG, MP3, M4A, AAC, WAV, WebM or FLAC.
- A spoken reply is at most 4,000 characters. It is asked for as OGG/Opus,
  the voice-note format; a server that sends another audio format is kept as
  what it sent, and one that sends something that is not audio is refused.
- OpenAI's voices are its fixed list (alloy, ash, ballad, coral, echo, fable,
  nova, onyx, sage, shimmer, verse). A compatible server names its own.
- Voice notes on Telegram, in and out, come in the next update.
