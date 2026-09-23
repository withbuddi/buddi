/**
 * No secret leaves through `buddi mcp` (docs/specs/mcp.md §2, §5.4).
 *
 * The routes this server reads already keep credentials out of what they
 * serve — an account says `configured`, never its key. This is the second
 * wall, applied to every result on its way out, because an MCP client is a
 * model and what it is handed can end up anywhere:
 *
 *  - a field whose *name* says it holds a credential (`token`, `apiKey`,
 *    `password`, …) keeps its state — `true`, `null`, empty — and loses any
 *    string value;
 *  - any string that has the *shape* of a credential — a provider key, a bot
 *    token, a bearer header, a JWT, a password in a connection URL — is cut
 *    wherever it appears, including inside a memory note or an event payload;
 *  - any string this process knows to be secret, because it is the value of a
 *    credential variable in its environment, is cut by value.
 */

export const REDACTED = '[redacted]';

/** Field names that hold a credential, compared lower-case with separators removed. */
const SECRET_FIELDS = new Set([
  'apikey',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'passphrase',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bottoken',
  'oauthtoken',
  'sessiontoken',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'privatekey',
  'databaseurl',
  'dsn',
  'connectionstring',
  'secretvalue',
  'vaultvalue',
]);

/** Shapes of credentials, wherever they turn up in text. */
const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bya29\.[A-Za-z0-9_-]{10,}/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g, // Google refresh token
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\btvly-[A-Za-z0-9_-]{10,}/g,
];

/** `scheme://user:password@host` — the password goes, the rest stays legible. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):([^@\s/]+)@/gi;

/** Environment variables whose values are credentials. */
const SECRET_VARIABLE = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|DATABASE_URL|DSN)/i;

/**
 * The secret values this process can know about: every credential variable in
 * its environment, and the password inside a database URL. Short values are
 * skipped — cutting every "1" out of a result would say nothing and ruin it.
 */
export function knownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_VARIABLE.test(name)) continue;
    // A variable that only names where a secret is (`…_KEY_FILE`, `…_ENV`) is not one.
    if (/(_FILE|_ENV|_PATH|_REF|_KIND)$/i.test(name)) continue;
    const trimmed = value.trim();
    // A number, a flag or a path is configuration, not a credential.
    if (/^[\d.:]+$/.test(trimmed) || /^(true|false|on|off|yes|no)$/i.test(trimmed) || trimmed.startsWith('/')) continue;
    if (trimmed.length >= 8) found.add(trimmed);
    try {
      const url = new URL(trimmed);
      if (url.password && decodeURIComponent(url.password).length >= 6) found.add(decodeURIComponent(url.password));
    } catch {
      // not a URL
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cut every credential out of one string. */
export function redactText(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const value of known) {
    if (out.includes(value)) out = out.replace(new RegExp(escape(value), 'g'), REDACTED);
  }
  out = out.replace(URL_PASSWORD, (_m, head: string) => `${head}:${REDACTED}@`);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** Cut every credential out of a value, however deep. The input is not modified. */
export function redact(value: unknown, known: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, known);
  if (Array.isArray(value)) return value.map((v) => redact(v, known));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const field = key.toLowerCase().replace(/[^a-z]/g, '');
      if (SECRET_FIELDS.has(field) && typeof v === 'string' && v !== '') {
        out[key] = REDACTED;
        continue;
      }
      if (SECRET_FIELDS.has(field) && v && typeof v === 'object') {
        // A credential object (`{ token: …, expiresAt: … }`): keep only its states.
        out[key] = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(([, inner]) => typeof inner === 'boolean' || inner === null),
        );
        continue;
      }
      out[key] = redact(v, known);
    }
    return out;
  }
  return value;
}
