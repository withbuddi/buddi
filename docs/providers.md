---
title: "Provider accounts"
status: reference
updated: 2026-09-26
---

# Provider accounts

Open **Settings → Model accounts** in the owner dashboard (`#/providers` still
redirects there). Each account is an independent named
connection, not a global preference. Add multiple accounts for the same provider,
then use `#/agents` to explicitly select an account and model for each agent.

Supported connections:

- Anthropic API key, using Anthropic's fixed endpoint.
- OpenAI API key, using OpenAI's fixed endpoint.
- OpenAI-compatible Chat Completions endpoint, with an API key or explicitly no key.
  Supply the API base including `/v1` or a custom path such as `/api/v1`. A bare host
  gains `/v1`. HTTPS is required except for loopback local servers. Compatible model
  names are not restricted to OpenAI prefixes. The selected model/server must support
  the capabilities used by the agent, especially tool calling and images.
  A model that turns images down (say, a text-only model on Ollama Cloud) does
  not stop the run: buddi sends that turn again with each screenshot replaced by
  a line of text, and sends no more pictures for the rest of the run. The run's
  events record it once, as `run.images-refused`.
- Previously configured Claude subscription/setup tokens, imported as legacy accounts.
  These are preserved, not promoted to refreshable OAuth connections. Token expiry and
  subscription renewal date are unknown. The extracted Chrome extension package is
  not loaded into the server.
- [Claude subscription sign-in](anthropic-oauth.md), with browser consent,
  code paste, and coordinated vault-backed token refresh. Uses the plan's
  monthly Agent SDK credits; after them, an API key.
- [ChatGPT subscription](codex-accounts.md), with device-code sign-in. buddi
  talks to OpenAI's Codex backend itself; nothing else to install.
- [Ollama Cloud with a device key](#ollama-cloud-with-a-device-key): no key to
  paste; you press Connect on ollama.com once. Ollama Cloud with an API key is
  an OpenAI-compatible account at `https://ollama.com/v1`.
- [Gemini](#gemini): a Google AI Studio key on Google's OpenAI-compatible
  endpoint, offered as its own choice so the address is filled in.
- [mlxh](#mlxh): local MLX models on this Mac, offered as its own choice so
  the address is filled in and no key is asked.

Both sign-ins are offered by default. `BUDDI_SUBSCRIPTION_SIGNINS=off` hides
both: the account kinds are refused and the wizard and Settings do not offer
them. Anything else, unset included, leaves them on.

**Context window.** Each account carries an optional "Context window" field,
stored in `core.provider_accounts.context_window_tokens`. It overrides the
built-in table of model windows for that endpoint, which is the only truth
available for a locally served model whose window is whatever `num_ctx` the
host was started with. Left blank, the number is the provider's own when its
model list reports one (a ChatGPT subscription does, as would an Ollama host
that says, or mlxh's prompt limit), otherwise buddi's assumption for the model
name; the owner's value always wins. [conversations.md](conversations.md) is what the number is used for.

## Gemini

**What it is.** Gemini through Google's OpenAI-compatible endpoint,
`https://generativelanguage.googleapis.com/v1beta/openai/`, with a Google AI
Studio key (aistudio.google.com/apikey) sent as the bearer. It is an ordinary
`openai-compatible` account labelled "Gemini"; nothing Google-specific runs
on the request path.

**Set it up.** In first run, tap **Gemini** and paste the key
([onboarding.md](onboarding.md)). In Settings → Model accounts, add an
account and pick **Gemini (Google AI key)**: the address and the name are
filled in, the key is the one field left. Either way buddi reads the key's
model list (Google names them `models/gemini-…`; buddi keeps the bare id),
starts on the newest Gemini Pro, and offers the rest of the list to pick from.
A free Google AI key has no Pro allowance, so when Google refuses Pro on the
first test buddi starts on the newest Flash instead and says so.

**What the compatible path does.** Chat, streaming and tool calls; the model
list; the context window (a million tokens for every `gemini-` model in the
built-in table) and the usage view's prices, from Google's published paid
tier.

**What it does not do, yet.** No thinking switch: thinking is left to the
model, as on any compatible host (the endpoint takes `reasoning_effort`, which
buddi does not send). No Google Search grounding or other native tools. No
sign-in with a Google account: a key only.

## mlxh

**What it is.** [mlxh](https://github.com/amenophis1er/mlxh), a local MLX
model server for Apple Silicon, on its OpenAI-compatible API at
`http://127.0.0.1:1060/v1` (1060 is MLX in Roman numerals; `MLXH_BASE_URL`
overrides it on the gateway). mlxh takes any key, so the account is an
ordinary `openai-compatible` account labelled "mlxh" with no key. Install it
with `curl -fsSL https://raw.githubusercontent.com/amenophis1er/mlxh/main/install.sh | bash`
(needs uv), pull a model (`mlxh pull …`), and run `mlxh serve`;
`mlxh service install` keeps it running across logins as a LaunchAgent.

**Set it up.** In first run, the **On this computer** card says what it found
("I found mlxh with 5 models"); **Use mlxh** makes the account and starts on
its first language model, a loaded one first, with the rest under "Think with
another". In Settings → Model accounts, add an account and pick **mlxh, local
MLX models on this Mac**: the address comes from the gateway, the next step
lists the models. When nothing answers, the form says so and how to start it.
The gateway asks `GET /api/onboarding/mlxh`, which reads mlxh's `/mlxh/info`
and `/v1/models` (two seconds, never a prompt) and answers
`{ running, baseUrl, manager, models: [{ id, loaded, kind? }], maxPromptTokens?, workerIdleTimeoutS?, version? }`.

**The model manager.** `mlxh serve` loads no model up front: every installed
model is listed, a request's model loads its worker on demand (the first
answer after idle takes seconds to a minute), and idle workers unload after
`worker_idle_timeout_s` (300 s). `mlxh serve NAME` pins one model instead.

**The context window.** mlxh refuses a prompt over `max_prompt_tokens` with a
400, 8,192 by default; coding-agent-sized conversations need about 40,960
(`mlxh config max_prompt_tokens 40960`). A pinned server reports its limit and
buddi uses it; the manager does not, so an mlxh account's window is 8,192
until you set the account's Context window to the number you configured.
Settings shows where the number comes from.

**Image models.** Image models (FLUX Schnell, Klein, Qwen Image) are listed
too, but answer the Images API, not chat. Once one is loaded, mlxh says so and
the model list flags it ("an image model; pick it in the Image plugin, not
here"); before that, first run passes over them by name. Using them for
pictures belongs to the Image plugin, later.

## Ollama Cloud with a device key

**What it is.** The way `ollama login` connects a computer to your ollama.com
account, done by buddi: buddi makes its own key pair, you approve it on
ollama.com, and every request buddi sends to ollama.com is signed with that
key. There is no key to copy, paste or leak, and the free tier works.

**Set it up.** In first run, tap **Ollama Cloud, one tap**
([onboarding.md](onboarding.md)). In Settings → Model accounts, add an account,
pick **Ollama Cloud**, save, and press **Connect Ollama**. Either way a window
opens on ollama.com's connect page with the device named "buddi on <this
computer>"; sign in there if it asks and press Connect. buddi checks every two
seconds and says "connected as <your ollama.com name>" the moment it goes
through. The attempt lasts 15 minutes; after that, connect again. **Use a key
instead** in the same form makes an ordinary keyed account for ollama.com.

**What buddi keeps.** The key pair, the device name, when it connected and
your ollama.com user name, as one entry in the vault under the account's own
name. Postgres holds only that the account signs in with a device key
(`auth = 'device-key'`, always at `https://ollama.com/v1`). The private key is
never shown, never sent to the page, and never signs a request to any other
host. `buddi status` and the account card show "connected as <name>, device
<device name>".

**What leaves this computer.** To ollama.com, once: the public key and the
device name, in the connect page's address. Then, on each request: the
signature and the public key it verifies against, beside the agent's prompt,
as with any Ollama Cloud account. On Disconnect, one signed request naming the
public key. Nothing else.

**Disconnect.** **Disconnect** on the account first asks ollama.com to forget
the device (a signed `DELETE /api/user/keys/<key>`, as `ollama signout` does),
then removes the key from the vault either way; runs using it stop at their
next model call. The card says whether ollama.com confirmed it; if not, the
device may still be listed in your ollama.com settings, and you can remove it
there. **Reconnect Ollama** makes a new key and replaces the old one.

How it signs: each request carries `?ts=<unix seconds>` and `Authorization:
<public key>:<signature>`, the ed25519 signature of `<METHOD>,<path>?<query>`,
exactly as the ollama client does it.

## Storage and migration

`core.provider_accounts` holds account metadata, revision and secret references.
`core.agent_provider_accounts` holds agent/account/model assignments. Keys stay in the
host vault. The UI never reads back saved values and never stores keys in browser
storage. Newly entered password fields are cleared on submission, including failures.

On its first start after the model accounts feature arrived, buddi imported the keys it
found in the environment and the vault as accounts (three legacy slots), and pinned every installed agent to its previously selected credential and model.
It references existing vault entries without copying values into SQL. Existing removal
markers remain disabled. An explicitly selected missing API key stays missing; it does
not switch to a subscription token. Missing slots can be filled later or removed when
unassigned. A marker prevents restarts from reimporting or rebinding accounts.

An imported account may read its explicitly named legacy environment variable if the
vault entry is absent. Replacing its credential creates an account-specific vault entry
and permanently removes that environment fallback for the account. The old legacy
vault entry is retained on replacement for compatibility/recovery, but the account no
longer uses it. Newly created accounts never read ambient environment credentials.

Once imported, account/model bindings in Postgres override agent-file provider/model
fields. Files still own persona, tools, language and turn budget. Newly installed agents
must be assigned an account; there is no silent default or cross-account fallback.

macOS uses Keychain by default. Windows/Linux use the AES-256-GCM file vault with
`BUDDI_VAULT_KEY` outside Postgres. A packaged install creates the key on its first run (a source checkout: `buddi init`).
Database backups alone cannot restore credentials; preserve the vault and its master
key separately. A locked vault fails closed.

## Account lifecycle

The dashboard can add, rename, replace API keys, test, disable, enable and remove
accounts. Provider/authentication type is immutable: create another account to change
it. Changing a keyed endpoint requires re-entering the credential for that destination.
Saving a default model does not silently change models pinned on existing agents.

Assignments reload the shared catalog for new Dashboard, Telegram, delegated and
scheduled runs. Existing runs retain their selected account/model. Editing or disabling
an account causes its next model call to stop with a clear restart-turn message, rather
than silently rerouting or using an old credential. Requests already dispatched cannot
be recalled. Use **Refresh status** after unlocking a vault or changing accounts from
another process.

Removal is refused while an agent remains assigned; reassign those agents or disable
the account instead. Removal first disables and marks the account as being deleted,
then removes the stored credential and account metadata. If vault deletion fails, the
account remains disabled and cannot be re-enabled; unlock the vault and retry removal.
This does not revoke keys at their issuer, erase backups, or delete retained legacy
credential copies that are no longer referenced by this account.

**Test connection** is an explicit owner action and may incur a small charge. It sends
only a fixed short prompt, no history, files or tools. It has a 15-second timeout and
no HTTP-status retries. Responses report safe connection/auth/rate-limit status, never
raw provider errors or credentials. A result for an edited account is discarded.

## API and CLI

Owner-only routes inherit session, Origin, CSRF, body-size and no-store protections:

- `GET /api/provider-accounts`
- `POST /api/provider-accounts/save`
- `POST /api/provider-accounts/:id/test`
- `POST /api/provider-accounts/:id/remove` with the displayed `revision`
- `POST /api/agents/:id/account` with `accountId` and `model`
- `POST /api/provider-accounts/:id/ollama/connect` with the displayed `revision`:
  a new device key into the vault, and the connect page's address back
- `POST /api/provider-accounts/:id/ollama/poll` with the `attemptId`: one
  signed request to ollama.com, answered `connected`, `waiting` or `failed`
- `POST /api/provider-accounts/:id/ollama/disconnect` with the displayed
  `revision`: ollama.com asked to forget the device, then the key removed from
  the vault

Edits also require the displayed account revision to prevent stale overwrites. Global
provider/credential mutation endpoints return 410 when account management is active.
These operations are not exposed as agent tools.

`buddi agents` and `buddi agents show <handle>` read the account-aware catalog.
`buddi agents set <handle> --account <id> --model <model>` changes a binding;
`--model` alone changes the model on its current account. `--provider` is refused after
migration because it is ambiguous. `buddi agents test <handle>` uses the assigned account.
Restart other running processes after a standalone CLI edit, or refresh Settings →
Model accounts. Dashboard edits take effect in its shared serving process immediately.

The account/domain layer is portable. OAuth and native-client credentials are
resolved server-side; agent tools never receive the credential envelopes.

## Prompt caching

On Anthropic, buddi marks three cache breakpoints on every request: the last
tool definition (the tool list), the last system block (the instructions) and
the last block of the last-but-one message (the conversation up to the previous
turn), so only the newest message is read at the full rate. Thinking and
provider-native blocks are skipped when choosing that last block; there is no
beta header. On OpenAI caching is automatic; buddi sends `prompt_cache_key` set
to the conversation id (Chat Completions to OpenAI itself, and the Codex
sign-in), which only helps requests land on a warm cache. OpenAI-compatible
hosts get neither. Usage reports cached tokens separately: `input` is always
the uncached part, with `cacheRead` and (Anthropic only) `cacheWrite` beside
it, so `input + cacheRead + cacheWrite` is the whole prompt. `/usage`, the chat
footer and Activity show "cached N", and the local cost estimate prices reads
at a tenth of input (or the row's published cached rate) and Anthropic writes
at 1.25x.

## Subscription support: what "complete" means

Two subscription sign-ins exist — [Claude](anthropic-oauth.md) and
[ChatGPT](codex-accounts.md) — and both are offered by default.
This is the checklist a subscription backend is held to:

- **Isolated identity.** A distinct account backend and auth identity, with
  isolated credentials and sessions. Signing in or out of one account must not
  affect another, or the owner's own CLI login.
- **The whole lifecycle in the dashboard.** Start, cancel, reconnect and sign
  out, with bounded polling, stale-login protection, cleanup after a restart,
  and explicit guidance when the native client is missing.
- **No credential anywhere it does not belong.** Not in SQL plaintext, not in
  URLs or logs, not in chat, tools or browser storage. Native credential
  storage is an explicit decision, never a quiet bypass of the vault's
  guarantees.
- **Native tool calls go through buddi.** Every tool call from a native runtime
  passes buddi's existing grants and approvals. No native shell, file, browser
  or computer backdoor, proven with adversarial tests before use.
- **Semantics preserved.** Conversation and tool-result semantics, images,
  cancellation and approval resume all survive. A model or tool capability the
  native runtime lacks is reported explicitly, never silently dropped.
- **Status only when the provider supplies it.** Token expiry, subscription
  renewal, usage reset and last-check are four different things and are not
  inferred from one another. A generic 429 does not prove subscription
  exhaustion, and `Retry-After` is not a guaranteed reset time.
- **Serialized refresh.** Per-account refresh serialization; a disabled or
  removed account can neither refresh nor run.
- **Tested on every surface.** Dashboard, Telegram, CLI, delegates and
  scheduled runs. Owner-assisted real sign-in only after the harness passes,
  and no automatic paid test requests.
