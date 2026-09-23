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
agent's session grants from the *declared* tier at run start, so a delegate
never inherits them.

How the mode becomes a tier: every tool here declares `tier: 'session'` — the
strictest it will ever need, and what the grant is checked against — and
narrows each call with `ToolDefinition.tierFor` (docs/plugins.md §2.1). It is
called after the arguments are validated and before the tier is acted on, and
it reads the plugin's own workspace record for this agent:

- no workspace for this agent, or a path that resolves outside it: `gated`,
  with the reason naming the rule;
- `ask` gates every write and every command; `edit` gates every command and
  lets reads and writes through as `auto`;
- `run` lets a command through as `auto` **only when §5's allowlist admits
  it** — the program, its flags and its operands — and gates everything else,
  naming the program and the flag that decided.

The `reason` is one sentence and it is appended to the approval's preview, so
the card the owner reads says which rule matched (§5). The mode is read from
the record on every call, so changing it on the agent's page changes the next
call and not the run.

What `tierFor` does **not** do is widen anything. Every rule in it is a parser
over words a model chose, so the registry keeps the declared tier as the floor:
a declared-`session` tool is checked for a live owner request, an explicit
grant, an agent, a conversation and `delegationDepth` 0 on *every* call,
whatever the mode returned, before that answer is acted on at all. So a
delegate of a developer agent gets `session-not-authorized` from
`developer.run` even in `run` mode (§10, acceptance 5), a scheduled run with no
owner request gets the same, and a command the §5 parser misreads costs the
owner one unexpected card rather than an unapproved shell.

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
  gating as `run`, and spawned the same way down to the program: resolved to
  an absolute file on the workspace's captured PATH, argv, no shell. A row is
  identified by its pid *and* its start time, so a recycled pid after a reboot
  is a stale row rather than a signal sent to a stranger. A process name
  belongs to one agent at a time across the installation, because a preview is
  asked for by name alone.
- `developer.git` `{ action: status | diff | log | branch | commit | stash |
  init, … }`: read actions auto; `init` makes a workspace that is not yet a
  repository into one, is gated in every mode, and is refused inside an
  existing repository (a nested repository is the "somewhere above me"
  confusion the root check exists for); a branch create is gated in `ask` and auto
  otherwise, and creates with `switch -c … HEAD`, which moves a ref and
  leaves the working tree alone; **`commit` is auto only in `run` mode** —
  `git add` runs a repository's own clean filters and `commit` its own hooks,
  both of them code in files an agent can write. In `run` mode a commit
  therefore runs the repository's own filters, exactly as its scripts run its
  own code, and that is the same sentence §5 ends on. `stash` offers `push`
  and `list`; `pop` and `apply` are a merge, a merge runs the repository's own
  merge drivers, and so they are not offered. `push`, `reset`, `checkout` of
  another branch and anything that rewrites history are not offered either.
  Git runs with its own configuration disabled (`GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL=/dev/null`, an empty `core.hooksPath`, no pager, no
  signing program of any kind, no `core.sshCommand`, `--no-ext-diff`,
  `--no-textconv`, `--no-show-signature`), from the absolute binary found on
  the workspace's PATH, and only when the workspace **is** the repository root
  — otherwise a pathspec or an `add --all` would reach the owner's unrelated
  work. Every pathspec is scoped to the workspace.
- `developer.preview` `{ name }`: names a running process for the canvas. It
  returns no URL: previews are served on a second origin with a credential of
  their own, and the dashboard's link route is what makes a link (§12).
- No network tool. Installs (`npm install`, `pip install`) are commands, and
  no installer is on the run list, so they are always gated (§5).

## 5. What runs without a card in `run` mode

**An allowlist of programs *and their flags*, not a denylist.** Two earlier
shapes failed. The first gated a list of dangerous spellings and let the rest
through: reviews executed `env curl …`, `cat $HOME/.ssh/id_ed25519`,
`echo x >>~/.zshenv`, `npx …`, `node -e …`. The second allowed a list of
programs and asked of each argument "does this look like a path": verification
walked through it with `node --import=data:text/javascript,…`, `make -C /tmp`,
`grep -f /etc/passwd`, `sort -o /tmp/out`, `find -files0-from`, `rg -L`,
`grep -R`, `find -L`. Every one is a listed program reading or writing
somewhere it should not, through a flag nobody had enumerated. "Which program"
is not the question. "Which program, with which flags" is.

A command runs with no card only when all of this holds:

1. **It is plain.** Words and quotes, and no character a shell reads as more
   than text: no `$`, backtick, `~`, `|`, `;`, `&`, `<`, `>`, `(`, `)`, `{`,
   `}`, `[`, `]`, newline or backslash. (`*` and `?` are text here, because
   nothing expands them: there is no shell, and a glob reaches the program as
   the characters it is.) Anything else is gated with "not a plain command".
2. **Its program is on the run list**, and every flag it is given is in that
   program's own grammar, and its operands are of the kind that program takes.
   A flag that is not in the table is gated **by name**, and `--flag=value`,
   `--flag value`, `-fvalue`, `-f=value` and `-abc` are all read as the flags
   they are, so a spelling is not a way past the table. A flag's value has to
   *be* what the table says it is: a `<word>` carries no path separator at
   all; a `<glob>` may carry one — it filters what is already being searched
   and cannot add a root — but may not climb with `..` or begin with `/`; a
   `<n>` is digits; a `<re>` is a pattern and is never resolved as a path. An
   operand that begins with a dash is refused even after `--`, because `--`
   stops *this* parser reading it as a flag and says nothing about the
   program.
3. **Every path — operand or flag value — resolves inside the workspace**: not
   absolute, no `..`, no `~`, no symlink component, and resolved against **the
   directory the command will run in** (`cwd`, itself resolved inside the
   workspace) rather than the workspace root, since that is what the program
   will read it against.

The list, exactly as the code has it — and it is stricter than a summary of it
would be, so it is written out per program:

| Program | Subcommand | Flags | Operands |
| --- | --- | --- | --- |
| `node` | — | `--test` | files; at least one, unless `--test` |
| `npm` `pnpm` `yarn` `bun` | one of `run test build lint typecheck`, required | none at all | at most one script name (`[a-z0-9:_.-]+`) |
| `python` `python3` | — | `-m <word>`, and it must be the **first** word | the module, one of `pytest unittest mypy ruff black`; everything after it is read by that module's own row |
| `pytest` | — | `-q -x -v -k <word> --maxfail=<n> -p <word>` | paths |
| `unittest` | — | none | bare words |
| `go` | one of `test build vet fmt`, required | `-v -run <re>` | `./...`, `pkg/...` or paths |
| `cargo` | one of `test build check clippy fmt`, required | `-v --release -run <re>` | bare words |
| `make` | — | none at all | bare targets (`[A-Za-z0-9:_.-]+`; no `VAR=`) |
| `tsc` | — | `-p <path> --project <path> --noEmit` | paths |
| `vitest` `jest` | optional `run` | `-t <word>` | paths |
| `eslint` | — | `--fix` | paths |
| `prettier` | — | `--check --write` | paths |
| `ruff` | optional `check` or `format` | `--check --fix` | paths |
| `black` `mypy` | — | `--check` | paths |
| `ls` | — | `-l -a` | paths |
| `cat` | — | none | paths |
| `head` `tail` | — | `-n <n> -c <n>` | paths |
| `wc` | — | `-l -c -w` | paths |
| `grep` | — | `-n -i -r -E -F -w -c -l --include=<glob>` | a pattern, then paths |
| `rg` | — | `-n -i -w -l -c -g <glob> -t <word> --no-follow` | a pattern, then paths |
| `find` | — | an expression: `-name <glob> -iname <glob> -type <word> -maxdepth <n> -mindepth <n> -path <glob> -newer <path> -size <word> -not -o -a` | a path |
| `diff` | — | `-u -r` | paths |
| `sort` | — | `-n -r -u` | paths |
| `uniq` | — | `-c` | paths |
| `echo` | — | none | any words |
| `pwd` | — | none | none |
| `which` | — | none | one bare word |

Everything else asks, and the card names the program. The old parser survives
for one job: putting a *name* on that card ("npm install installs packages
this machine did not have") rather than "npm install is not on the run list".
Nothing is allowed because that parser did not recognise it.

**What `run` mode therefore means.** `npm test` and `make` run a project's own
scripts, as the owner's user, with the owner's toolchain, and in `run` mode a
commit runs the repository's own clean filters for the same reason. The list
bounds which program starts and with what; it says nothing about what a
`package.json` does once one of them is running. An owner choosing `run` is
choosing to let this project's own code run, which is exactly the choice they
make by typing `npm test` themselves.

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
- **Symlinks, and the window after the check.** Path resolution walks
  component by component and refuses any symbolic link inside the workspace —
  a link is a way out whatever it points at today, and resolving it would only
  say where it pointed a moment ago. A workspace that genuinely contains links
  needs them replaced with the real files. The final open uses `O_NOFOLLOW`;
  after it, the components are walked again and the open descriptor's
  `(dev, ino)` is compared with the path that was validated, so a directory
  swapped for a link in between is a refusal rather than a read of somebody
  else's file. Writes go to a temp file in the same directory and are
  `rename`d over, which never follows a link at the destination. What is left
  is the window between that confirmation and the read or write on the
  descriptor: it cannot be closed from user space without holding every
  directory open for the whole operation, and it is the ordinary race any
  unprivileged program has.
- **The preview's check and the proxy's connect.** A preview port is verified
  against the process's own pid — its identity being the pair (pid, start
  time) — on every proxied request. Between that answer and the gateway's
  connect, the process could in principle exit and the port be taken by
  another. The window is microseconds and the alternative is holding the
  socket open across the check, which the proxy is not shaped to do.
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

  As built (docs/plugins.md §2.5c): the plugin declares
  `previews: { resolve(name, ctx) }`, which answers with the port behind a
  process name or `null`, asked on every request — and it must be a port the
  plugin is really running that process on, since the gateway only refuses the
  obviously wrong ones (privileged, 5432, its own two listeners). The way in is
  an exchange, not the dashboard's cookie:
  `GET /api/preview/developer/<name>/link` on the dashboard, behind the
  dashboard's gate, answers `{ url }` with a single-use five-minute ticket on
  it; opening that URL sets `buddi_preview` (HttpOnly, SameSite=Lax, scoped to
  that one preview, 24 hours) and redirects to the clean path; every later
  request and every upgrade needs that cookie, and anything else is a bodyless
  401. `GET /api/preview/developer/<name>/check` answers
  `{ ok, absoluteAssets }` from what the proxy saw on the first HTML response,
  which is where `developer.preview`'s warning comes from. The canvas panel is
  the `preview` renderer (docs/plugins.md §2.5): `{ src, title?, output? }`,
  where `src` names the process as `/preview/developer/<name>/`; the panel
  calls `link` itself and frames the answer, cross-origin, with "Open in a tab"
  for an app that refuses framing.

- **A Tailscale route per port**, for those apps: when Tailscale is running
  and the owner allowed it on Settings → Developer, the plugin adds
  `tailscale serve --https=<port> http://127.0.0.1:<previewPort>` when the
  process starts and removes it when it stops, giving a clean
  `https://<host>:<port>` guarded by the tailnet alone. `<previewPort>` is
  `ctx.previewPort` (or `BUDDI_PREVIEW_PORT`), never "the dashboard plus one":
  the gateway steps along when that port is taken, and a route built on the
  guess points at nothing. It is the plugin's to
  add and to take away — the gateway publishes only the dashboard — and it is
  off by default; the sentence on the page says what it exposes.

The canvas gets a **Preview** panel: the buddi-proxied app framed beside
the process output, "Open in a tab" for apps that refuse framing, and a
phone-width screenshot taken by the browser plugin on request, so the
transcript keeps a picture of what shipped.
