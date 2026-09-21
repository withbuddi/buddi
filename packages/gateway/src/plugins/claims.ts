/**
 * `buddi.md`: what the package says about itself, before anything is imported.
 *
 * At staging time a manifest cannot be read — reading it means importing the
 * plugin, which is the thing the owner has not approved yet. So the package
 * ships prose, and the prose is what the approval screen shows, labelled as
 * the package's *claim* rather than as a fact.
 *
 * The comparison afterwards is the point. Once the entry point has been
 * imported the manifest is known, and a package whose prose said "reads your
 * ledger" while its manifest claims the `email` schema and two hosts nobody
 * mentioned is not refused automatically — it is *shown*, as drift, and needs a
 * second approval. Prose and code disagreeing is not proof of malice, but it is
 * exactly the moment an owner should look.
 *
 * Parsing is deliberately dumb: two optional labelled lines, and otherwise the
 * whole text is the claim. A plugin author should not have to learn a format to
 * be honest, and a format nobody follows would produce drift on every install
 * and train the owner to acknowledge it without reading.
 */

export interface PluginClaims {
  /** From a `Schema:` line, when there is one. */
  schema?: string;
  /** From a `Hosts:` line, comma or space separated. */
  hosts: string[];
  /** The whole file, trimmed. Shown verbatim; it is the package's own words. */
  text: string;
  /** True when the package ships no `buddi.md` at all. */
  missing: boolean;
}

function labelled(text: string, label: string): string | undefined {
  const match = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im').exec(text);
  return match?.[1]?.trim();
}

/** Split `a.com, b.com` or `a.com b.com`, dropping backticks and trailing stops. */
export function splitHosts(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((host) => host.replace(/[`'"]/g, '').replace(/[.,;]+$/, '').trim())
    .filter((host) => host !== '' && host.toLowerCase() !== 'none');
}

export function parseBuddiMd(text: string | undefined): PluginClaims {
  if (text === undefined) return { hosts: [], text: '', missing: true };
  const trimmed = text.trim();
  const schema = labelled(trimmed, 'Schema');
  const hosts = labelled(trimmed, 'Hosts');
  return {
    ...(schema === undefined || schema === '' ? {} : { schema: splitHosts(schema)[0] ?? schema }),
    hosts: hosts === undefined ? [] : splitHosts(hosts),
    text: trimmed,
    missing: trimmed === '',
  };
}

/**
 * Where the prose and the manifest disagree, one sentence each.
 *
 * Only what the prose *stated* is compared. A `buddi.md` with no `Hosts:` line
 * claimed nothing about hosts, and inventing a disagreement out of silence
 * would make the drift list noise. Silence about a schema when the manifest
 * owns one is worth a line, because the schema is the plugin's half of the
 * owner's database.
 */
export function driftBetween(
  claims: PluginClaims,
  manifest: { schema: string; network?: ReadonlyArray<{ host: string }> },
): string[] {
  const drift: string[] = [];
  if (claims.missing) {
    drift.push('it ships no buddi.md, so it stated nothing in advance about what it does');
  }
  const schema = manifest.schema.trim();
  if (claims.schema !== undefined && schema !== '' && claims.schema !== schema) {
    drift.push(`its buddi.md claims the schema "${claims.schema}"; its manifest owns "${schema}"`);
  }
  if (claims.schema === undefined && schema !== '' && !claims.missing) {
    drift.push(`its buddi.md names no schema; its manifest owns the Postgres schema "${schema}"`);
  }
  const declared = (manifest.network ?? []).map((n) => n.host);
  const undeclared = declared.filter((host) => !claims.hosts.includes(host));
  if (undeclared.length > 0 && !claims.missing) {
    drift.push(
      `its manifest declares the host${undeclared.length === 1 ? '' : 's'} ${undeclared.join(', ')}, ` +
        `which its buddi.md does not mention`,
    );
  }
  const unused = claims.hosts.filter((host) => !declared.includes(host));
  if (unused.length > 0) {
    drift.push(
      `its buddi.md mentions ${unused.join(', ')}, which its manifest does not declare as network use`,
    );
  }
  return drift;
}
