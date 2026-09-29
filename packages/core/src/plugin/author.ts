/**
 * Who made a plugin: the manifest's `author`, and the `author` of its
 * package.json, which is what the install card can read before anything is
 * imported.
 *
 * Pure: no state and no I/O, so it can sit on `@buddi/core/plugin`.
 */

/** Who made this plugin, as the install card and the Plugins page show it. */
export interface PluginAuthor {
  /** A person or an organisation, at most 80 characters. */
  name: string;
  /** Where to read about them: an `https:` URL. */
  url?: string;
}

/** The longest name the card will show. */
export const AUTHOR_NAME_MAX = 80;

export type ParsedAuthor = { ok: true; author: PluginAuthor | undefined } | { ok: false; message: string };

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The manifest's `author`, checked: absent is fine; present, it is a name of
 * 1–80 characters and, optionally, an `https:` URL. `where` names it in the
 * sentence a refusal is.
 */
export function parsePluginAuthor(value: unknown, where: string): ParsedAuthor {
  if (value === undefined) return { ok: true, author: undefined };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: `${where} is not { name, url? }` };
  }
  const { name, url, ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) return { ok: false, message: `${where} has ${extra.join(', ')}, which is not name or url` };
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, message: `${where}.name is not a name` };
  if (name.trim().length > AUTHOR_NAME_MAX) {
    return { ok: false, message: `${where}.name is longer than ${AUTHOR_NAME_MAX} characters` };
  }
  if (url !== undefined && (typeof url !== 'string' || !httpsUrl(url))) {
    return { ok: false, message: `${where}.url is not an https URL` };
  }
  return { ok: true, author: { name: name.trim(), ...(url === undefined ? {} : { url }) } };
}

/**
 * package.json's `author`, read leniently — npm allows `"Name <email> (url)"`
 * or `{ name, email?, url? }`. What cannot be shown is dropped rather than
 * refused: an email is never shown, a URL that is not `https:` is left out, and
 * a name that is empty or too long means no author.
 */
export function authorOfPackageJson(value: unknown): PluginAuthor | undefined {
  let name: unknown;
  let url: unknown;
  if (typeof value === 'string') {
    const match = /^([^<(]*)(?:<[^>]*>)?\s*(?:\(([^)]*)\))?/.exec(value);
    name = match?.[1];
    url = match?.[2]?.trim();
  } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    ({ name, url } = value as Record<string, unknown>);
  }
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > AUTHOR_NAME_MAX) return undefined;
  return { name: trimmed, ...(typeof url === 'string' && httpsUrl(url) ? { url } : {}) };
}

/**
 * The one sentence refusing a manifest and a package.json that name different
 * authors, or undefined when they agree or either is silent.
 */
export function pluginAuthorMismatch(
  plugin: string,
  manifest: PluginAuthor | undefined,
  pkg: PluginAuthor | undefined,
): string | undefined {
  if (manifest === undefined || pkg === undefined || manifest.name === pkg.name) return undefined;
  return (
    `plugin "${plugin}" says its author is "${manifest.name}" in its manifest and "${pkg.name}" in ` +
    "package.json; the install card was drawn from the second, so the two must match"
  );
}
