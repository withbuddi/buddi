# For coding agents

Read `../buddi-planning/HANDBOOK.md` first: repositories, the two buddi
instances on this Mac, the dev loop, tests, reviews, releases and the
standing rules. Then `../buddi-planning/ROADMAP.md` for what is next.

## This repo
- Build and run on dev: `pnpm -r build && buddi-dev service restart` (127.0.0.1:4327).
- Before push: `pnpm check`. Full suite: `pnpm test`; DB suites: `pnpm test:db`.
- Every behaviour change: one line under Unreleased in `CHANGELOG.md`; `pnpm docs:cli` / `pnpm docs:api` when CLI or routes change.
- Releases are cut only when Amen says so: `pnpm release pre.N` (docs/release.md). Never tag by hand.
- `docs/` is reference only; plans and specs live in buddi-planning.
