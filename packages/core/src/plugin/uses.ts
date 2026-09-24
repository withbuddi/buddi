/**
 * What a plugin declares it reaches in buddi beyond itself: the areas of
 * `ctx.buddi` that are not always present (docs/specs/plugin-host-api.md §5).
 *
 * Declared twice, on purpose. The manifest's `uses` is what `ctx.buddi` is
 * built from; `package.json`'s `buddi.uses` is what the install card reads,
 * because the card is drawn before anything of the package has been imported.
 * The two are compared when the plugin loads and a plugin whose two lists
 * differ does not register.
 *
 * Pure: names, the owner's words for each, and the comparisons.
 */

/** Every area a plugin may declare. `files:library` is `files`, over the whole library. */
export const PLUGIN_USES = [
  'http',
  'accounts',
  'files',
  'files:library',
  'memory',
  'proposals',
  'schedule',
  'secrets',
] as const;

export type PluginUse = (typeof PLUGIN_USES)[number];

/**
 * The line the owner reads on the install card for each area, in the spec's
 * words. One plain line each, beside the tools, the schema, the timers and the
 * hosts.
 */
export const PLUGIN_USE_WORDS: Readonly<Record<PluginUse, string>> = {
  http: 'sends web requests',
  accounts: 'uses a model account you pick',
  files: 'keeps files in your Files library',
  'files:library': 'reads every file in your Files library',
  memory: 'reads and writes memory as the agent that calls it',
  proposals: 'proposes rules',
  schedule: 'starts agent runs by itself',
  secrets: 'fills secrets you bind to it',
};

export function isPluginUse(value: unknown): value is PluginUse {
  return typeof value === 'string' && (PLUGIN_USES as readonly string[]).includes(value);
}

/**
 * Read a declared list: the manifest's `uses` or `package.json`'s `buddi.uses`.
 *
 * Absent is the empty list — a plugin that reaches nothing beyond itself says
 * nothing. Anything else that is not an array of known names is refused with
 * the sentence that says which, and `where` names the list it came from.
 * Duplicates collapse; the order is `PLUGIN_USES`', so two lists that say the
 * same thing compare equal however they were written.
 */
export function parsePluginUses(
  value: unknown,
  where: string,
): { ok: true; uses: PluginUse[] } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, uses: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: `${where} is not a list of areas (expected e.g. ["http", "files"])` };
  }
  const unknown = value.filter((item) => !isPluginUse(item));
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `${where} names ${unknown.map((u) => JSON.stringify(u)).join(', ')}, which ` +
        `${unknown.length === 1 ? 'is not an area' : 'are not areas'} of this buddi; ` +
        `expected any of ${PLUGIN_USES.join(', ')}`,
    };
  }
  const given = new Set(value as PluginUse[]);
  return { ok: true, uses: PLUGIN_USES.filter((use) => given.has(use)) };
}

/** What an upgrade adds and drops, in `PLUGIN_USES` order. */
export function pluginUsesChange(
  before: readonly PluginUse[],
  after: readonly PluginUse[],
): { added: PluginUse[]; removed: PluginUse[] } {
  return {
    added: PLUGIN_USES.filter((use) => after.includes(use) && !before.includes(use)),
    removed: PLUGIN_USES.filter((use) => before.includes(use) && !after.includes(use)),
  };
}

/**
 * The sentence a plugin whose manifest and `package.json` disagree is refused
 * with, or undefined when they agree.
 */
export function pluginUsesMismatch(
  plugin: string,
  manifest: readonly PluginUse[],
  pkg: readonly PluginUse[],
): string | undefined {
  const { added, removed } = pluginUsesChange(pkg, manifest);
  if (added.length === 0 && removed.length === 0) return undefined;
  const list = (uses: readonly PluginUse[]): string => (uses.length === 0 ? 'nothing' : uses.join(', '));
  return (
    `plugin "${plugin}" declares that it uses ${list(manifest)} in its manifest, and ${list(pkg)} ` +
    `in package.json's buddi.uses; the install card was drawn from the second, so the two must match`
  );
}
