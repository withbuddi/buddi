#!/usr/bin/env node
// Uploads an extension zip to the Chrome Web Store and, with --publish,
// submits it for review. It talks to the store API directly (the three calls
// the chrome-webstore-upload library makes) instead of running
// chrome-webstore-upload-cli, whose error handler prints the OAuth refresh
// token on a "Bad Request" and dumps raw error objects otherwise. Nothing
// from a response reaches the log except its allowlisted explanation fields
// (error_description, error_code, the store's message and status), scrubbed
// of anything token-shaped. Exit 0 when the store took it, 1 when it refused.
//
//   node scripts/release/cws-upload.mjs --source x.zip --extension-id <id> [--publish]
//
// Credentials: CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://www.googleapis.com';
const TOKEN_URI = `${API}/oauth2/v4/token`;
const KEYS = new Set(['error_description', 'error_code', 'error_detail', 'message', 'status', 'statusDetail', 'uploadState', 'code', 'error']);
const LONG = /[A-Za-z0-9_\-+/=~]{30,}/g;

/** The allowlisted explanation in a store or OAuth response, scrubbed. */
export function explain(body, secrets = []) {
  const parts = [];
  const walk = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (key && KEYS.has(key) && (typeof v === 'string' || typeof v === 'number')) parts.push(`${key}: ${v}`);
  };
  walk(body);
  let text = parts.join('; ');
  for (const s of secrets) if (s && s.length >= 6) text = text.split(s).join('[redacted]');
  text = text.replace(LONG, '[redacted]');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

class Refused extends Error {}

async function call(step, url, init, secrets) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Refused(`${step}: the request did not reach the store.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Refused(`${step} refused (HTTP ${res.status}). ${explain(body, secrets)}`.trim());
  return body;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { source: { type: 'string' }, 'extension-id': { type: 'string' }, publish: { type: 'boolean' } },
  });
  const { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret, REFRESH_TOKEN: refreshToken } = env;
  const secrets = [clientId, clientSecret, refreshToken];
  const id = values['extension-id'];
  if (!values.source || !id || !clientId || !refreshToken) {
    console.log('Usage: cws-upload.mjs --source <zip> --extension-id <id> [--publish], with CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN set.');
    return 1;
  }
  try {
    const token = (
      await call(
        'Sign-in',
        TOKEN_URI,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        },
        secrets,
      )
    ).access_token;
    if (typeof token === 'string') secrets.push(token);
    const headers = { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' };
    const upload = await call(
      'Upload',
      `${API}/upload/chromewebstore/v1.1/items/${id}`,
      { method: 'PUT', headers, body: await readFile(values.source) },
      secrets,
    );
    if (upload.uploadState !== 'SUCCESS') throw new Refused(`Upload refused. ${explain(upload, secrets)}`.trim());
    console.log(`Uploaded ${basename(values.source)}.`);
    if (values.publish) {
      const pub = await call('Publish', `${API}/chromewebstore/v1.1/items/${id}/publish?publishTarget=default`, { method: 'POST', headers }, secrets);
      const [status] = pub.status ?? [];
      if (status !== 'OK' && status !== 'ITEM_PENDING_REVIEW') throw new Refused(`Publish refused. ${explain(pub, secrets)}`.trim());
      console.log(status === 'OK' ? 'Published.' : 'Submitted for review.');
    }
    return 0;
  } catch (error) {
    console.log(error instanceof Refused ? error.message : 'The upload failed before the store answered (details withheld).');
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
