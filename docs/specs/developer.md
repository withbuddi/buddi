# The developer plugin: an agent that works in a workspace

Status: accepted, not started, 2026-09-21

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
- `run`: a short, pinned list of commands runs inside the workspace without a
  card — the project's own test, build and lint scripts, and the ordinary
  read-only tools (§5). Everything else still asks. For a project the owner
  would let Claude Code run freely in, and an owner who understands that the
  project's own scripts then run as them.

The mode is what the `session` tier was made for: the runtime resolves the
agent's session grants from the mode at run start, so a delegate never
inherits them.

## 4. Tools

All paths relative to the workspace; every result says the path it acted on.

- `developer.read` `{ path, from?, lines? }`: a file, bounded (2,000 lines,
  200 KB), with line numbers; binary files refused with the size.
- `developer.list` `{ path?, depth? }`: a tree, ignoring what `.gitignore`
  ignores and `node_modules` always.
- `developer.search` `{ query, path?, glob?, regex? }`: ripgrep when present
  (with `--no-follow --no-config`), a bounded fallback otherwise; results as
  `path:line: text`, 200 max.
- `developer.write` `{ path, content }` and `developer.edit`
  `{ path, old, new, all? }`: exact-string replacement, refused when `old`
  is absent or ambiguous. Creates parents. In `ask` mode both are gated
  with the diff on the card — and the card carries a hash of what the diff
  was computed against, so a file that moved while the owner was deciding is
  a refusal rather than a different change. `.git/` is never written;
  `.gitmodules` and `.gitattributes` are gated in every mode, because they
  decide what git itself runs.
- `developer.run` `{ command, cwd?, timeoutSeconds? }`: one command in the
  workspace. **There is no shell.** The command is split into words and
  spawned as a program and an argument vector, with an environment this
  plugin builds (`PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`,
  `SHELL`, `CI=1`) and nothing of buddi's own — no `DATABASE_URL`, no
  `BUDDI_*`, no key or token. Output bounded (200 KB over both streams
  together, tail kept), exit code, elapsed. Gated in `ask` and `edit`; in
  `run` mode, gated unless the command is on the list in §5.
- `developer.start` `{ name, command, port? }`, `developer.output`
  `{ name, since? }`, `developer.stop` `{ name }`: long-lived processes (a dev
  server, a test watcher) owned by the agent, killed when the workspace
  changes, the agent is removed, or buddi stops. At most 4 per agent. Same
  gating as `run`, spawned the same way. A row is identified by its pid *and*
  its start time, so a recycled pid after a reboot is a stale row rather than
  a signal sent to a stranger.
- `developer.git` `{ action: status | diff | log | branch | commit | stash,
  … }`: read actions auto; a branch create is gated in `ask` and auto
  otherwise; **`commit` is auto only in `run` mode** — `git add` runs a
  repository's own clean filters and `commit` its own hooks, and both are code
  in files an agent can write, so a commit is running code and belongs where
  running code is already what the mode means. `push`, `reset`, `checkout` of
  another branch and anything that rewrites history are not offered. Git runs
  with its own configuration disabled (`GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL=/dev/null`, an empty `core.hooksPath`, no pager, no
  signing program, no `core.sshCommand`, `--no-ext-diff`), from the absolute
  binary found on the workspace's PATH, and only when the workspace **is** the
  repository root — otherwise a pathspec or an `add --all` would reach the
  owner's unrelated work. Every pathspec is scoped to the workspace.
- `developer.preview` `{ name }`: names a running process for the canvas. It
  returns no URL: previews are served on a second origin with a credential of
  their own, and the dashboard's link route is what makes a link (§12).
- No network tool. Installs (`npm install`, `pip install`) are commands, and
  no installer is on the run list, so they are always gated (§5).

## 5. What runs without a card in `run` mode

**An allowlist, not a denylist.** The first version of this plugin gated a
list of dangerous spellings and let everything else through. Two adversarial
reviews executed the bypasses — `env curl …`, `cat $HOME/.ssh/id_ed25519`,
`echo x >>~/.zshenv`, `npx …`, `node -e …`, `find . -exec curl`,
`git -c foo=bar push` — and the lesson is not that the list was short. A
lexical denylist over a string that a shell is about to re-interpret cannot
establish that a program will not read outside the workspace or use the
network. So the question changed: not "is this one of the bad ones" but "is
this one of the few commands the owner meant".

A command runs with no card only when all three hold:

1. **It is plain.** Words and quotes, and no character a shell reads as more
   than text: no `$`, backtick, `~`, `|`, `;`, `&`, `<`, `>`, `(`, `)`, `{`,
   `}`, glob character or newline. Anything else is gated with the reason
   "not a plain command".
2. **Its program is on the run list**, with a subcommand the list allows:
   `node <file|--test>`; `npm|pnpm|yarn|bun run|test|build|lint|typecheck`
   (never `install`, `exec`, `dlx`, `npx`, `x`); `python|python3 -m` with
   `pytest|unittest|mypy|ruff|black`, and `pytest`; `go test|build|vet|fmt`;
   `cargo test|build|check|clippy|fmt`; `make <targets>` (no `VAR=`); `tsc`,
   `vitest`, `jest`, `eslint`, `prettier`, `ruff`, `black`, `mypy`; `ls`,
   `cat`, `head`, `tail`, `wc`, `grep`, `rg` (no `--pre`, no `--search-zip`),
   `find` (no `-exec`, `-execdir`, `-ok`, `-delete`, `-fprint*`), `diff`,
   `sort`, `uniq`, `echo`, `pwd`, `which`. A program named by path rather
   than by name is on no list.
3. **Every argument that looks like a path resolves inside the workspace** —
   not absolute, no `..`, no `~`, no symlink component.

Everything else asks, and the card names the program. The old parser survives
for one job only: putting a *name* on that card ("npm install installs
packages this machine did not have") rather than "it is not on the run list".
Nothing is allowed because that parser did not recognise it.

**What `run` mode therefore means.** `npm test` and `make` run a project's own
scripts, as the owner's user, with the owner's toolchain. The list bounds
which programs start; it says nothing about what a `package.json` does once
one of them is running. An owner choosing `run` is choosing to let this
project's own code run, which is exactly the choice they would make by typing
`npm test` themselves.

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

## 9. What it is not, and what is left over

Not a replacement for Claude Code on this repository. It is for the small
things inside buddi's own world: a plugin's tests, a script, a data fix,
where the assistant is already in the conversation.

**Not a sandbox.** Like every plugin it runs as the owner's user, and the
workspace boundary is a rule the plugin enforces, not an operating-system one.
Three residuals follow, and they are stated rather than implied:

- **A project's own scripts.** In `run` mode `npm test` starts, and what that
  script then does is the project's business, not this plugin's. The run list
  bounds which programs start and nothing after that.
- **Symlinks.** Path resolution walks component by component and refuses any
  symbolic link inside the workspace — a link is a way out whatever it points
  at today, and resolving it would only say where it pointed a moment ago. A
  workspace that genuinely contains links needs them replaced with the real
  files. The final open uses `O_NOFOLLOW` and writes go through a temp file
  and a `rename`, which closes the window between the check and the syscall;
  what is left is the ordinary race any unprivileged program has.
- **The owner's toolchain.** The PATH is captured once, from the owner's login
  shell, at the moment they approve the workspace, and shown on that card.
  Anything already on it is trusted the way the owner trusts it.

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

- **Through buddi.** The gateway serves `/preview/<plugin>/<process>/…` on a
  **second listener** of its own (the dashboard port plus one, or
  `BUDDI_PREVIEW_PORT`), never on the dashboard's origin: a page of somebody
  else's making does not get to run beside the dashboard's own session. The
  way in is `GET /api/preview/<plugin>/<name>/link` on the dashboard, which is
  session-gated and answers with a single-use five-minute ticket that sets a
  cookie on the preview origin. `developer.preview` (auto) therefore returns
  no URL at all — it names the process, and the canvas panel asks the link
  route for itself. The port it resolves to is checked against the process's
  own pid: a process that merely *prints* `http://localhost:5432` is not
  listening on it, and buddi's own ports and anything privileged are refused
  outright. Websockets are proxied for
  hot reload. Apps that assume they live at the root of a host may break
  under a path prefix; the tool says so when the first response references
  absolute assets. Sharing a preview with someone who has no access is not
  in scope; if it is ever wanted it is a signed, expiring variant of the
  same link, a small addition.
- **A Tailscale route per port**, for those apps: when Tailscale is running
  and the owner allowed it on Settings → Developer, buddi adds
  `tailscale serve --https=<port> http://127.0.0.1:<preview port>` when the
  process starts and removes it when it stops, giving a clean
  `https://<host>:<port>` guarded by the tailnet alone. It points at the
  preview listener, not at the app's own port: pointing it at the app would
  publish the app with no credential at all. Off by default; the sentence on the page
  says what it exposes.

The canvas gets a **Preview** panel: the buddi-proxied app framed beside
the process output, "Open in a tab" for apps that refuse framing, and a
phone-width screenshot taken by the browser plugin on request, so the
transcript keeps a picture of what shipped.
