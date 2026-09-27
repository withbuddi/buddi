---
title: "ChatGPT subscription"
status: reference
updated: 2026-09-27
---

# ChatGPT subscription

A model account that runs on your paid ChatGPT plan instead of an API key.
buddi signs in the way OpenAI's Codex CLI does, then sends each model turn to
OpenAI's Codex backend itself. There is no extra software to install. buddi's
tools do the work, under the same permissions and approvals as any other
account. See [providers.md](providers.md) for the account model all provider
accounts share.

## Set it up

First, in your ChatGPT settings, under **Security**, allow device code sign-in
for Codex. When it is off, buddi says so: "Device code sign-in is not enabled
on this ChatGPT account. Turn it on in ChatGPT settings, under Security."

Then either:

- **On first run**, pick the **ChatGPT — I pay for ChatGPT** card. buddi shows a
  code and opens the sign-in page on openai.com. Enter the code there and
  approve buddi. buddi notices within a couple of seconds, picks your plan's
  default model and names it, with the list under it to pick another.
- **Later**, open **Settings → Model accounts → Add account**, choose **ChatGPT
  subscription**, give it a name and save. Choose **Connect ChatGPT**: the card
  shows the code, a copy button and an **Open openai.com** button. Enter the
  code, approve, and the model list appears once the account is connected. Pick
  a model, then assign the account to an agent. No agent moves to the new
  account on its own.

The code works for about fifteen minutes. After that, start again.

## What it costs

Model turns use your ChatGPT plan's Codex allowance, the same way the Codex CLI
would. buddi cannot see how much of that allowance is left: the token counts
the dashboard shows are buddi's own, not your plan's usage or billing.

## What buddi keeps

- The credential lives in buddi's vault (the Keychain on macOS, the encrypted
  file vault elsewhere), one entry per account. Nothing secret goes into the
  database, the dashboard or the logs.
- buddi refreshes the credential before it expires and saves the new one back
  to the vault. The account page shows when the current access token expires.
- A refresh that fails, or one interrupted by a crash, asks you to reconnect
  the account (**Reconnect ChatGPT**). A failed reconnect keeps the old
  credential.
- **Disconnect** removes buddi's copy. It does not end the grant at OpenAI and
  does not touch your own Codex login on the machine; buddi never reads or
  reuses that login.

## What leaves the machine

Each turn goes to OpenAI's Codex backend: the agent's instructions, the
conversation, the tool descriptions and tool results, as with any model
account. The sign-in and refreshes go to OpenAI's sign-in service. Nothing goes
anywhere else.

## Limits

- There is no per-turn token cap, so a request that sets one is refused, and
  **Test connection** is not offered for this account: assign it to an agent
  and send a test chat instead.
- PDFs are not supported. A history that uses a tool the agent no longer has is
  refused.
- Chat works on every platform buddi runs on, Windows included. Only the image
  plugin (below) still refuses Windows.

## The image plugin

The image plugin is the one place that still runs the `codex` command: it
generates images with `codex exec`. For that, buddi stages your credential in a
private, temporary Codex profile and removes it afterwards; your own Codex
setup is not changed. It needs `codex` on the `PATH` of buddi's service, and it
does not run on Windows yet.

## Turn it off

Set `BUDDI_SUBSCRIPTION_SIGNINS=off` in buddi's environment and restart. The
ChatGPT and Claude sign-ins disappear from the dashboard and existing
subscription accounts stop being used; you can still disconnect and remove them.
Before turning it off, move agents to another account.
