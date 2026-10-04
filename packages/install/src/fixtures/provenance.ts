/**
 * Provenance documents for tests: the shape npm serves, signed by a throwaway
 * CA made with the `openssl` command line, so every check in `provenance.ts`
 * can be exercised for any version. The real document for 0.1.0-pre.38, signed
 * by Fulcio, sits beside this file and is checked against the pinned chain.
 */
import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW, RELEASE_WORKFLOW_PATH } from '../provenance.js';

interface Ca { dir: string; root: string }
let ca: Ca | undefined;

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

function testCa(): Ca {
  if (ca !== undefined) return ca;
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-test-ca-'));
  writeFileSync(path.join(dir, 'root.cnf'), [
    '[req]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = ca', '[dn]', 'O = buddi-test', 'CN = test-root',
    '[ca]', 'basicConstraints = critical,CA:true', 'keyUsage = critical,keyCertSign,cRLSign', 'subjectKeyIdentifier = hash',
  ].join('\n'));
  openssl(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
  openssl(dir, ['req', '-x509', '-new', '-key', 'root.key', '-config', 'root.cnf', '-days', '3650', '-out', 'root.pem']);
  ca = { dir, root: readFileSync(path.join(dir, 'root.pem'), 'utf8') };
  return ca;
}

/** A leaf certificate for `san`, issued by the test CA; its key in PEM. */
function leaf(san: string): { der: Buffer; key: string } {
  const { dir } = testCa();
  const name = `leaf-${Math.random().toString(36).slice(2)}`;
  writeFileSync(path.join(dir, `${name}.ext`), ['[ext]', 'basicConstraints = critical,CA:false', 'keyUsage = critical,digitalSignature', `subjectAltName = URI:${san}`].join('\n'));
  openssl(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
  openssl(dir, ['req', '-new', '-key', `${name}.key`, '-subj', '/O=buddi-test', '-out', `${name}.csr`]);
  openssl(dir, ['x509', '-req', '-in', `${name}.csr`, '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '1',
    '-extfile', `${name}.ext`, '-extensions', 'ext', '-outform', 'DER', '-out', `${name}.der`]);
  return { der: readFileSync(path.join(dir, `${name}.der`)), key: readFileSync(path.join(dir, `${name}.key`), 'utf8') };
}

export interface FixtureOptions {
  name?: string;
  version: string;
  integrity: string;
  /** The certificate's URI; the release workflow at the version's tag by default. */
  san?: string;
  repository?: string;
  /** Sign a different payload than the one carried: a tampered statement. */
  tamper?: boolean;
}

/** `{ doc, chain }`: the attestations document and the chain that verifies it. */
export function provenanceFixture(opts: FixtureOptions): { doc: unknown; chain: string[] } {
  const name = opts.name ?? '@withbuddi/buddi';
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/${name.replace(/^@/, '%40')}@${opts.version}`, digest: { sha512: Buffer.from(opts.integrity.replace(/^sha512-/, ''), 'base64').toString('hex') } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: { buildDefinition: { externalParameters: { workflow: { ref: `refs/tags/v${opts.version}`, repository: opts.repository ?? RELEASE_REPOSITORY, path: RELEASE_WORKFLOW_PATH } } } },
  };
  const cert = leaf(opts.san ?? `${RELEASE_WORKFLOW}@refs/tags/v${opts.version}`);
  const payloadType = 'application/vnd.in-toto+json';
  const body = Buffer.from(JSON.stringify(statement));
  const signedBody = opts.tamper === true ? Buffer.from(JSON.stringify({ ...statement, subject: [] })) : body;
  const pae = Buffer.concat([Buffer.from(`DSSEv1 ${payloadType.length} ${payloadType} ${signedBody.length} `), signedBody]);
  const sig = sign('sha256', pae, cert.key).toString('base64');
  const doc = {
    attestations: [{
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        verificationMaterial: { certificate: { rawBytes: cert.der.toString('base64') }, tlogEntries: [{ integratedTime: String(Math.floor(Date.now() / 1000)) }] },
        dsseEnvelope: { payload: body.toString('base64'), payloadType, signatures: [{ sig }] },
      },
    }],
  };
  return { doc, chain: [testCa().root] };
}
