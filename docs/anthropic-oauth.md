---
title: "Claude subscription sign-in"
status: reference
updated: 2026-09-26
---

# Claude subscription sign-in

A model account that signs in with your paid Claude plan instead of an API key.
You approve access in your browser, buddi keeps the tokens in its vault, and
agents assigned to the account run on your plan. It is Anthropic's standard
browser sign-in: no Claude Code install, no callback server on your machine, and
nothing that disguises buddi's requests. See [providers.md](providers.md) for the
account model all provider accounts share.

## Set it up

1. In the dashboard, open **Settings → Model accounts → Add account** (or the
   model step of the setup wizard) and choose **Claude subscription**.
2. Give it a name and save. It does not take a pasted API key or setup token.
3. Choose **Connect Claude**, then **Open Claude consent page**, and approve with
   the Claude account you want to connect.
4. Claude shows a code. Copy all of it, including the part after `#`, paste it
   into the account card, and choose **Complete Claude sign-in**. Never paste it
   into a chat.
5. Edit the account to pick a model from the list, then assign it to an agent.
   No agent is moved to the new account on its own.

The consent page opens in your own browser, so this works from a remote
dashboard too; finish in the same dashboard session. An attempt expires after
15 minutes, and restarting buddi ends it.

## What it costs

Paid Claude plans come with a monthly budget of Agent SDK credits for
third-party agents such as buddi: Pro $20, Max 5x $100, Max 20x $200, Team and
Enterprise $100–200 per seat. Credits do not roll over. Once they are spent,
further use needs API billing, so add an Anthropic API key account and assign
it. buddi cannot see how many credits remain, and it never falls back to another
account on its own.

## What buddi keeps

- The access and refresh tokens live in buddi's vault (the Keychain on macOS,
  the encrypted file vault elsewhere), one entry per account. No token or pasted
  code goes into the database, the logs, a chat or the browser.
- buddi refreshes the tokens before use, when they are within five minutes of
  expiring. If a refresh fails or is interrupted, the card says **Token refresh
  did not finish** and asks you to reconnect (**Reconnect Claude**); buddi does
  not retry a refresh token that may already be spent. A failed reconnect keeps
  the old tokens.
- **Disconnect Claude** removes buddi's tokens. It does not revoke the grant at
  Anthropic; do that from your Claude account settings.

## What leaves the machine

The sign-in and refreshes go to Anthropic (`claude.com` and
`platform.claude.com`). Model turns go to Anthropic's API: the agent's
instructions, the conversation, the tool descriptions and tool results, as with
any model account. Nothing goes anywhere else.

## Limits

- buddi cannot show remaining credits, the plan's renewal date or its quota.
- Existing API key and setup token accounts keep working as before; they are not
  converted.

## Turn it off

Set `BUDDI_SUBSCRIPTION_SIGNINS=off` in buddi's environment and restart. The
Claude and ChatGPT sign-ins disappear from the wizard and Settings, and existing
subscription accounts stop being used; you can still disconnect and remove them.
