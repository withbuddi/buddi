/**
 * Finance, on its way out of the platform.
 *
 * The release ships platform plugins only (docs/onboarding.md §6): money is
 * one owner's domain, not something every installation should claim a
 * `finance.*` family for, and `scripts/release/build.mjs` no longer stages
 * `packages/tools/finance` at all. A static `import` would then break the
 * packaged gateway at startup — the module simply is not there — so the import
 * is attempted once, here, and its absence is an answer rather than a crash.
 *
 * In a checkout the workspace package resolves and the family registers
 * exactly as it always did, which is what keeps an owner whose agents already
 * grant `finance.*` working while the plugin becomes a plugin. In the tarball
 * it does not resolve, nothing is registered, and an agent file that asks for
 * `finance.*` is refused by the loader with the same sentence it uses for any
 * other tool no installed plugin provides.
 *
 * The import is literal, not computed: this is a deferred static import, not
 * the composition root loading code it was handed a path to (`load.ts` is the
 * one place that does that, and only core is forbidden it).
 */
import type { PluginManifest } from '@buddi/core';

async function resolve(): Promise<PluginManifest | undefined> {
  try {
    const module = (await import('@buddi/tool-finance')) as { manifest: PluginManifest };
    return module.manifest;
  } catch {
    return undefined;
  }
}

/** The finance manifest if this build has the package, `undefined` if not. */
export const optionalFinanceManifest: PluginManifest | undefined = await resolve();
