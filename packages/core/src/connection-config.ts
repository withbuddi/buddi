/**
 * "I have a config" on Settings → Connections (docs/connections.md,
 * "Connect"): the block other MCP clients take, read into what the connect
 * screens ask for. The standard `{ "mcpServers": { "<name>": { … } } }`, or
 * one server's `{ "url": …, "headers": … }` on its own.
 *
 * A header becomes the token sign-in: its name, the value as the token, and
 * `Bearer ` or `Basic ` as the words before it when the value starts with
 * one. Nothing here keeps, logs or shows the value; the caller hands it to
 * the token screen and clears the box.
 *
 * A program (`{ command, args, env }`, or a `claude mcp add … -- <command>`
 * line) is read by `parsePastedServer` into what "A program on this computer"
 * asks for: the command, its arguments, and each variable with a Secret
 * switch already on when its name looks like one.
 *
 * Shared by the dashboard's paste box and `buddi connections add --json`, so
 * both read a block and refuse one with the same sentences. A leaf module
 * (no imports), reached through the `@buddi/core/connection-config` subpath
 * so the dashboard bundle loads nothing else from core.
 */

export interface PastedHeader {
  /** The header's name: `Authorization`, `X-API-Key`. */
  name: string;
  /** The words before the token, `Bearer ` or `Basic `, or ''. */
  prefix: string;
  /** The token itself; '' when the config held a placeholder instead. */
  value: string;
}

export interface PastedConfig {
  url: string;
  /** The server's name in `mcpServers`, when there was one. */
  name?: string;
  header?: PastedHeader;
  /** Other headers the config set: buddi sends one, so these are left out. */
  dropped: string[];
  /** The header's value was a placeholder (`${GITHUB_TOKEN}`): the token is pasted on the next screen. */
  placeholder: boolean;
}

export const CONFIG_REFUSALS = {
  json: 'That is not JSON. Paste the whole block, braces included.',
  empty: 'There is no server in it.',
  command: 'It starts a program on this computer rather than naming an address. Use "A program on this computer" instead.',
  sse: 'buddi speaks Streamable HTTP; this server is SSE-only.',
  url: 'It has no url. buddi connects to a server by its https:// address.',
} as const;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read a pasted config, or throw a sentence saying why not. */
export function parseConnectionConfig(text: string): PastedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error(CONFIG_REFUSALS.json);
  }
  if (!isObject(parsed)) throw new Error(CONFIG_REFUSALS.json);
  let name: string | undefined;
  let server: Json = parsed;
  if ('mcpServers' in parsed) {
    const servers = parsed.mcpServers;
    if (!isObject(servers)) throw new Error(CONFIG_REFUSALS.empty);
    const names = Object.keys(servers);
    if (names.length === 0) throw new Error(CONFIG_REFUSALS.empty);
    if (names.length > 1) throw new Error(`It names ${names.length} servers (${names.join(', ')}). Paste one at a time.`);
    name = names[0]!;
    const entry = servers[name];
    if (!isObject(entry)) throw new Error(CONFIG_REFUSALS.url);
    server = entry;
  }
  if ('command' in server) throw new Error(CONFIG_REFUSALS.command);
  if (typeof server.type === 'string' && server.type.toLowerCase() === 'sse') throw new Error(CONFIG_REFUSALS.sse);
  const url = typeof server.url === 'string' ? server.url.trim() : '';
  if (url === '') throw new Error(CONFIG_REFUSALS.url);

  const headers = isObject(server.headers)
    ? Object.entries(server.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim() !== '')
    : [];
  const chosen = headers.find(([key]) => key.toLowerCase() === 'authorization') ?? headers[0];
  let header: PastedHeader | undefined;
  let placeholder = false;
  if (chosen) {
    const [key, raw] = chosen;
    const words = /^(Bearer|Basic)\s+/i.exec(raw.trim());
    const prefix = words ? `${words[1]!.charAt(0).toUpperCase()}${words[1]!.slice(1).toLowerCase()} ` : '';
    let value = words ? raw.trim().slice(words[0].length).trim() : raw.trim();
    if (/\$\{[^}]*\}|^\$[A-Z_][A-Z0-9_]*$|^<[^>]+>$/i.test(value)) {
      placeholder = true;
      value = '';
    }
    header = { name: key.trim(), prefix, value };
  }
  return {
    url,
    ...(name ? { name } : {}),
    ...(header ? { header } : {}),
    dropped: headers.filter((entry) => entry !== chosen).map(([key]) => key),
    placeholder,
  };
}

/* ------------------------------------------------------------------ *
 * A program on this computer (stdio)
 * ------------------------------------------------------------------ */

export interface PastedEnv {
  name: string;
  /** '' when the config held a placeholder (`${TOKEN}`, `<your-key>`, `YOUR_KEY`) instead. */
  value: string;
  /** Kept in the vault: on by default when the name looks like a secret. */
  secret: boolean;
  placeholder: boolean;
}

export interface PastedProgram {
  name?: string;
  command: string;
  args: string[];
  env: PastedEnv[];
}

export type PastedServer =
  | { kind: 'remote'; config: PastedConfig }
  | { kind: 'program'; program: PastedProgram };

export const PROGRAM_REFUSALS = {
  command: 'It names no command to run.',
  claude: 'That claude mcp add line names no server and no command. It looks like: claude mcp add <name> -- <command> <args…>',
  quote: 'A quote in that line is never closed.',
  env: 'An environment variable is written NAME=value.',
} as const;

/** A variable whose name says it is a credential: its Secret switch starts on. */
export function looksSecret(name: string): boolean {
  return /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(name);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlaceholder(value: string): boolean {
  return /\$\{[^}]*\}|^\$[A-Z_][A-Z0-9_]*$|^<[^>]+>$|^your[_-]/i.test(value.trim());
}

function pastedEnv(name: string, raw: string): PastedEnv {
  const placeholder = isPlaceholder(raw);
  return { name, value: placeholder ? '' : raw, secret: looksSecret(name), placeholder };
}

/**
 * Split a shell line into words the way a POSIX shell would for the simple
 * cases a server's docs print: spaces, 'single' and "double" quotes, a
 * backslash escape, and a backslash at the end of a line continuing it.
 * No expansion of any kind.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) {
        const next = line[++i]!;
        if (next !== '\n') word += next;
      } else word += c;
      continue;
    }
    if (c === '\\') {
      const next = line[i + 1];
      if (next === undefined) continue;
      i += 1;
      if (next === '\n' || (next === '\r' && line[i + 1] === '\n')) { if (next === '\r') i += 1; continue; }
      word += next;
      started = true;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    word += c;
    started = true;
  }
  if (quote) throw new Error(PROGRAM_REFUSALS.quote);
  if (started) words.push(word);
  return words;
}

/**
 * `claude mcp add <name> [-e|--env K=V]... [-s|--scope x] [-t|--transport stdio] -- <command> <args…>`,
 * what servers' docs print. An http or sse transport with an address reads
 * as a remote server instead (its `-H` header as the token).
 */
export function parseClaudeMcpAdd(line: string): PastedServer {
  const words = shellWords(line.trim());
  let i = 0;
  if (words[i] === 'claude') i += 1;
  if (words[i] === 'mcp') i += 1;
  if (words[i] === 'add') i += 1;
  const env: PastedEnv[] = [];
  const headers: string[] = [];
  let transport = 'stdio';
  let name: string | undefined;
  let program: string[] | undefined;
  const takeEnv = (pair: string): void => {
    const at = pair.indexOf('=');
    const key = at > 0 ? pair.slice(0, at).trim() : '';
    if (!ENV_NAME.test(key)) throw new Error(PROGRAM_REFUSALS.env);
    env.push(pastedEnv(key, pair.slice(at + 1)));
  };
  const rest: string[] = [];
  for (; i < words.length; i += 1) {
    const w = words[i]!;
    if (w === '--') { program = words.slice(i + 1); break; }
    const [flag, inline] = w.startsWith('--') && w.includes('=') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, undefined];
    if (flag === '-e' || flag === '--env') {
      if (inline !== undefined) { takeEnv(inline); continue; }
      // Variadic in claude's own parser: every NAME=value that follows.
      let took = false;
      while (i + 1 < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i + 1]!)) { takeEnv(words[++i]!); took = true; }
      if (!took) throw new Error(PROGRAM_REFUSALS.env);
      continue;
    }
    if (flag === '-s' || flag === '--scope') { if (inline === undefined) i += 1; continue; }
    if (flag === '-t' || flag === '--transport') { transport = (inline ?? words[++i] ?? 'stdio').toLowerCase(); continue; }
    if (flag === '-H' || flag === '--header') { const h = inline ?? words[++i]; if (h) headers.push(h); continue; }
    if (flag.startsWith('-') && name === undefined) continue;
    if (name === undefined) { name = w; continue; }
    rest.push(w);
  }
  if (program === undefined) program = rest;
  else if (rest.length > 0) program = [...rest, ...program];
  if (transport === 'http' || transport === 'sse' || (program.length === 1 && /^https?:\/\//i.test(program[0]!))) {
    const url = program[0];
    if (!url) throw new Error(CONFIG_REFUSALS.url);
    const header: Record<string, string> = {};
    for (const h of headers) {
      const at = h.indexOf(':');
      if (at > 0) header[h.slice(0, at).trim()] = h.slice(at + 1).trim();
    }
    return { kind: 'remote', config: parseConnectionConfig(JSON.stringify({ mcpServers: { [name ?? 'server']: { type: transport, url, headers: header } } })) };
  }
  if (!name || program.length === 0) throw new Error(PROGRAM_REFUSALS.claude);
  return { kind: 'program', program: { name, command: program[0]!, args: program.slice(1), env } };
}

/**
 * What the paste box and `--json` read: a `claude mcp add` line, or the
 * `mcpServers` block (or one server of it), remote or a program.
 */
export function parsePastedServer(text: string): PastedServer {
  const trimmed = text.trim();
  if (/^claude\s+mcp\s+add\b/.test(trimmed)) return parseClaudeMcpAdd(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(CONFIG_REFUSALS.json);
  }
  if (!isObject(parsed)) throw new Error(CONFIG_REFUSALS.json);
  let name: string | undefined;
  let server: Json = parsed;
  if ('mcpServers' in parsed) {
    const servers = parsed.mcpServers;
    if (!isObject(servers)) throw new Error(CONFIG_REFUSALS.empty);
    const names = Object.keys(servers);
    if (names.length === 1 && isObject(servers[names[0]!])) {
      name = names[0]!;
      server = servers[name] as Json;
    }
  }
  if (!('command' in server)) return { kind: 'remote', config: parseConnectionConfig(trimmed) };
  const command = typeof server.command === 'string' ? server.command.trim() : '';
  if (command === '') throw new Error(PROGRAM_REFUSALS.command);
  const args = Array.isArray(server.args) ? server.args.map((a) => String(a)) : [];
  const env = isObject(server.env)
    ? Object.entries(server.env).filter(([key]) => ENV_NAME.test(key)).map(([key, value]) => pastedEnv(key, String(value ?? '')))
    : [];
  return { kind: 'program', program: { ...(name ? { name } : {}), command, args, env } };
}
