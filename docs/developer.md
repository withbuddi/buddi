# The developer plugin: an agent that works in a workspace

Status: specification for review, 2026-09-21. Nothing here is built.

## 1. Why a separate kind of agent

A developer works in a loop: read, edit, run, read the error, edit again.
Every other buddi agent runs one gated command through `host.exec` with a
card each time, which is right for an assistant that talks to a bank and
unbearable for that loop. Claude Code works because inside a project the
shell and the files are the floor, with a permission mode chosen once.

So this is not "give agents a shell". It is one plugin, `developer`, whose
tools are `auto` inside a workspace the owner granted once and do not
exist outside it. The Playground agent with "Always allowed" host execution
is today's crude version; this replaces it with something bounded.

## 2. The workspace

A workspace is one directory the owner names, absolute, on the machine
buddi runs on, recorded in the plugin's schema with the agent that owns it.
Everything below is relative to it. A path that resolves outside it, by
`..`, by a symlink, or by an absolute argument, is refused before any tool
runs. `~/.ssh`, `~/.aws`, `~/.buddi`, buddi's own data directory and the
vault are refused even when a workspace is placed above them.

An agent has at most one workspace at a time; `developer.workspace` (gated)
sets or changes it, and the card names the directory and what it contains.
The Settings page lists workspaces per agent.

## 3. Modes, chosen once

The mode is a per-agent setting, changed by the owner on the agent's page,
never by the agent:

- `ask`: every write and every command is gated. For a workspace with
  something to lose.
- `edit`: reads, searches, edits and writes inside the workspace are auto;
  commands are gated. The default.
- `run`: commands inside the workspace are auto too, except the ones in §5.
  For a project the owner would let Claude Code run freely in.

The mode is what the `session` tier was made for: the runtime resolves the
agent's session grants from the mode at run start, so a delegate never
inherits them.

## 4. Tools

All paths relative to the workspace; every result says the path it acted on.

- `developer.read` `{ path, from?, lines? }`: a file, bounded (2,000 lines,
  200 KB), with line numbers; binary files refused with the size.
- `developer.list` `{ path?, depth? }`: a tree, ignoring what `.gitignore`
  ignores and `node_modules` always.
- `developer.search` `{ query, glob?, regex? }`: ripgrep when present, a
  bounded fallback otherwise; results as `path:line: text`, 200 max.
- `developer.write` `{ path, content }` and `developer.edit`
  `{ path, old, new, all? }`: exact-string replacement, refused when `old`
  is absent or ambiguous. Creates parents. In `ask` mode both are gated
  with the diff on the card.
- `developer.run` `{ command, cwd?, timeoutSeconds? }`: one command in the
  workspace, no shell features beyond what the owner's shell gives, output
  bounded (200 KB, tail kept), exit code, elapsed. Gated in `ask` and
  `edit`; auto in `run` except §5.
- `developer.start` `{ name, command }`, `developer.output` `{ name, since? }`,
  `developer.stop` `{ name }`: long-lived processes (a dev server, a test
  watcher) owned by the agent, killed when the workspace changes, the agent
  is removed, or buddi stops. At most 4 per agent. Same gating as `run`.
- `developer.git` `{ action: status | diff | log | branch | commit | stash,
  … }`: read actions auto; `commit` and `branch` create are gated in `ask`,
  auto otherwise; `push`, `reset`, `checkout` of another branch and
  anything that rewrites history are not offered. The agent commits on a
  branch of its own (`buddi/<agent>/<task>`), never on the default branch.
- No network tool. Installs (`npm install`, `pip install`) are commands and
  are always gated, in every mode (§5).

## 5. Always gated, whatever the mode

A command that installs packages, reaches the network (`curl`, `wget`,
`npm publish`, `git push`), touches a path outside the workspace, runs with
elevated rights (`sudo`), or is a known destroyer (`rm -rf` of the
workspace root or above, `git reset --hard`, `git clean -fdx`). Detected by
a conservative parser over the command's words; a command the parser
cannot read is gated. The card says which rule matched.

## 6. The result the owner reviews

The unit of review is the diff, not the command. When the agent says it is
done, it calls `developer.summarise` (auto), which produces the branch, the
diff stat, the test command it ran and its last result, into a canvas
panel with "Open in editor" and the diff itself. Merging is the owner's,
outside buddi, or through a gated `developer.git merge` later.

## 7. Context

Every observation of a file or an output is untrusted text, the same rule
as web pages. A `README` that says "run this" is not an instruction. Old
outputs are compacted in the projection the way browser observations are,
keeping the last two whole.

## 8. Settings and pages

Settings → Developer: the workspaces list (agent, directory, mode, running
processes), a "Stop all processes" action, and the sentence "A developer
agent runs code you did not write, inside this directory, with the rights
of your user. Give it a workspace you would let a colleague use."

## 9. What it is not

Not a replacement for Claude Code on this repository. It is for the small
things inside buddi's own world: a plugin's tests, a script, a data fix,
where the assistant is already in the conversation. Not a sandbox: like
every plugin it runs as the owner's user, and the workspace boundary is a
rule the plugin enforces, not an operating-system one.

## 10. Acceptance

1. "Add a test for the stale-balance flag in the finance plugin and run
   it" in `edit` mode: the edits happen without a card, the test run
   produces one card, the summary shows the branch and the passing run.
2. A path outside the workspace is refused in every tool, including through
   a symlink.
3. `npm install` is gated in `run` mode; `rm -rf .` is gated with the rule
   named.
4. A dev server started with `developer.start` is stopped when buddi stops.
5. A delegate of the developer agent gets none of its tools.

## 11. Order of work

Workspace record, mode, the file and search tools with the boundary (one
day); `run`, processes, the gated-command parser, git (one day); summary
panel, Settings page, docs, reviews (one day). In the buddi-plugins
repository, since it is a plugin.

## 12. Preview: see the app from anywhere

A process started with `developer.start` that listens on a loopback port
gets a preview, two ways, both ending when the process stops:

- **Through buddi.** `https://<dashboard origin>/preview/<process>/…` is a
  reverse proxy from the gateway to that port, behind the dashboard's own
  sign-in (a session, or Tailscale), nothing more: a device that is signed
  in to the dashboard sees the app, anyone else gets the dashboard's 401.
  `developer.preview` (auto) returns the link. Websockets are proxied for
  hot reload. Apps that assume they live at the root of a host may break
  under a path prefix; the tool says so when the first response references
  absolute assets. Sharing a preview with someone who has no access is not
  in scope; if it is ever wanted it is a signed, expiring variant of the
  same link, a small addition.
- **A Tailscale route per port**, for those apps: when Tailscale is running
  and the owner allowed it on Settings → Developer, buddi adds
  `tailscale serve --https=<port> http://127.0.0.1:<port>` when the process
  starts and removes it when it stops, giving a clean `https://<host>:<port>`
  guarded by the tailnet alone. Off by default; the sentence on the page
  says what it exposes.

The canvas gets a **Preview** panel: the buddi-proxied app framed beside
the process output, "Open in a tab" for apps that refuse framing, and a
phone-width screenshot taken by the browser plugin on request, so the
transcript keeps a picture of what shipped.
