# @buddi/core

The contract a [buddi](https://github.com/withbuddi/buddi) plugin is written
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
[docs/plugins.md](https://github.com/withbuddi/buddi/blob/main/docs/plugins.md).

Core imports no plugin, ever. The dependency only points one way.
