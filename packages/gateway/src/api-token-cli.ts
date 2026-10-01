/**
 * `buddi api-token` — owner API tokens from a terminal (docs/api.md, docs/cli.md).
 *
 * The same table Settings → API tokens writes: `create` prints the token once
 * and never again, `list` shows each one's name, last four characters and when
 * it was last used, `revoke` deletes it so the next request carrying it is
 * refused. Straight to the database: it works whether or not buddi is running.
 */
import { createPool } from '@buddi/core';
import { loadEnvironment } from './bootstrap.js';
import { ApiTokenRefusal, createApiToken, listApiTokens, revokeApiToken, type ApiTokenView } from './web/api-tokens.js';

export const USAGE = `buddi api-token — tokens for calling buddi's HTTP API without the dashboard

  buddi api-token create <name>            make one; it is printed once
  buddi api-token list [--json]            every token: id, name, last four, last used
  buddi api-token revoke <id>              end one (an id, or its first characters)

Send it as: Authorization: Bearer <token>. See docs/api.md.`;

export type ApiTokenCommand =
  | { action: 'help' }
  | { action: 'create'; name: string }
  | { action: 'list'; json: boolean }
  | { action: 'revoke'; id: string };

export function parseApiTokenArgs(argv: readonly string[]): ApiTokenCommand {
  const json = argv.includes('--json');
  const words = argv.filter((a) => a !== '--json');
  if (json && words[0] !== undefined && words[0] !== 'list') throw new Error('Only buddi api-token list takes --json.');
  if (words.includes('--help') || words.includes('-h') || words[0] === 'help') return { action: 'help' };
  const unknown = words.find((w) => w.startsWith('-'));
  if (unknown) throw new Error(`buddi api-token does not take ${unknown}`);
  const [verb, ...rest] = words;
  if (verb === undefined || verb === 'list') {
    if (rest.length > 0) throw new Error(`buddi api-token list takes no arguments (got ${rest[0]})`);
    return { action: 'list', json };
  }
  if (verb === 'create') {
    const name = rest.join(' ').trim();
    if (name === '') throw new Error('buddi api-token create needs a name: what will use the token, e.g. buddi api-token create "home automation"');
    return { action: 'create', name };
  }
  if (verb === 'revoke') {
    if (rest.length !== 1) throw new Error('buddi api-token revoke needs one token id (buddi api-token list prints them)');
    return { action: 'revoke', id: rest[0] as string };
  }
  throw new Error(`buddi api-token ${verb} is not a command. Try create, list or revoke.`);
}

function line(t: ApiTokenView): string {
  const used = t.lastUsedAt ? `last used ${t.lastUsedAt.replace('T', ' ').slice(0, 16)} UTC` : 'never used';
  return `${t.id}  ${t.name}  …${t.hint}  made ${t.createdAt.slice(0, 10)} (${t.createdVia}), ${used}`;
}

/** Exit codes: 0 done, 2 usage, 3 nothing by that id or the database is not reachable, 4 refused (limit, name). */
export async function main(argv: string[] = process.argv.slice(3)): Promise<number> {
  let command: ApiTokenCommand;
  try {
    command = parseApiTokenArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (command.action === 'help') {
    console.log(USAGE);
    return 0;
  }
  await loadEnvironment();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('The database is not configured: run buddi init, or set DATABASE_URL.');
    return 3;
  }
  const pool = createPool(url);
  try {
    if (command.action === 'list') {
      const tokens = await listApiTokens(pool);
      if (command.json) console.log(JSON.stringify(tokens, null, 2));
      else console.log(tokens.length === 0 ? 'No API tokens. Make one with buddi api-token create <name>.' : tokens.map(line).join('\n'));
      return 0;
    }
    if (command.action === 'create') {
      const made = await createApiToken(pool, { name: command.name, via: 'cli' });
      console.log(made.token);
      console.error(`\nThat is the token for “${made.apiToken.name}” (${made.apiToken.id}). It is shown only now: keep it somewhere safe.\nSend it as  Authorization: Bearer <token>  — docs/api.md says what it can do.`);
      return 0;
    }
    const revoked = await revokeApiToken(pool, command.id);
    if (!revoked) {
      console.error(`No token has the id ${command.id}. buddi api-token list prints them.`);
      return 3;
    }
    console.log(`Revoked “${revoked.name}” (…${revoked.hint}). A request carrying it is refused from now on.`);
    return 0;
  } catch (err) {
    if (err instanceof ApiTokenRefusal) {
      console.error(err.message);
      return 4;
    }
    console.error(`The database did not answer: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  } finally {
    await pool.end();
  }
}
