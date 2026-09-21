# @buddi/core

The contract a [buddi](https://github.com/amenophis1er/buddi) plugin is written
against. A plugin package exports a `PluginManifest` and depends on this package
as a **peer** dependency, so that the plugin and the installation it is loaded
into share one registry, one pool and one set of approvals.

```jsonc
{
  "name": "buddi-plugin-weather",
  "main": "dist/index.js",
  "peerDependencies": { "@buddi/core": "^0.1.0" },
  "keywords": ["buddi-plugin"],
  "buddi": { "manifest": "manifest", "core": "^0.1.0" }
}
```

Installing one is `buddi plugins install buddi-plugin-weather`. What that means,
what a plugin may contribute, and what it is trusted with — a plugin runs inside
buddi's process with everything buddi can do and is not sandboxed — is in
[docs/plugins.md](https://github.com/amenophis1er/buddi/blob/main/docs/plugins.md).

Core imports no plugin, ever. The dependency only points one way.

## Plugins

If you only have this package, this is the whole shape of what you are writing.
The guide is
[docs/plugins.md](https://github.com/amenophis1er/buddi/blob/main/docs/plugins.md);
its "Start here" chapter is ten minutes from nothing to a tool an agent can
call, and `buddi plugins init <name>` writes the scaffold.

1. A plugin is a package that exports a `PluginManifest`: a `name`, a `version`,
   one Postgres `schema` it owns, an absolute `migrationsDir`, and `tools`.
2. A tool declares a `tier`. `auto` runs inline. `gated` never does: the call
   becomes an immutable action and a pending approval, and `execute` runs later,
   once, from the executor — with `ctx.actionId` as its idempotency key.
3. A `gated` tool owes the owner a `describe(input, ctx)`: the complete effect
   `envelope` (what the ledger hashes) and a short plain-text `preview`. It is
   pure and read-only; it runs before any approval exists.
4. A manifest may also contribute `sources` (poll the world, originate runs),
   `sentinels` (deterministic watchers that return findings), `views` (how the
   dashboard draws your results), `home` blocks, and `missions`, `agents` and
   `skills` it *suggests* — installing a plugin schedules nothing and creates no
   agent.
5. `network` declares the hosts you reach and why. It is documentation, not a
   sandbox, and it is compared with the `buddi.md` you ship.
6. Migrations are numbered `*.sql`, applied in filename order with
   `search_path` set to your schema, tracked, and never re-run or rolled back.
7. Installing is two approvals with nothing imported before the first: your
   package is staged, hashed and read as text, and only an approved hash is
   imported. A plugin then runs inside buddi's process with everything buddi can
   do — it is not sandboxed.
8. Plugins are registered at process start. `buddi plugins dev <dir>` watches
   your build and restarts.
