/**
 * Two properties of this package that are easy to lose and hard to notice.
 *
 * **It makes no external request.** The gateway asserts this from the outside,
 * against the served HTML. This asserts it from the inside and across
 * everything the build pulls in — Radix's
 * components, every source file — because a Google Fonts `@import` in a CSS
 * file or a CDN script added by a dependency would both pass the HTML check.
 *
 * **It knows no domain.** The canvas renders shapes; a plugin's view
 * descriptor is the only thing that connects a tool to one. So no finance, no
 * mail, no weather tool name may appear anywhere in this package — an
 * installation with no finance plugin must not be shipping code that knows
 * what a cashflow is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGE = path.resolve(SRC, '..');
const DIST = path.resolve(PACKAGE, 'dist');

function walk(dir: string, match: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full, match));
    else if (match(full)) found.push(full);
  }
  return found;
}

/** Every source file except this one, which necessarily names the patterns. */
const SOURCES = walk(SRC, (file) => /\.(tsx?|css)$/.test(file)).filter(
  (file) => file !== fileURLToPath(import.meta.url),
);

/**
 * Hosts that may legitimately appear as *text* in a bundle. Neither is ever
 * fetched: one is the SVG/XML namespace identifier, which is a name and not a
 * location, and the other is inside React's own error messages.
 */
const ALLOWED_LITERALS = ['http://www.w3.org', 'https://reactjs.org', 'https://react.dev'];

function externalUrls(text: string): string[] {
  const urls = text.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? [];
  return urls.filter(
    (url) =>
      !ALLOWED_LITERALS.some((allowed) => url.startsWith(allowed)) &&
      !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url),
  );
}

describe('the page makes no external request', () => {
  it('has no remote stylesheet, font or import in any source file', () => {
    for (const file of SOURCES) {
      const text = readFileSync(file, 'utf8');
      const relative = path.relative(PACKAGE, file);
      // Comments and prose are allowed to *mention* a CDN; rules are not.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${relative} imports something remote`).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
      expect(code, `${relative} loads a remote font`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(code, `${relative} references a CDN`).not.toMatch(/cdn\.|unpkg\.com|jsdelivr/);
      expect(externalUrls(code), `${relative} names an external host`).toEqual([]);
    }
  });

  /**
   * The first-run thread is stricter than the rest of the page: it names no
   * address at all.
   *
   * `externalUrls` deliberately allows a loopback literal — the settings pages
   * offer `http://localhost:11434/v1` as the value of a field the owner is
   * editing, and that is a default, not a request. First run has no such
   * field: every address it uses (where Ollama answers, where to download it)
   * is data the gateway hands over, because the machine those answers are
   * about is the gateway's and not the browser's. A literal creeping back in
   * would be a page quietly deciding where the owner's AI lives.
   */
  it('lets the first-run thread name no address, not even a local one', () => {
    const thread = SOURCES.filter(
      (file) => file.endsWith(`views${path.sep}Meet.tsx`) || file.includes(`${path.sep}meet${path.sep}`),
    );
    expect(thread.length, 'the first-run thread moved').toBeGreaterThan(2);
    for (const file of thread) {
      const text = readFileSync(file, 'utf8');
      const relative = path.relative(PACKAGE, file);
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code.match(/https?:\/\/[^\s"'`)<>\\]+/g) ?? [], `${relative} names an address`).toEqual([]);
    }
  });

  it('declares only the system font stack, and ships no font file', () => {
    expect(readFileSync(path.join(SRC, 'tokens.css'), 'utf8')).toMatch(/--font-sans:[^;]*-apple-system/);
    expect(walk(SRC, (file) => /\.(woff2?|ttf|otf|eot)$/.test(file))).toEqual([]);
  });

  it('keeps the index.html free of any off-origin reference', () => {
    const html = readFileSync(path.join(PACKAGE, 'index.html'), 'utf8');
    // The same assertion the gateway makes against the served page. The inline
    // favicon carries the SVG namespace, which is a name and never fetched.
    expect(externalUrls(html)).toEqual([]);
  });

  it.runIf(existsSync(DIST))('has no external URL anywhere in the built bundle', () => {
    const built = walk(DIST, (file) => /\.(js|css|html)$/.test(file));
    expect(built.length, 'the build produced nothing to check').toBeGreaterThan(0);
    for (const file of built) {
      const text = readFileSync(file, 'utf8');
      const relative = path.relative(PACKAGE, file);
      expect(externalUrls(text), `${relative} would reach off-origin`).toEqual([]);
      // And nothing in the CSS fetches, whatever the URL looks like.
      if (file.endsWith('.css')) {
        expect(text, `${relative} imports remotely`).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
        expect(text, `${relative} fetches a remote asset`).not.toMatch(/url\(\s*['"]?(https?:)?\/\//);
      }
    }
  });
});

describe('the canvas knows no domain', () => {
  /**
   * Tool families that belong to plugins. The canvas draws shapes; a plugin's
   * view descriptor, which arrives as data, is the only thing that connects a
   * tool to one. So none of these may appear in the canvas, the chat client or
   * the shell — an installation with no finance plugin must not be shipping
   * code that knows what a cashflow is.
   *
   * (`views/Overview.tsx` is excluded on purpose: it renders the `finance`
   * *field of the platform's own `/api/overview` response*, which is a server
   * shape rather than a tool name, and predates this work.)
   */
  const DOMAIN_PREFIXES = [
    'finance.',
    'email.',
    'weather.',
    'artifacts.describe',
    'project_cashflow',
    'credit_utilization',
    'upcoming_statements',
    'stage_import',
    'card_activity',
  ];

  /**
   * Dotted names the platform itself owns: the canvas tool family, and the
   * event names the run stream emits. Neither belongs to a plugin.
   */
  const PLATFORM_LITERALS = new Set([
    "'canvas.show'",
    // One agent asking another is the platform's own tool, like `canvas.*`:
    // no plugin provides it, and a delegation draws a conversation of the
    // owner's rather than a domain's result.
    "'agent.delegate'",
    "'canvas.clear'",
    /*
     * Driving the owner's own screen. The gateway has a status route, owner
     * controls and a page of its own for it (`/api/browser`, `views/Browser`)
     * — it is the machine this installation runs on, not a domain's data —
     * and the canvas tab that folds those calls into one live panel has to
     * know which calls it covers. Named in `chat/browser.ts` and nowhere else.
     */
    "'browser.act'",
    "'browser.status'",
    "'run.started'",
    "'run.finished'",
    "'tool.called'",
    "'tool.result'",
    "'message.appended'",
    "'live.settle'",
    "'live.snapshot'",
    "'buddi.theme'",
    "'buddi.chatWidth'",
  ]);

  const NEW_SURFACE = SOURCES.filter((file) =>
    ['canvas', 'chat', 'shell'].some((dir) => file.includes(`${path.sep}${dir}${path.sep}`)),
  );

  it('covers the whole new surface', () => {
    // Guards the guard: a rename that emptied this list would pass silently.
    expect(NEW_SURFACE.length).toBeGreaterThan(12);
  });

  it('names no plugin tool in the canvas, the chat client or the shell', () => {
    for (const file of NEW_SURFACE) {
      const text = readFileSync(file, 'utf8');
      const relative = path.relative(PACKAGE, file);
      for (const prefix of DOMAIN_PREFIXES) {
        expect(text.includes(prefix), `${relative} mentions ${prefix}`).toBe(false);
      }
    }
  });

  it('hard-codes no tool name in the canvas, the chat client or the shell', () => {
    // Any dotted tool-name literal in shipped code would be a tool the page
    // knows about by name. Only `canvas.*` — which the platform itself owns —
    // is allowed. Tests are exempt: their fictional `orchard.*` and `shed.*`
    // fixtures exist precisely so the tests need no plugin to be installed.
    // The monitoring pages are exempt: they name *event kinds* the platform
    // emits (`mission.delivered` and friends), which are not tools.
    for (const file of NEW_SURFACE.filter((candidate) => !/\.test\.tsx?$/.test(candidate))) {
      const text = readFileSync(file, 'utf8');
      const relative = path.relative(PACKAGE, file);
      const literals = text.match(/'[a-z][a-z0-9]*\.[a-z][a-z0-9_]*'/g) ?? [];
      const foreign = literals.filter((literal) => !PLATFORM_LITERALS.has(literal));
      expect(foreign, `${relative} hard-codes a tool name`).toEqual([]);
    }
  });

  it('depends on no plugin package', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(deps.filter((dep) => dep.startsWith('@buddi/tool-'))).toEqual([]);
  });
});

function existsSync(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
