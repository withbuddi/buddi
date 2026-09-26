---
title: "ChatGPT subscription through Codex"
status: reference
updated: 2026-09-26
---

# ChatGPT subscription through Codex

A model account that runs on your paid ChatGPT plan instead of an API key. buddi
drives OpenAI's Codex client, installed on the same machine, and signs in with
Codex's own device flow: buddi shows a code, you approve it at OpenAI, and the
credential goes into buddi's vault. Each model turn starts a short-lived Codex
process with that credential, and Codex's own tools stay off; buddi's tools do
the work, under the same permissions and approvals as any other account. See
[providers.md](providers.md) for the account model all provider accounts share.

## Set it up

1. Install the `codex` command on the machine that runs buddi, at the version
   under [Limits](#limits), so that it is on the `PATH` of buddi's service.
2. In your ChatGPT account, allow device code sign-in for Codex.
3. In the dashboard, open **Settings → Model accounts → Add account** and choose
   **ChatGPT subscription through Codex**. Give it a name and save.
4. Choose **Connect ChatGPT**. The card shows a link and a code: open the link,
   enter the code, and approve at OpenAI.
5. When the card shows the account as connected, edit it to pick a model from
   the list, then assign the account to an agent. No agent is moved to the new
   account on its own.

The sign-in is not in the setup wizard, because a packaged install does not
ship the `codex` binary.

## What it costs

Model turns use your ChatGPT plan's Codex allowance, through Codex, the same way
Codex itself would. buddi cannot see how much of the allowance is left, and the
token and cost totals the dashboard shows are not your plan's billing.

## What buddi keeps

- The credential lives in buddi's vault (the Keychain on macOS, the encrypted
  file vault elsewhere), one entry per account. Nothing secret goes into the
  database, the dashboard or the logs.
- For each turn, buddi copies the credential into a new private temporary folder
  for Codex, and removes the folder when Codex exits. A crash can leave that
  folder behind until the next start cleans it up.
- Codex refreshes the credential itself; buddi saves the refreshed one back to
  the vault. A refresh that fails, or one interrupted by a crash, asks you to
  reconnect the account (**Reconnect ChatGPT**). A failed reconnect keeps the old
  credential.
- **Disconnect** removes buddi's copy. It does not end the grant at OpenAI and
  does not touch your own Codex login on the machine; buddi never reuses that
  login.

## What leaves the machine

Codex sends each turn to OpenAI: the agent's instructions, the conversation, the
tool descriptions and tool results, as with any model account. The sign-in and
refreshes go to OpenAI through Codex. Nothing goes anywhere else.

## What Codex may do

Codex runs in a disposable profile that buddi creates for the turn and throws
away after. In it, Codex's own shell, file, browser, computer, app, plugin and
image tools are off, no MCP server is allowed (buddi refuses to start if one is
configured), and every skill Codex finds is disabled in that profile only; your
own Codex setup is not changed. Codex's questions to the user are refused. Tool
calls come back to buddi, which runs them with the agent's usual grants. This is
a configuration buddi checks before each turn for the pinned version, not an
operating-system sandbox.

## Limits

- Codex must be on the host at exactly `codex-cli 0.155.0`. Any other version is
  refused until buddi has been checked against it. A packaged install does not
  ship Codex yet: you install it yourself.
- Windows is not supported yet.
- Per-turn token caps are not supported; a request that sets one is refused.
- PDFs are refused. A history that uses a tool the agent no longer has is
  refused.
- New accounts need a model name before the first sign-in; the model list only
  loads once the account is connected.

## Turn it off

Set `BUDDI_SUBSCRIPTION_SIGNINS=off` in buddi's environment and restart. The
ChatGPT and Claude sign-ins disappear from the dashboard and existing
subscription accounts stop being used; you can still disconnect and remove them.
Before turning it off, move agents to another account.
