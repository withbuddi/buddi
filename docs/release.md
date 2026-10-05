---
title: Releasing buddi
status: reference
updated: 2026-10-05
---

# Releasing buddi

Release flow v2: you ask for a release by pushing a release commit to main;
CI tags it once the full gate is green, then publishes from the tag. Nobody
pushes or moves a tag by hand.

## What you type

```sh
pnpm review                 # optional: the release review (README → Reviewing a release)
pnpm release pre.44 --dry-run
pnpm release pre.44         # or 0.1.0-pre.44
```

`pnpm release` checks the tree is clean, on main and level with origin, that
`v0.1.0-pre.44` does not exist and `v0.1.0-pre.43` does, and that
`CHANGELOG.md` has Unreleased lines. Then it stamps new routes into
`API_SINCE`, moves the Unreleased lines under `## 0.1.0-pre.44 — <date>`,
refreshes `docs/api.md` and `docs/cli.md`, writes `release/REQUEST.json`,
commits all of it as `Release 0.1.0-pre.44`, pushes main (no tag) and prints
the workflow run to watch. `--dry-run` reports the same and writes nothing.

If the push is refused (main moved), the commit is only local: `git reset
--hard <the commit it names>`, pull, and run `pnpm release pre.44` again.

## What CI does

Two runs of `.github/workflows/release.yml`:

1. **The push to main.** The `plan` job (`scripts/release/plan.mjs`) decides
   whether this push releases anything (the rule below). If not, the run ends
   with a notice. If so, it runs the full gate (`gate.yml`), and on green the
   `tag` job tags the pushed commit `v0.1.0-pre.44` and starts run 2.
2. **The publish run**, a workflow dispatch on the tag with `publish: true`.
   It checks that the tag carries a request for that version and that
   `package.json` agrees, then: publish to npm with provenance, the GitHub
   release (notes from the version's CHANGELOG section), the withbuddi.com
   rebuild, then `mac-check` and `mac-app` (buddi.app, DMG, Sparkle feed).

Publishing runs on the tag rather than in run 1 because npm's provenance names
the ref the workflow ran for, and installers and buddi.app accept only
`release.yml@refs/tags/v<version>` (`packages/install/src/provenance.ts`).
A tag pushed with the workflow's own token starts no workflow; a dispatch does.

`ci.yml` gates every other push to main. On a push that `release.yml` will
tag, `ci.yml` skips its gate so the same commit is not tested twice; its
changelog check still runs.

## The rule (plan.mjs)

A push tags a release when all of these hold:

- **The marker.** The commit that last changed `release/REQUEST.json` has the
  subject exactly `Release <version>`, for the version the file names. Both are
  required: a commit message alone (anyone can type one) or a hand edit of the
  file starts nothing. A file changed by any other commit fails the run.
- **Recent.** That commit is HEAD or one of its last 50 first-parent commits.
  Commits on top of it are fine: the tag goes on HEAD, so fixes pushed after
  the release commit are in the release.
- **Untagged.** `v<version>` does not exist on origin. Once it does, every
  later push is "nothing to release".
- **The right version.** The version's core is the root `package.json`'s
  version (`0.1.0` for `0.1.0-pre.N`); otherwise the run fails.

`release/REQUEST.json` (`{ "version", "from" }`, `from` being the commit the
release was cut from, for the record) stays in the tree: each release commit
overwrites it, and a tagged version makes it inert. CI never writes to main.

Pushes to main queue in `release.yml` (one at a time; a newer push replaces
one still waiting), so two runs never race for the tag; the `tag` job also
refuses if the tag appeared while the gate ran.

## A red gate

Nothing is tagged and nothing is published. Fix it and push to main: the next
push whose gate is green tags the release at that push's commit, fix
included. A flaky failure needs no commit: re-run the failed jobs of that run,
and `tag` follows a green gate.

Fixes pushed on top of the release commit should not add Unreleased lines for
this release: `CHANGELOG.md` already has its section. Edit that section if the
fix changes what it says.

A release whose gate never goes green stays requested: each push to main runs
the release gate instead of the ordinary one, until the release is tagged or
falls more than 50 commits behind HEAD. Then it is stale (a warning on each
push, never a tag). To release it after all, push a fresh commit with the
subject `Release 0.1.0-pre.N` that rewrites `release/REQUEST.json` with the
same version (`pnpm release` would refuse, since Unreleased is already empty).

## Running parts again

Actions → release → Run workflow:

- **Mac app only** (the npm release is out): `version` = `0.1.0-pre.44`,
  `publish` off, from any branch.
- **Publish again** (the tag exists but the publish run failed, or was never
  started): use workflow from the tag `v0.1.0-pre.44`, `version` =
  `0.1.0-pre.44`, `publish` on. A version already on npm fails at the publish
  step; npm never takes a version twice.
