/**
 * Where a buddi release came from, read off the provenance npm serves for it.
 *
 * `npm publish --provenance` in the release workflow attaches a sigstore bundle
 * to every version: a DSSE envelope holding an in-toto SLSA statement (which
 * tarball, built from which repository and workflow), signed with a short-lived
 * Fulcio certificate whose subject is the GitHub Actions workflow that ran. The
 * registry serves the bundles at `/-/npm/v1/attestations/<name>@<version>`.
 *
 * The npm that ships with Node 22 (10.x) verifies those bundles during
 * `npm audit signatures`, but its `--json` answer is only `{ invalid, missing }`:
 * it says nothing about *who* signed. So this module is the identity check,
 * and it stands on its own:
 *
 *  - the certificate chains to the Fulcio CA pinned below (sigstore's public
 *    good instance, valid to 2031), and was valid when the transparency log
 *    recorded the signature;
 *  - the envelope's signature verifies under that certificate's key;
 *  - the statement's subject is this package at this version, with the sha512
 *    the registry names as the tarball's integrity;
 *  - the certificate was issued to `withbuddi/buddi`'s `release.yml`, run for
 *    the tag of this version, and the statement names the same repository.
 *
 * What it does not do is check the Rekor inclusion proof; buddi.app's upgrade
 * also runs `npm audit signatures`, whose sigstore client does.
 *
 * Only `node:` imports and erasable TypeScript, on purpose: the Mac app's
 * payload script runs this file directly (`node --experimental-strip-types
 * provenance.ts <version> <integrity> <attestations.json>`) before the release
 * is baked into the signed DMG, so CI and the installed app make the same
 * check. Nothing here touches the network: the document is handed in.
 */
import { X509Certificate, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The workflow a release must have been built by, as Fulcio names it. */
export const RELEASE_WORKFLOW = 'https://github.com/withbuddi/buddi/.github/workflows/release.yml';
export const RELEASE_REPOSITORY = 'https://github.com/withbuddi/buddi';
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';

/**
 * Fulcio's intermediate and root (sigstore.dev), as sigstore's trusted root
 * lists them; both expire 2031-10-05. A newer CA would arrive with a newer
 * buddi, which is how a change here would ship.
 */
export const FULCIO_CHAIN: readonly string[] = [
  `-----BEGIN CERTIFICATE-----
MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0C
AQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV7
7LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS
0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYB
BQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjp
KFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZI
zj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJR
nZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsP
mygUY7Ii2zbdCdliiow=
-----END CERTIFICATE-----`,
  `-----BEGIN CERTIFICATE-----
MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMw
KjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0y
MTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3Jl
LmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7
XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxex
X69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92j
YzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRY
wB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQ
KsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCM
WP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9
TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ
-----END CERTIFICATE-----`,
];

/** `<registry>/-/npm/v1/attestations/@withbuddi%2Fbuddi@<version>`. */
export function attestationsUrl(registry: string, name: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/-/npm/v1/attestations/${name.replace('/', '%2F')}@${version}`;
}

export interface ProvenanceOptions {
  name: string;
  version: string;
  /** The registry's `dist.integrity` for that version: `sha512-<base64>`. */
  integrity: string;
  /** PEM certificates to chain to, intermediates first; Fulcio's by default. Tests bring their own CA. */
  chain?: readonly string[];
  workflow?: string;
  repository?: string;
}

/** What a verified provenance says. */
export interface Provenance {
  repository: string;
  /** The certificate's subject: `<workflow>@refs/tags/v<version>`. */
  workflow: string;
}

interface Bundle {
  verificationMaterial?: {
    certificate?: { rawBytes?: string };
    x509CertificateChain?: { certificates?: Array<{ rawBytes?: string }> };
    tlogEntries?: Array<{ integratedTime?: string | number }>;
  };
  dsseEnvelope?: { payload?: string; payloadType?: string; signatures?: Array<{ sig?: string }> };
}

interface Statement {
  _type?: string;
  subject?: Array<{ name?: string; digest?: { sha512?: string } }>;
  predicateType?: string;
  predicate?: { buildDefinition?: { externalParameters?: { workflow?: { repository?: unknown; path?: unknown; ref?: unknown } } } };
}

/** The purl npm puts in the statement's subject: `pkg:npm/%40scope/name@version`. */
function purl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

/** DSSE's pre-authentication encoding: what the signature is over. */
function pae(payloadType: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${body.length} `), body]);
}

/** Does `leaf` chain to a self-signed certificate in `pool`? */
function chains(leaf: X509Certificate, pool: X509Certificate[]): boolean {
  let cert = leaf;
  for (let depth = 0; depth < 5; depth++) {
    const issuer = pool.find(candidate => cert.checkIssued(candidate) && cert.verify(candidate.publicKey));
    if (issuer === undefined) return false;
    if (issuer.checkIssued(issuer) && issuer.verify(issuer.publicKey)) return true;
    cert = issuer;
  }
  return false;
}

/**
 * Verify the attestations document npm serves for one version. Throws with
 * the reason, in a clause that reads after "its provenance did not check out:".
 */
export function verifyProvenance(doc: unknown, opts: ProvenanceOptions): Provenance {
  const workflow = opts.workflow ?? RELEASE_WORKFLOW;
  const repository = opts.repository ?? RELEASE_REPOSITORY;
  const list = (doc as { attestations?: Array<{ predicateType?: string; bundle?: Bundle }> } | null)?.attestations;
  const slsa = Array.isArray(list) ? list.find(a => a?.predicateType?.startsWith('https://slsa.dev/provenance/') === true) : undefined;
  if (slsa?.bundle === undefined) throw new Error('the registry has no SLSA provenance for it');
  const { verificationMaterial: material, dsseEnvelope: envelope } = slsa.bundle;

  const raw = material?.certificate?.rawBytes ?? material?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (typeof raw !== 'string') throw new Error('the provenance carries no signing certificate');
  let leaf: X509Certificate;
  try { leaf = new X509Certificate(Buffer.from(raw, 'base64')); }
  catch { throw new Error('the signing certificate does not parse'); }
  const pool = (opts.chain ?? FULCIO_CHAIN).map(pem => new X509Certificate(pem));
  if (!chains(leaf, pool)) throw new Error('the signing certificate was not issued by sigstore\'s certificate authority');

  // Fulcio certificates live ten minutes; the log's timestamp says the signature fell inside them.
  const logged = Number(material?.tlogEntries?.[0]?.integratedTime);
  if (!Number.isFinite(logged) || logged <= 0) throw new Error('the provenance has no transparency-log time');
  const at = logged * 1000;
  if (at < Date.parse(leaf.validFrom) || at > Date.parse(leaf.validTo)) throw new Error('it was signed outside its certificate\'s lifetime');

  const payload = envelope?.payload, payloadType = envelope?.payloadType, sig = envelope?.signatures?.[0]?.sig;
  if (typeof payload !== 'string' || typeof payloadType !== 'string' || typeof sig !== 'string') throw new Error('the provenance envelope is incomplete');
  if (payloadType !== 'application/vnd.in-toto+json') throw new Error(`the provenance is a ${payloadType}, not an in-toto statement`);
  const body = Buffer.from(payload, 'base64');
  let signed = false;
  try { signed = verify('sha256', pae(payloadType, body), leaf.publicKey, Buffer.from(sig, 'base64')); }
  catch { signed = false; }
  if (!signed) throw new Error('its signature does not verify');

  let statement: Statement;
  try { statement = JSON.parse(body.toString('utf8')) as Statement; }
  catch { throw new Error('the statement is not JSON'); }
  if (!opts.integrity.startsWith('sha512-')) throw new Error('the registry names no sha512 for the tarball');
  const digest = Buffer.from(opts.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const subject = (statement.subject ?? []).find(s => s?.name === purl(opts.name, opts.version));
  if (subject === undefined) throw new Error(`the statement is not about ${opts.name}@${opts.version}`);
  if (subject.digest?.sha512?.toLowerCase() !== digest) throw new Error('the statement names a different tarball than the registry serves');

  // Fulcio puts the workflow, at the ref it ran for, in the certificate's URI.
  const uris = (leaf.subjectAltName ?? '').split(/,\s*/).filter(n => n.startsWith('URI:')).map(n => n.slice(4));
  const expected = `${workflow}@refs/tags/v${opts.version}`;
  if (!uris.includes(expected)) throw new Error(`it was signed by ${uris[0] ?? 'an unnamed identity'}, not ${expected}`);

  const named = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const source = typeof named?.repository === 'string' ? named.repository.replace(/\.git$/, '') : undefined;
  if (source?.toLowerCase() !== repository.toLowerCase()) throw new Error(`the statement names ${source ?? 'no repository'}, not ${repository}`);
  if (named?.path !== RELEASE_WORKFLOW_PATH && workflow === RELEASE_WORKFLOW) throw new Error(`the statement names the workflow ${String(named?.path)}, not ${RELEASE_WORKFLOW_PATH}`);
  return { repository: source, workflow: expected };
}

/*
 * `node --experimental-strip-types provenance.ts <version> <sha512-integrity> <attestations.json>`
 * (apps/mac/scripts/fetch-payload.sh, which downloads the document from
 * `attestationsUrl`): exit 0 and one line, or exit 1 and why. No network here.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, integrity, file] = process.argv.slice(2);
  const name = '@withbuddi/buddi';
  try {
    if (version === undefined || integrity === undefined || file === undefined) throw new Error('usage: provenance.ts <version> <sha512-integrity> <attestations.json>');
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`${file} is not the registry's attestations document`); }
    const facts = verifyProvenance(doc, { name, version, integrity });
    console.log(`${name}@${version}: provenance verified (${facts.workflow})`);
  } catch (err) {
    console.error(`provenance: ${name}@${version ?? '?'}: its provenance did not check out: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
