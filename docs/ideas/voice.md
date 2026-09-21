# Voice: notes on Telegram, audio mode on the dashboard

Status: Proposed
Captured: 2026-09-21

## Problem / opportunity

Talking is faster than typing on a phone, and a reply read aloud is the
difference between a glance and a stop. Telegram already carries voice
notes; the dashboard has a composer and nothing to speak with.

## Possible approach

- One new provider kind, speech, with two directions: transcribe and
  synthesize. A cloud option first (the OpenAI account already bound does
  both), a local option for privacy (whisper for in, the operating
  system's own voices for out on macOS).
- Telegram: a voice note in is transcribed and treated as the owner's
  text, with the transcript shown quoted so mistakes are visible. Out is
  a per-surface setting: text, voice note, or both.
- Dashboard: a microphone button in the composer (press to talk, release
  to send) and a speaker toggle that reads replies as they stream, so the
  first sentence is heard before the answer ends.
- Voice never reaches the model as audio; only the transcript does, so
  the transcript and memory stay text.

## Open questions

- Which local models are good enough on an Apple Silicon Mac without a
  download the wizard has to explain.
- Wake word and hands-free are out of scope; press to talk only.

## Next decision

Telegram voice notes first (two days), dashboard audio after (two days).

## Related work

- `packages/runtime/src/providers`, `packages/gateway/src/telegram`,
  `packages/web/src/chat/Composer.tsx`.
