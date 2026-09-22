# Host execution

Status: reference, 2026-09-18

Grant `host.status`, `host.exec`, and `host.stop` (or `host.*`) to an agent to let
it process files using Bash, Python and installed utilities on the host. Tool
availability is not execution permission: the initial command is gated.

## Owner choices

- **Allow once:** execute this exact command, directory, timeout and file inputs.
- **Auto: this conversation:** approve this command and future host commands by
  this agent in this exact conversation. A new conversation asks again.
- **Always: this agent:** approve this command and future host commands by this
  agent across conversations and scheduled tasks, until revoked.
- **Reject:** do not execute; no standing permission is created.

Auto/Always approve arbitrary commands within that scope, NOT just a command
prefix or read-only commands. They survive service restarts. A tool version
change asks again. Approval on an expired/already-decided action cannot create
or widen a standing permission. A model cannot grant itself a permission.
Dashboard and Telegram host approvals continue an ordinary interactive task
after a completed command. Cancelled/uncertain commands do not automatically
continue through that approval callback. Other gated tools keep their existing
approval behavior. CLI prompts support `y`, `c`, `a`, `n`, and `l` for host calls.

The dashboard has a **Host execution** disclosure in the conversation and on
the Approvals page: current scope, running command/output, Stop command and
Revoke permission. Telegram supports `/host`, `/hoststop` (all current commands)
and `/hostrevoke` (all host standing permissions plus interruption). These
commands are authenticated and run immediately, not behind the chat queue.
Rejecting one pending command does not revoke an existing separate permission.

## Execution and files

`host.status` returns a persistent workspace for the owner/agent/conversation.
`host.exec` accepts a Bash command, optional absolute `cwd`, timeout, artifact IDs
in `attachments`, and workspace-relative file paths in `outputs`.

Attachments are copied to `inputs/<artifact-id>/<filename>` in the workspace
after approval. Their content hashes are bound into the preview and rechecked
before dispatch. Normal processing uses copies, preserving original uploads.
Successful commands can publish up to eight output files, 20 MiB total, into
the artifact store. Download links require dashboard authentication; Telegram
links use the configured public origin when present. They do not carry login
tickets. Files are forced to download, not served as executable HTML.

Agents should detect installed interpreters first. CSV needs only Python's
standard `csv` module. For Excel or other dependencies, create a workspace-local
virtual environment and install the needed packages there. Such ordinary
task-local steps can run under auto-mode without another prompt. System-wide
installs/admin changes need explicit task authorization; do not send passwords
in chat. There is no automatic sudo elevation, password piping or GUI fallback.

Commands run through `/bin/bash --noprofile --norc -c`, with closed stdin and a
minimal environment. API keys/database credentials are not inherited from
Buddi. The default timeout is two minutes, maximum ten. Each output stream is
limited to 64 KiB; exceeding it interrupts the command. Write large outputs to
files. One command per conversation, at most four per service. Exit codes,
stdout/stderr, timeout/cancel status and produced artifacts are returned and
recorded in the action outcome. Command text/output are also visible to the
configured model provider; do not place secrets in them.

Stop sends TERM then KILL to the command process group; normal background
children are cleaned up when their parent exits. This is best-effort process
management, not containment against programs deliberately escaping the group.
Detached daemons are unsupported. Cancellation never undoes completed changes.
Commands are not automatically retried by the executor. A crash during dispatch
requires inspection; do not assume a partially completed command did nothing.

## Trust boundary

**This is not sandboxed.** Commands run as the service's OS user and can read
other user files, access the network, modify Buddi's files or discover credentials
accessible to that user. Environment filtering and workspace paths do not
remove those abilities. The existing tool-grant policy cannot prevent arbitrary
host code from modifying that policy. Use auto-mode only for agents/tasks you
trust. A real sandbox would be a separate execution mode, not a label on this one.

macOS Accessibility/Screen Recording permission is not needed for shell/file
processing. Ordinary filesystem protections and OS prompts still apply. This
does not grant admin access or bypass macOS privacy controls. Host execution
currently supports macOS/Linux; Windows is explicitly unsupported.

## Smoke test

Attach a small CSV and ask:

> Use host execution to inspect this CSV with Python. Do not change the original.
> Report the row count and column names, then create a summary.csv I can download.
> Install dependencies only in a local virtual environment if needed.

Choose conversation auto-mode. Follow up with another computation in the same
conversation: no new host prompt. Revoke the permission and ask again: the next
command must ask. A new conversation must also ask unless Always was selected.

Tests use throwaway databases and synthetic files, including real Python CSV
processing, original-file preservation, scopes/version isolation, changed input
refusal, duplicate approval, process cancellation, dashboard auth/CSRF/download,
Telegram owner callbacks, and UI permission controls.
