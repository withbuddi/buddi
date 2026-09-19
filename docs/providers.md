# Provider management

Open `#/providers` in the owner dashboard. Add/replace/remove the supported
Anthropic API key, Anthropic subscription token, or OpenAI API key. Keys go to
the existing host vault, never Postgres. Saved values cannot be read back through
the API. The UI holds an entered value only long enough to submit it, then clears
the password field. No secret goes into browser storage or chat.

Provider authentication preference and default model live in
`core.provider_settings`. Anthropic can select API key, subscription token, or
the existing automatic token-first behavior. Explicit selection never falls back
to a different credential kind. Per-agent provider/model pins remain in agent
files: edit them at `#/agents`. An explicit agent model overrides the provider
default. All changes reload the shared catalog for subsequent runs. Existing runs
retain the adapter they started with; there is no mid-run vendor switch.

Credential removal writes a nonsecret tombstone in
`core.provider_credential_state`, disables it for new runs and deletes the vault
entry. The marker prevents an old environment copy from reappearing after restart.
It does not revoke a key at its issuer, erase backups, or cancel active runs.
If physical vault deletion fails, the key stays disabled and the UI asks the
owner to unlock the vault and retry. Saving it again clears the tombstone.

**Test connection** is an explicit owner action. It sends a fixed, small prompt
to the saved default model (which may incur a small charge); it never sends
conversation history, files or tool definitions. Rate limits and authentication
errors are reported without dumping provider response bodies. Tests have a
15-second timeout and no HTTP-status retries. A test result is a point-in-time
check, not a promise about quotas or availability for future requests.

macOS uses Keychain by default. Windows/Linux use the existing AES-256-GCM file
vault and `BUDDI_VAULT_KEY`. Run `buddi init` on the host to initialize its master
key if needed; the dashboard reports a locked/unconfigured vault rather than
falling back to plaintext. Database backups contain configuration and removal
markers only; vault recovery still needs the vault and its independently kept key.

Provider routes use the same authenticated owner session, Origin and CSRF checks
as all dashboard writes, with no-store responses. They are not agent tools.
The server can start with an unavailable default model credential so the owner
can repair it from the dashboard. Named-agent runs on Telegram, dashboard and
background jobs resolve their own provider before starting, not the default
agent's adapter. No automatic cross-provider failover is enabled.
