#!/usr/bin/env node
/**
 * A registry with exactly the packages a release smoke needs in it.
 *
 * The upgrade path is `npm install buddi@<version> --registry <r>`, so the
 * only way to exercise it without publishing to npmjs.org is to be the
 * registry. This serves the two documents npm asks for (the packument and the
 * tarball) and one more that `@buddi/install` asks for on its own: the
 * `/@withbuddi%2Fbuddi/latest` manifest behind the version check.
 *
 * Two packages, and the second one is not optional.
 *
 *  - `buddi`: the tarballs the smoke builds from the one it was given.
 *  - `@embedded-postgres/<platform>-<arch>`: the per-platform Postgres
 *    binaries, which are an *optional* dependency of `buddi` resolved from
 *    whatever registry the install was told to use. A registry that serves
 *    only `buddi` makes npm drop the binaries out of the tree it is
 *    reconciling, and the upgraded installation comes up with no cluster. The
 *    smoke packs the copy already in its own node_modules and serves that, so
 *    nothing here is ever fetched from the network.
 *
 * Nothing is authenticated and nothing is persisted: it listens on 127.0.0.1,
 * holds its packages in memory, and dies with the process that started it.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';

/** The two hashes a packument carries for a tarball, both of the same bytes. */
function hashes(bytes) {
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

/**
 * Start it. Resolves once it is listening, because `publish` needs the port:
 * `dist.tarball` is an absolute URL and npm fetches exactly what it is given.
 */
export async function startRegistry({ host = '127.0.0.1', log } = {}) {
  /** name -> { tags: { latest }, versions: Map<version, entry> }. */
  const packages = new Map();

  const found = decoded => {
    const held = packages.get(decoded);
    if (held) return { pkg: held, name: decoded };
    return undefined;
  };

  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    // npm escapes the slash in a scoped name, so the path is decoded whole and
    // then matched against the names on offer rather than split on '/'.
    let route;
    try { route = decodeURIComponent(new URL(req.url, 'http://registry.invalid').pathname).replace(/^\/+/, ''); }
    catch { return send(400, { error: 'that is not a path' }); }
    log?.(`${req.method} /${route}`);
    if (req.method !== 'GET') return send(405, { error: 'this registry is read-only' });

    const tarball = route.indexOf('/-/');
    if (tarball !== -1) {
      const held = found(route.slice(0, tarball));
      const file = route.slice(tarball + 3);
      const entry = held && [...held.pkg.versions.values()].find(candidate => candidate.file === file);
      if (!entry) return send(404, { error: 'no such tarball' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.bytes });
      return createReadStream(entry.path).pipe(res);
    }

    const whole = found(route);
    if (whole) {
      const { pkg } = whole;
      return send(200, {
        name: route,
        'dist-tags': pkg.tags,
        versions: Object.fromEntries([...pkg.versions].map(([version, entry]) => [version, entry.manifest])),
      });
    }
    // `<name>/<tag>`: the abbreviated manifest the version check reads.
    const tagged = route.lastIndexOf('/');
    const base = tagged === -1 ? undefined : found(route.slice(0, tagged));
    if (base) {
      const wanted = route.slice(tagged + 1);
      const version = base.pkg.tags[wanted] ?? (base.pkg.versions.has(wanted) ? wanted : undefined);
      const entry = version === undefined ? undefined : base.pkg.versions.get(version);
      if (entry) return send(200, entry.manifest);
    }
    return send(404, { error: 'not published here' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const url = `http://${host}:${server.address().port}`;

  return {
    url,

    /**
     * Put a tarball on the registry under a name and a version.
     *
     * `manifest` is the package.json that was packed: npm resolves a tree from
     * the packument, so a version whose metadata is missing its dependencies
     * or its `os`/`cpu` is a version npm installs wrongly. `integrity`
     * overrides the hash of the bytes, which is how the smoke makes an install
     * that cannot succeed.
     */
    async publish(name, version, file, { manifest, integrity, tag = 'latest' } = {}) {
      const bytes = await readFile(file);
      const real = hashes(bytes);
      const filename = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
      const pkg = packages.get(name) ?? { tags: {}, versions: new Map() };
      pkg.versions.set(version, {
        path: file,
        file: filename,
        bytes: (await stat(file)).size,
        manifest: {
          ...(manifest ?? {}),
          name,
          version,
          dist: {
            tarball: `${url}/${name}/-/${filename}`,
            integrity: integrity ?? real.integrity,
            shasum: real.shasum,
          },
        },
      });
      if (tag !== false) pkg.tags[tag] = version;
      packages.set(name, pkg);
      return pkg.versions.get(version).manifest;
    },

    /** What `<name>/latest` answers with, without asking over HTTP. */
    latest(name) {
      const pkg = packages.get(name);
      return pkg?.tags.latest;
    },

    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}
