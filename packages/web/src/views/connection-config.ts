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
  command: 'Servers that run as a program on this computer are not supported yet.',
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
