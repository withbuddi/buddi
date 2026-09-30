/*
 * buddi's version, said the way Chrome can read it.
 *
 * Chrome takes one to four dot-separated integers (each 0-65535) and nothing
 * else, so `0.1.0-pre.24` cannot be a manifest version. The mapping is the
 * shortest one that keeps pre-releases ordered:
 *
 *   0.1.0          -> 0.1.0
 *   0.1.0-pre.24   -> 0.1.0.24
 *   0.1.0-dev.abc  -> 0.1.0      (a local pack; `version_name` keeps the rest)
 *
 * `version_name` carries the full string whenever it differs, which is what
 * chrome://extensions shows beside the name.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** @param {string} version */
export function chromeVersion(version) {
  const match = SEMVER.exec(String(version).trim());
  if (!match) throw new Error(`Not a buddi version: ${JSON.stringify(version)}`);
  const [, major, minor, patch, pre] = match;
  const parts = [major, minor, patch];
  const numbered = pre ? /^pre\.(\d+)$/.exec(pre) : null;
  if (numbered) parts.push(numbered[1]);
  for (const part of parts) {
    if (Number(part) > 65535) throw new Error(`Chrome cannot carry ${version}: ${part} is above 65535.`);
  }
  return parts.map(Number).join('.');
}

/**
 * The manifest, stamped with a buddi version.
 * @param {Record<string, unknown>} manifest
 * @param {string} version
 */
export function stampManifest(manifest, version) {
  const stamped = { ...manifest, version: chromeVersion(version) };
  if (stamped.version !== version) stamped.version_name = version;
  else delete stamped.version_name;
  return stamped;
}
