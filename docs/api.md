---
title: "The HTTP API"
status: reference
updated: 2026-10-07
---

# The HTTP API

Everything the dashboard does, it does through this API, so buddi works
without the dashboard: a script, another program or `curl` can do what the
page does. This page is generated from the gateway's route table
(`packages/gateway/src/web/api-routes.ts`) by `pnpm docs:api`, and a test
fails when a route is missing from it.

## Where it is

The API is served by the gateway, on the dashboard's own address, under
`/api`:

- **This computer:** `http://127.0.0.1:4317` by default (`BUDDI_WEB_PORT`
  changes the port; `buddi status` prints the address).
- **Your tailnet:** the HTTPS address `tailscale serve` gives the dashboard
  (Settings → System → Sign in from elsewhere → Tailscale prints the command).
- **Your own domain through Cloudflare:** the public hostname of a Cloudflare
  Tunnel with Cloudflare Access in front (Settings → System → Sign in from
  elsewhere → Cloudflare Access walks through it).

Requests and answers are JSON (`Content-Type: application/json`), except
where a route says *bytes*, *upload*, *server-sent events* or *WebSocket*. A
JSON body is at most 64 KB. Paths ignore a trailing slash.

## Authentication

Every `/api` route answers only the owner. There are two ways to be the
owner:

**An API token** — for scripts and programs. Make one in Settings → API
tokens, or in a terminal:

```sh
buddi api-token create "home automation"
```

It is shown once. Send it on every request:

```sh
export BUDDI_URL=http://127.0.0.1:4317 BUDDI_TOKEN=buddi_…
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/overview"
```

A token acts as the owner, with no cookie, no CSRF header and no Origin
check, and the lock screen does not cover it. What it cannot do is decided by
the route, and the table below says so per route (**Token: no**). A token
never:

- decides an approval, or makes a change where the click is the approval
  (approve, keep a proposal, accept a plugin's agent) — it may reject;
- changes what an agent may do without asking (its tools, delegates, a
  connection given out, a remembered "always");
- installs or runs code buddi has not run before (plugins, upgrades, program
  connections, the browser download);
- changes how buddi is reached or unlocked (PIN, Tailscale, Telegram pairing,
  the extension, other tokens) or restores a backup over everything;
- reads or stores a secret (owner secrets, model account keys and sign-ins,
  the backup passphrase).

Those answer `403 { "error": "An API token cannot …" }`. Everything a gated
tool does still waits on its approval card, which the owner decides on the
dashboard or Telegram. Tokens are kept hashed (SHA-256); the gateway never
stores or logs the token itself. `buddi api-token list` and Settings show
each one's name, last four characters and when it was last used;
`buddi api-token revoke <id>` (or Revoke in Settings) ends it at the next
request.

**A dashboard session** — what the browser holds. It comes from a sign-in
link (`buddi dashboard`: a five-minute ticket, `?t=…`, exchanged at a
page URL and never under `/api`) or an identity a trusted access provider
verified for the person the owner allowed (Tailscale's daemon, Cloudflare
Access's signed JWT);
a source checkout bound to loopback also mints one for any request from this
computer. The session is a cookie
(`buddi_session_<port>`, HttpOnly, SameSite=Strict). Every request that is
not a GET or HEAD must also carry:

- `X-Buddi-CSRF`: the `csrf` value from `GET /api/session` (also in the
  `buddi_csrf_<port>` cookie, which must match), and
- `Origin`: the dashboard's own origin.

### A session from a script

A program on the computer buddi runs on can hold a session the way
`buddi mcp` does, which also reaches the routes a token may not: exchange
a five-minute ticket once, keep the cookies, and read the CSRF value.

```sh
curl -s -c cookies.txt -o /dev/null "$BUDDI_URL/?t=$(buddi dashboard --token)"
CSRF=$(curl -s -b cookies.txt "$BUDDI_URL/api/session" | sed -E 's/.*"csrf":"([^"]+)".*/\1/')
curl -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" \
  -H "Content-Type: application/json" -d '{"paused":true}' "$BUDDI_URL/api/pause"
```

`buddi dashboard --token` reads the installation's own secret, so it works
only on that computer. A wrong or expired ticket counts as a failed sign-in.

## Answers and errors

A success is `200` with JSON unless the route says otherwise (`201`
created, `202` accepted and still running — follow the job or stream it
names, `204` no body). A refusal is a status with `{ "error": "<a sentence
for a person>" }`, sometimes with more fields. The gate answers before any
route, with an empty body:

| Status | Meaning |
| --- | --- |
| 401 | Not signed in: no session, or the token is unknown or revoked. |
| 403 | A write without its CSRF header or Origin; or, with JSON, a route a token may not call. |
| 404 | `{ "error": "no such endpoint" }` for a path that is not a route. |
| 405 | A method the path does not take. |
| 423 | `{ "locked": true, … }`: the dashboard session is locked (Settings → Lock screen). Tokens are not covered. |
| 429 | Too many failed sign-ins from this address; `Retry-After` says when to try again. |
| 503 | A sign-in provider could not be asked (Tailscale's daemon, Cloudflare's signing keys), or a part of buddi is not running in this process. |

## Rate limits and lockout

A request that presents a credential that is wrong — a stale session cookie,
an expired sign-in link, an unknown or revoked API token — counts as a failed
sign-in for its address: ten in a minute and that address is answered
`429` until the minute is over. Each distinct wrong value counts once a
window, so one forgotten client cannot lock the owner out on its own. All
tailnet and SSH-tunnel traffic arrives from 127.0.0.1 and shares one budget.
A request with no credential at all counts as nothing.

Beyond that: at most a few open event streams per session (`429`), five
extension pairing tries in five minutes, and plugin page writes have their
own limit.

## Streams

`GET /api/chat/conversations/:id/stream` and `GET /api/chat/attention/stream`
are server-sent events. Reconnect with `Last-Event-ID` (or `?since=`) to
resume where you left off. A turn sent with `POST /api/chat/:agent/messages`
is answered `202` at once; its reply arrives on the stream.

## Example: talk to an agent headless

```sh
# who is there
curl -s -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/agents"
# say something to the default assistant (its id from the list above)
curl -s -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"What is on my calendar today?"}' "$BUDDI_URL/api/chat/<agent>/messages"
# follow the reply
curl -N -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<conversationId>/stream"
```

## Routes

337 routes in 22 areas. Paths are under the dashboard's address; `:name` is a path parameter.
**Token** says whether an API token may call the route; where it may not, the example uses a dashboard session.
**Since** is the first release with the route; 0.1.0-pre.15 is the earliest release in the public history, so it also stands for earlier.

- [Session and lock screen](#session-and-lock-screen)
- [API tokens](#api-tokens)
- [Home](#home)
- [Chat](#chat)
- [Groups](#groups)
- [Agents](#agents)
- [Approvals, offers and proposals](#approvals-offers-and-proposals)
- [Missions, jobs, reminders and watchers](#missions-jobs-reminders-and-watchers)
- [Notifications](#notifications)
- [Memory](#memory)
- [Files](#files)
- [Your profile](#your-profile)
- [Model accounts](#model-accounts)
- [Connections](#connections)
- [Plugins and plugin pages](#plugins-and-plugin-pages)
- [Keys and secrets](#keys-and-secrets)
- [Computer and browser](#computer-and-browser)
- [Telegram](#telegram)
- [Backups, version and service](#backups-version-and-service)
- [First run](#first-run)
- [Speech](#speech)
- [MCP](#mcp)

### Session and lock screen

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/session` | Who is signed in, the CSRF value writes must echo, and facts every page formats with. | yes |
| GET | `/api/lock` | The lock screen state: whether a PIN is set and this session is locked. | yes |
| POST | `/api/lock` | Lock this session now. | no |
| GET | `/api/lock/screen` | What the lock screen draws: the time, counts waiting (approvals, and everything else that needs the owner as `needs`), the focus line, its widgets. | yes |
| POST | `/api/lock/unlock` | Unlock with the PIN. | no |
| POST | `/api/lock/activity` | The page saying the owner is using it, which pushes back the idle lock. | no |
| PUT | `/api/lock/pin` | Set or change the PIN. | no |
| POST | `/api/lock/pin/remove` | Remove the PIN. | no |
| PUT | `/api/lock/settings` | Lock after, background and clock. | no |
| GET | `/api/lock/background` | The lock screen's own picture, as JPEG. | yes |
| POST | `/api/lock/background` | Upload the lock screen picture. | no |
| DELETE | `/api/lock/background` | Remove the lock screen picture and its portrait version (the background goes back to a built-in one). | no |
| GET | `/api/lock/background/portrait` | The portrait version of the lock screen's own picture, drawn on a phone, as JPEG. | yes |
| POST | `/api/lock/background/portrait` | Upload a portrait version of the lock screen picture for phones. | no |
| DELETE | `/api/lock/background/portrait` | Remove the portrait version (phones show the picture itself). | no |
| GET | `/api/access` | Sign in from elsewhere: every trusted access provider (Tailscale, Cloudflare Access) with its status in one line, and whether this request came through one (the block is then read-only). | yes |
| GET | `/api/access/tailscale` | Tailscale sign-in: the stored setting, the daemon, and the command that serves this dashboard on the tailnet. | yes |
| PUT | `/api/access/tailscale` | Turn Tailscale sign-in on or off, for one login. Every Tailscale session ends. | no |
| GET | `/api/access/cloudflare-access` | Cloudflare Access sign-in: the stored fields, the status, the setup steps with the ingress port cloudflared must point at, and the last verified visit. | yes |
| PUT | `/api/access/cloudflare-access` | Save Cloudflare Access sign-in: the team domain, the application AUD tag, the one allowed email and the public address. Binds or closes the ingress listener and fetches the team's signing keys once; sessions it admitted end unless the same person, team and application stay on. | no |
| POST | `/api/access/cloudflare-access/test` | "Test my setup": fetch the signing keys of the team domain given (or the stored one) and say what came back. Nothing is stored. | no |
| GET | `/api/access/cloudflare-access/setup` | "Set it up for me": the run in progress (or the last one), whether a Cloudflare API token is kept, what buddi made last time, the token permissions to ask for and the ingress port. The install line in `progress.install` holds the tunnel's connector token. | yes |
| POST | `/api/access/cloudflare-access/setup` | Start "Set it up for me": with the API token (kept as the owner secret CLOUDFLARE_API_TOKEN; omit it to use the kept one), buddi finds the zone, creates (or reuses what it made before) the tunnel buddi-<host>, its ingress, the DNS record, the Access policy and application, fills in Cloudflare Access sign-in, shows the service install line, waits for the tunnel and runs the test. Poll GET for progress. An object of buddi's name that buddi did not make stops the run with `progress.adoptable`; `adopt: true` uses it anyway. | no |
| POST | `/api/access/cloudflare-access/zones` | Check a Cloudflare API token (omit it to use the kept one) and list the domains (zones) it can see, for the setup form's domain choice. The pasted token is not kept and never echoed. | no |
| POST | `/api/access/cloudflare-access/setup/stop` | Stop waiting for the tunnel. What buddi made stays; a new run picks it up. | no |
| POST | `/api/access/cloudflare-access/setup/remove` | Remove what "Set it up for me" made — the Access application and policy, the DNS record and the tunnel, only those whose ids buddi recorded making — turn Cloudflare Access sign-in off when setup filled it in. The token stays kept (`tokenStored`) until forgotten. | no |
| POST | `/api/access/cloudflare-access/setup/forget-token` | Forget the kept Cloudflare API token (drops the owner secret CLOUDFLARE_API_TOKEN). It stays valid in Cloudflare until revoked there (My Profile → API Tokens). | no |
| GET | `/api/tailscale` | Alias of GET /api/access/tailscale, kept for one release. | yes |
| PUT | `/api/tailscale` | Alias of PUT /api/access/tailscale, kept for one release. | no |

#### `GET /api/session`

Who is signed in, the CSRF value writes must echo, and facts every page formats with.

- **Auth:** Session or API token; answered while locked.
- **Answer:** `{ csrf: string, timezone: string, timeFormat: '12h'|'24h'|null, dateFormat: 'short'|'long'|'iso'|null, host: string, port: number, platform: string, recovery: boolean, scope: 'local'|'remote', signedInThrough: 'local'|'ticket'|'tailscale'|'cloudflare-access'|'token', provider?: 'tailscale'|'cloudflare-access', providerSubject?: string, tailscaleName?: string, tailscaleLogin?: string, expiresAt: string, version: string }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/session"
```

#### `GET /api/lock`

The lock screen state: whether a PIN is set and this session is locked.

- **Auth:** Session or API token; answered while locked.
- **Answer:** `{ pin: boolean, locked: boolean, lockedAt: string|null, settings: { delayMinutes, background, clock }, image: string|null, … }`
- **Since:** 0.1.0-pre.29

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/lock"
```

#### `POST /api/lock`

Lock this session now.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); answered while locked. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ reason?: 'owner'|'idle', idleForMs?: number }`
- **Answer:** `the lock state`
- **Errors:** 409 no PIN is set, or the client is not covered by the lock screen
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/lock"
```

#### `GET /api/lock/screen`

What the lock screen draws: the time, counts waiting (approvals, and everything else that needs the owner as `needs`), the focus line, its widgets.

- **Auth:** Session or API token; answered while locked.
- **Query:** `hour?: number`
- **Answer:** `{ timezone, clockView, background, image, focus, approvals, needs, widgets: [{ key, id, title, size, view: { state: 'ok'|'stale'|'empty', body, updatedAt?: string, error?: string } }], … }`
- **Since:** 0.1.0-pre.29

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/lock/screen"
```

#### `POST /api/lock/unlock`

Unlock with the PIN.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); answered while locked. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ pin: string }  // four to eight digits`
- **Answer:** `the lock state`
- **Errors:** 400 not a PIN; 403 wrong PIN; 429 wait before trying again
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"pin":"…"}' "$BUDDI_URL/api/lock/unlock"
```

#### `POST /api/lock/activity`

The page saying the owner is using it, which pushes back the idle lock.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `204`
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/lock/activity"
```

#### `PUT /api/lock/pin`

Set or change the PIN.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ pin: string, current?: string }  // current when one is set`
- **Answer:** `the lock state`
- **Errors:** 400 not a PIN, or the current PIN missing; 403 wrong current PIN
- **Since:** 0.1.0-pre.29

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"pin":"…"}' "$BUDDI_URL/api/lock/pin"
```

#### `POST /api/lock/pin/remove`

Remove the PIN.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ current: string }`
- **Answer:** `the lock state`
- **Errors:** 400; 403 wrong PIN
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"current":"…"}' "$BUDDI_URL/api/lock/pin/remove"
```

#### `PUT /api/lock/settings`

Lock after, background and clock.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ delayMinutes?: 1|5|15|60|null, background?: string, clock?: { time, date, zone } }`
- **Answer:** `the lock state`
- **Errors:** 400 a value out of range, or a picture:<id> not in backgrounds/manifest.json; 409 the picture background with no picture
- **Since:** 0.1.0-pre.29

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/lock/settings"
```

#### `GET /api/lock/background`

The lock screen's own picture, as JPEG.

- **Auth:** Session or API token; answered while locked.
- **Kind:** bytes, not JSON
- **Answer:** `image/jpeg, with an ETag`
- **Errors:** 404 there is no picture
- **Since:** 0.1.0-pre.29

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/lock/background" -o out
```

#### `POST /api/lock/background`

Upload the lock screen picture.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Kind:** an upload
- **Body:** `multipart/form-data with one image file, at most 10 MB`
- **Answer:** `the lock state`
- **Errors:** 413 too large; 415 not a picture
- **Since:** 0.1.0-pre.29

```sh
curl -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -F "file=@./file" "$BUDDI_URL/api/lock/background"
```

#### `DELETE /api/lock/background`

Remove the lock screen picture and its portrait version (the background goes back to a built-in one).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `the lock state`
- **Since:** 0.1.0-pre.29

```sh
curl -X DELETE -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/lock/background"
```

#### `GET /api/lock/background/portrait`

The portrait version of the lock screen's own picture, drawn on a phone, as JPEG.

- **Auth:** Session or API token; answered while locked.
- **Kind:** bytes, not JSON
- **Answer:** `image/jpeg, with an ETag`
- **Errors:** 404 there is none
- **Since:** 0.1.0-pre.44

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/lock/background/portrait" -o out
```

#### `POST /api/lock/background/portrait`

Upload a portrait version of the lock screen picture for phones.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Kind:** an upload
- **Body:** `multipart/form-data with one image file, at most 10 MB`
- **Answer:** `the lock state`
- **Errors:** 409 no picture yet; 413 too large; 415 not a picture
- **Since:** 0.1.0-pre.44

```sh
curl -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -F "file=@./file" "$BUDDI_URL/api/lock/background/portrait"
```

#### `DELETE /api/lock/background/portrait`

Remove the portrait version (phones show the picture itself).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `the lock state`
- **Since:** 0.1.0-pre.44

```sh
curl -X DELETE -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/lock/background/portrait"
```

#### `GET /api/access`

Sign in from elsewhere: every trusted access provider (Tailscale, Cloudflare Access) with its status in one line, and whether this request came through one (the block is then read-only).

- **Auth:** Session or API token.
- **Answer:** `{ proxied: boolean, providers: [{ id: 'tailscale'|'cloudflare-access', title, identity: 'login'|'device', proxy: 'this-machine'|'elsewhere', enabled: boolean, status: { state: 'off'|'needs-setup'|'waiting'|'ready'|'unanswered', sentence } }] }`
- **Since:** 0.1.0-pre.38

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/access"
```

#### `GET /api/access/tailscale`

Tailscale sign-in: the stored setting, the daemon, and the command that serves this dashboard on the tailnet.

- **Auth:** Session or API token.
- **Answer:** `{ enabled: boolean, login: string, available: boolean, self: { login, name }|null, proxied: boolean, serveCommand: string }`
- **Since:** 0.1.0-pre.38

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/access/tailscale"
```

#### `PUT /api/access/tailscale`

Turn Tailscale sign-in on or off, for one login. Every Tailscale session ends.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ enabled: boolean, login?: string }`
- **Answer:** `as GET`
- **Errors:** 400 not a Tailscale login; 403 not from the computer buddi runs on
- **Since:** 0.1.0-pre.38

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"enabled":true}' "$BUDDI_URL/api/access/tailscale"
```

#### `GET /api/access/cloudflare-access`

Cloudflare Access sign-in: the stored fields, the status, the setup steps with the ingress port cloudflared must point at, and the last verified visit.

- **Auth:** Session or API token.
- **Answer:** `{ enabled, teamDomain, aud, email, publicOrigin, status: { state, sentence }, ingressPort: number, listening: boolean, lastVisit: { at, email }|null, setup: { steps: [{ text, command? }], fields: [{ key, label, hint?, placeholder? }] }, proxied: boolean }`
- **Since:** 0.1.0-pre.38

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/access/cloudflare-access"
```

#### `PUT /api/access/cloudflare-access`

Save Cloudflare Access sign-in: the team domain, the application AUD tag, the one allowed email and the public address. Binds or closes the ingress listener and fetches the team's signing keys once; sessions it admitted end unless the same person, team and application stay on.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ enabled: boolean, teamDomain: string, aud: string, email: string, publicOrigin: string }`
- **Answer:** `as GET, plus test: { ok, keys, error? } when on`
- **Errors:** 400 a field that is not what it should be, or a field missing to turn it on; 403 not from the computer buddi runs on
- **Since:** 0.1.0-pre.38

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"enabled":true,"teamDomain":"…","aud":"…","email":"…","publicOrigin":"…"}' "$BUDDI_URL/api/access/cloudflare-access"
```

#### `POST /api/access/cloudflare-access/test`

"Test my setup": fetch the signing keys of the team domain given (or the stored one) and say what came back. Nothing is stored.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ teamDomain?: string }`
- **Answer:** `{ ok: boolean, keys: number, teamDomain, sentence, listening: boolean, ingressPort: number|null }`
- **Errors:** 400 not a Cloudflare team domain; 403 not from the computer buddi runs on
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/access/cloudflare-access/test"
```

#### `GET /api/access/cloudflare-access/setup`

"Set it up for me": the run in progress (or the last one), whether a Cloudflare API token is kept, what buddi made last time, the token permissions to ask for and the ingress port. The install line in `progress.install` holds the tunnel's connector token.

- **Auth:** Session or API token; from the computer buddi runs on.
- **Answer:** `{ progress: { state: 'idle'|'running'|'waiting'|'done'|'failed'|'stopped'|'removing'|'removed', host, email, steps: [{ id, state: 'next'|'now'|'done'|'failed', text, why? }], install: { command, note }|null, error, url, removed: string[], uninstall, adoptable: boolean }, tokenStored: boolean, record: { host, email, zone, teamDomain }|null, permissions: string[], tokenUrl: string, ingressPort: number }`
- **Errors:** 403 not from the computer buddi runs on
- **Since:** 0.1.0-pre.38

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/access/cloudflare-access/setup"
```

#### `POST /api/access/cloudflare-access/setup`

Start "Set it up for me": with the API token (kept as the owner secret CLOUDFLARE_API_TOKEN; omit it to use the kept one), buddi finds the zone, creates (or reuses what it made before) the tunnel buddi-<host>, its ingress, the DNS record, the Access policy and application, fills in Cloudflare Access sign-in, shows the service install line, waits for the tunnel and runs the test. Poll GET for progress. An object of buddi's name that buddi did not make stops the run with `progress.adoptable`; `adopt: true` uses it anyway.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ token?: string, host: string, email: string, zone?: string, adopt?: boolean }`
- **Answer:** `202, as GET`
- **Errors:** 400 a hostname, email or token that is not one, or no token kept; 403 not from the computer buddi runs on; 409 a setup or removal already going, or the vault refused the token
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"host":"…","email":"…"}' "$BUDDI_URL/api/access/cloudflare-access/setup"
```

#### `POST /api/access/cloudflare-access/zones`

Check a Cloudflare API token (omit it to use the kept one) and list the domains (zones) it can see, for the setup form's domain choice. The pasted token is not kept and never echoed.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ token?: string }`
- **Answer:** `{ zones: [{ id, name }] }`
- **Errors:** 400 a token Cloudflare refuses, one that cannot list domains (Zone · DNS · Edit missing), or no token kept or given; 403 not from the computer buddi runs on; 502 Cloudflare unreachable or failing
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/access/cloudflare-access/zones"
```

#### `POST /api/access/cloudflare-access/setup/stop`

Stop waiting for the tunnel. What buddi made stays; a new run picks it up.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `as GET`
- **Errors:** 403 not from the computer buddi runs on; 409 a removal going
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/access/cloudflare-access/setup/stop"
```

#### `POST /api/access/cloudflare-access/setup/remove`

Remove what "Set it up for me" made — the Access application and policy, the DNS record and the tunnel, only those whose ids buddi recorded making — turn Cloudflare Access sign-in off when setup filled it in. The token stays kept (`tokenStored`) until forgotten.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ token?: string, host?: string }`
- **Answer:** `as GET; progress.removed lists what went, progress.error what did not`
- **Errors:** 400 no token kept or given; 403 not from the computer buddi runs on; 409 a setup or removal going
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/access/cloudflare-access/setup/remove"
```

#### `POST /api/access/cloudflare-access/setup/forget-token`

Forget the kept Cloudflare API token (drops the owner secret CLOUDFLARE_API_TOKEN). It stays valid in Cloudflare until revoked there (My Profile → API Tokens).

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `as GET, with tokenStored: false`
- **Errors:** 403 not from the computer buddi runs on; 409 a setup or removal going, or the vault refused
- **Since:** 0.1.0-pre.39

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/access/cloudflare-access/setup/forget-token"
```

#### `GET /api/tailscale`

Alias of GET /api/access/tailscale, kept for one release.

- **Auth:** Session or API token.
- **Answer:** `{ enabled: boolean, login: string, available: boolean, self: { login, name }|null, proxied: boolean, serveCommand: string }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tailscale"
```

#### `PUT /api/tailscale`

Alias of PUT /api/access/tailscale, kept for one release.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ enabled: boolean, login?: string }`
- **Answer:** `as GET`
- **Errors:** 400 not a Tailscale login; 403 not from the computer buddi runs on
- **Since:** 0.1.0-pre.15

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"enabled":true}' "$BUDDI_URL/api/tailscale"
```

### API tokens

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/api-tokens` | The owner API tokens: name, last four characters, when made and last used. Never the token. | no |
| POST | `/api/api-tokens` | Make a token. The answer is the only time the token itself is shown. | no |
| DELETE | `/api/api-tokens/:id` | Revoke a token. A request carrying it is refused from the next one on. | no |

#### `GET /api/api-tokens`

The owner API tokens: name, last four characters, when made and last used. Never the token.

- **Auth:** Dashboard session only. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `{ tokens: Array<{ id, name, hint: string, scope: 'owner', createdVia: 'dashboard'|'cli', createdAt, lastUsedAt: string|null }> }`
- **Since:** 0.1.0-pre.29

```sh
curl -b cookies.txt "$BUDDI_URL/api/api-tokens"
```

#### `POST /api/api-tokens`

Make a token. The answer is the only time the token itself is shown.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ name: string }  // 1 to 60 characters`
- **Answer:** `201 { token: string, apiToken: { id, name, hint, … } }`
- **Errors:** 400 no name, or too long; 409 the limit of 20 live tokens
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"name":"…"}' "$BUDDI_URL/api/api-tokens"
```

#### `DELETE /api/api-tokens/:id`

Revoke a token. A request carrying it is refused from the next one on.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `204`
- **Errors:** 404 no live token with that id
- **Since:** 0.1.0-pre.29

```sh
curl -X DELETE -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/api-tokens/<id>"
```

### Home

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/overview` | Home's whole first read: plugin blocks and glances, and counts of approvals, jobs, missions, reminders, watchers. | yes |
| GET | `/api/tips` | Every tip and its state. | yes |
| GET | `/api/tips/current` | Today's tip on Home, if any (picking one is remembered). | yes |
| GET | `/api/tips/queue` | The stack the lightbulb on Home opens: today's tip first, then every other one that holds and is not dismissed, ready ones before those in their cooldown (picking the first is remembered). | yes |
| GET | `/api/tips/dismissed` | The dismissed tips the queue counts, for the empty stack's "Bring back" list. | yes |
| POST | `/api/tips/seen-page` | Record that a page was opened (tips about it stop). | yes |
| POST | `/api/tips/:id/dismiss` | Never show this tip again. | yes |
| POST | `/api/tips/:id/later` | Show this tip another day. | yes |
| POST | `/api/tips/:id/restore` | Bring a dismissed tip back. | yes |
| GET | `/api/widgets` | The widget gallery, the layout and each placed widget’s body. | yes |
| PUT | `/api/widgets/home` | Save Home's widget layout. | yes |
| PUT | `/api/widgets/lock` | Save the lock screen's widgets (up to four). | yes |
| GET | `/api/widgets/settings/:widget` | A widget's settings schema. | yes |
| POST | `/api/widgets/preview` | One widget’s body with settings not yet saved. | yes |
| POST | `/api/widgets/:placement/refresh` | Produce one placed widget again, now. | yes |
| POST | `/api/home/glances/:id/hidden` | Hide a Home glance or show it again. | yes |
| POST | `/api/home/dismiss` | Close one thing on Home until it changes, or show it again. | yes |
| GET | `/api/rail` | Which plugin pages the owner hid from the rail. | yes |
| POST | `/api/rail/pages/:plugin/:page/hidden` | Hide a plugin page from the rail or show it again. | yes |
| GET | `/api/events` | The event log, newest first, paged. | yes |
| GET | `/api/events/kinds` | Every event kind in the log, with its count. | yes |
| POST | `/api/pause` | Pause or resume the installation: nothing new is claimed while paused. | yes |

#### `GET /api/overview`

Home's whole first read: plugin blocks and glances, and counts of approvals, jobs, missions, reminders, watchers.

- **Auth:** Session or API token.
- **Answer:** `{ now, timezone, paused, home: HomeBlock[], glances, approvals: { pending, oldestPendingAt }, jobs: Record<state, number>, missions, reminders, sentinels, mail, running, needsYou: { approvals, questions, urgent, failed, proposals, asks, agentsToSetUp, signIns, recovery, total } }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/overview"
```

#### `GET /api/tips`

Every tip and its state.

- **Auth:** Session or API token.
- **Answer:** `{ tips: Tip[] }`
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips"
```

#### `GET /api/tips/current`

Today's tip on Home, if any (picking one is remembered).

- **Auth:** Session or API token.
- **Query:** `preview?: tip id  // show one as it would look, touching nothing`
- **Answer:** `{ tip: Tip|null }`
- **Errors:** 404 no tip by the preview id
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips/current"
```

#### `GET /api/tips/queue`

The stack the lightbulb on Home opens: today's tip first, then every other one that holds and is not dismissed, ready ones before those in their cooldown (picking the first is remembered).

- **Auth:** Session or API token.
- **Query:** `preview?: tip ids, comma-separated  // stack those as they would look, touching nothing; peek?: '1'  // today's and the ready ones only, marking nothing shown`
- **Answer:** `{ tips: Tip[], dismissed: number }`
- **Errors:** 404 no tip by a preview id
- **Since:** 0.1.0-pre.45

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips/queue"
```

#### `GET /api/tips/dismissed`

The dismissed tips the queue counts, for the empty stack's "Bring back" list.

- **Auth:** Session or API token.
- **Answer:** `{ tips: Tip[] }`
- **Since:** 0.1.0-pre.45

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips/dismissed"
```

#### `POST /api/tips/seen-page`

Record that a page was opened (tips about it stop).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ page: string }`
- **Answer:** `{ ok: true }`
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"page":"…"}' "$BUDDI_URL/api/tips/seen-page"
```

#### `POST /api/tips/:id/dismiss`

Never show this tip again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ ok: true }`
- **Errors:** 404 no such tip
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips/<id>/dismiss"
```

#### `POST /api/tips/:id/later`

Show this tip another day.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ ok: true }`
- **Errors:** 404 no such tip
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips/<id>/later"
```

#### `POST /api/tips/:id/restore`

Bring a dismissed tip back.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ ok: true }`
- **Errors:** 404 no such tip
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/tips/<id>/restore"
```

#### `GET /api/widgets`

The widget gallery, the layout and each placed widget’s body.

- **Auth:** Session or API token.
- **Query:** `surface?: 'home'|'lock', hour?: number`
- **Answer:** `{ gallery, placed: Array<{ id, widget, size, body, updatedAt, … }>, … }`
- **Since:** 0.1.0-pre.29

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/widgets"
```

#### `PUT /api/widgets/home`

Save Home's widget layout.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ placements: Array<{ key?, widget, size: 'small'|'medium', settings? }> }`
- **Answer:** `the widgets view`
- **Errors:** 400 an unknown widget or a bad setting
- **Since:** 0.1.0-pre.29

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"placements":[]}' "$BUDDI_URL/api/widgets/home"
```

#### `PUT /api/widgets/lock`

Save the lock screen's widgets (up to four).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `as /api/widgets/home`
- **Answer:** `the widgets view`
- **Errors:** 400
- **Since:** 0.1.0-pre.29

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/widgets/lock"
```

#### `GET /api/widgets/settings/:widget`

A widget's settings schema.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404 no such widget
- **Since:** 0.1.0-pre.29

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/widgets/settings/<widget>"
```

#### `POST /api/widgets/preview`

One widget’s body with settings not yet saved.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ widget: string, settings?: object, size? }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"widget":"…"}' "$BUDDI_URL/api/widgets/preview"
```

#### `POST /api/widgets/:placement/refresh`

Produce one placed widget again, now.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Query:** `surface?: 'home'|'lock', hour?: number`
- **Answer:** `the widgets view`
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/widgets/<placement>/refresh"
```

#### `POST /api/home/glances/:id/hidden`

Hide a Home glance or show it again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ hidden: boolean }`
- **Answer:** JSON
- **Errors:** 404 no such glance
- **Since:** 0.1.0-pre.23

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"hidden":true}' "$BUDDI_URL/api/home/glances/<id>/hidden"
```

#### `POST /api/home/dismiss`

Close one thing on Home until it changes, or show it again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ slot: string, token: string | null }`
- **Answer:** `{ dismissed: Record<slot, token> }`
- **Errors:** 400
- **Since:** 0.1.0-pre.31

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"slot":"…","token":"…"}' "$BUDDI_URL/api/home/dismiss"
```

#### `GET /api/rail`

Which plugin pages the owner hid from the rail.

- **Auth:** Session or API token.
- **Answer:** `{ hidden: Array<{ plugin, page }> }`
- **Since:** 0.1.0-pre.23

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/rail"
```

#### `POST /api/rail/pages/:plugin/:page/hidden`

Hide a plugin page from the rail or show it again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ hidden: boolean }`
- **Answer:** JSON
- **Errors:** 404 no such page
- **Since:** 0.1.0-pre.23

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"hidden":true}' "$BUDDI_URL/api/rail/pages/<plugin>/<page>/hidden"
```

#### `GET /api/events`

The event log, newest first, paged.

- **Auth:** Session or API token.
- **Query:** `kind?, q?: text in the payload, since?: event id, before?: event id, limit?: 1–500 (100)`
- **Answer:** `{ events: Array<{ id, kind, conversationId, payload, createdAt }>, nextCursor: string|null, latest: string|null }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/events"
```

#### `GET /api/events/kinds`

Every event kind in the log, with its count.

- **Auth:** Session or API token.
- **Answer:** `{ kinds: Array<{ kind, count }> }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/events/kinds"
```

#### `POST /api/pause`

Pause or resume the installation: nothing new is claimed while paused.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ paused: boolean }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"paused":true}' "$BUDDI_URL/api/pause"
```

### Chat

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/chat/agents` | The agents a chat can be with, with their pictures, and the commands plugins add to the composer. | yes |
| POST | `/api/quiet` | `/quiet` from the composer: no proactive messages for a while (7 days by default), or `off`. | yes |
| GET | `/api/chat/attention` | Which agents are waiting on the owner, and why. | yes |
| GET | `/api/chat/attention/stream` | Server-sent events: one empty frame whenever /api/chat/attention would answer differently. | yes |
| GET | `/api/chat/views` | How installed plugins want their tool output drawn. | yes |
| GET | `/api/chat/:agent/conversations` | An agent's conversations, newest first. | yes |
| POST | `/api/chat/:agent/conversations` | Start a new conversation with an agent. | yes |
| POST | `/api/chat/:agent/messages` | Send a message. The turn is accepted, not answered: follow the conversation stream for the reply. | yes |
| GET | `/api/chat/conversations/:id` | A conversation’s transcript: messages, tool calls, runs. | yes |
| GET | `/api/chat/conversations/:id/stream` | Server-sent events for one conversation: messages, tool calls, approvals, the run ending. | yes |
| POST | `/api/chat/conversations/:id/cancel` | Stop the run in progress (a group’s current request, in a group). | yes |
| DELETE | `/api/chat/conversations/:id/carry-over` | Drop the note a rollover carried into this conversation; it leaves every later turn’s context. | yes |
| GET | `/api/chat/conversations/:id/canvas-tabs` | The canvas tabs the owner closed in this conversation, and when each tab was last looked at (their order). | yes |
| PUT | `/api/chat/conversations/:id/canvas-tabs` | Replace this conversation’s canvas tab state. The newest 200 of each half are kept. | yes |
| POST | `/api/chat/questions/:id/answer` | Answer a question an agent asked in the chat. | yes |
| POST | `/api/chat/attachments` | Upload a file for the next message. | yes |
| GET | `/api/conversations` | Every conversation, newest first (Activity). | yes |
| GET | `/api/conversations/:id` | One conversation as Activity shows it. | yes |

#### `GET /api/chat/agents`

The agents a chat can be with, with their pictures, and the commands plugins add to the composer.

- **Auth:** Session or API token.
- **Answer:** `{ agents: Array<{ id, name, handle, avatar, … }>, default: string, commands: Array<{ plugin, name, description, args? }> }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/agents"
```

#### `POST /api/quiet`

`/quiet` from the composer: no proactive messages for a while (7 days by default), or `off`.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ arg?: "" | "1d" | "1w" | "off" }`
- **Answer:** `{ text }  // the sentence to show, the same one Telegram and the terminal say`
- **Since:** 0.1.0-pre.37

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/quiet"
```

#### `GET /api/chat/attention`

Which agents are waiting on the owner, and why.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/attention"
```

#### `GET /api/chat/attention/stream`

Server-sent events: one empty frame whenever /api/chat/attention would answer differently.

- **Auth:** Session or API token.
- **Kind:** server-sent events (text/event-stream)
- **Query:** `since?: event id (or Last-Event-ID)`
- **Answer:** JSON
- **Errors:** 429 too many open streams for this session
- **Since:** 0.1.0-pre.15

```sh
curl -N -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/attention/stream"
```

#### `GET /api/chat/views`

How installed plugins want their tool output drawn.

- **Auth:** Session or API token.
- **Answer:** `{ views: ViewMapping[] }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/views"
```

#### `GET /api/chat/:agent/conversations`

An agent's conversations, newest first.

- **Auth:** Session or API token.
- **Query:** `limit?: number`
- **Answer:** `{ conversations: Array<{ id, startedAt, lastMessageAt, messageCount, opening }> }`
- **Errors:** 404 no such agent
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/<agent>/conversations"
```

#### `POST /api/chat/:agent/conversations`

Start a new conversation with an agent.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ conversationId: string }`
- **Errors:** 404 no such agent; 503 chat is not running in this process
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/<agent>/conversations"
```

#### `POST /api/chat/:agent/messages`

Send a message. The turn is accepted, not answered: follow the conversation stream for the reply.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ text: string, conversationId?: string, attachmentIds?: string[], client?: string }`
- **Answer:** `202 { conversationId, runId, queued?: true, pendingId? }  // queued: the agent was working and took it as an interjection`
- **Errors:** 400 a field of the wrong type; 404 no such agent; 503 chat is not running
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"text":"…"}' "$BUDDI_URL/api/chat/<agent>/messages"
```

#### `GET /api/chat/conversations/:id`

A conversation’s transcript: messages, tool calls, runs.

- **Auth:** Session or API token.
- **Answer:** `{ id, agentId, messages, runs, usage, carryOver?, … }`
- **Errors:** 404 no such conversation
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<id>"
```

#### `GET /api/chat/conversations/:id/stream`

Server-sent events for one conversation: messages, tool calls, approvals, the run ending.

- **Auth:** Session or API token.
- **Kind:** server-sent events (text/event-stream)
- **Query:** `since?: event id (or Last-Event-ID)`
- **Answer:** JSON
- **Errors:** 404 no such conversation; 429 too many open streams
- **Since:** 0.1.0-pre.15

```sh
curl -N -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<id>/stream"
```

#### `POST /api/chat/conversations/:id/cancel`

Stop the run in progress (a group’s current request, in a group).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ cancelled: boolean } or { stopped: true }`
- **Errors:** 503 chat is not running
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<id>/cancel"
```

#### `DELETE /api/chat/conversations/:id/carry-over`

Drop the note a rollover carried into this conversation; it leaves every later turn’s context.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `204`
- **Since:** 0.1.0-pre.28

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<id>/carry-over"
```

#### `GET /api/chat/conversations/:id/canvas-tabs`

The canvas tabs the owner closed in this conversation, and when each tab was last looked at (their order).

- **Auth:** Session or API token.
- **Answer:** `{ closed: string[], touched: Record<tabId, epochMs> }`
- **Since:** 0.1.0-pre.46

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<id>/canvas-tabs"
```

#### `PUT /api/chat/conversations/:id/canvas-tabs`

Replace this conversation’s canvas tab state. The newest 200 of each half are kept.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ closed: string[], touched: Record<tabId, epochMs> }`
- **Answer:** `the state as stored`
- **Errors:** 400 a field of the wrong shape
- **Since:** 0.1.0-pre.46

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"closed":[],"touched":{}}' "$BUDDI_URL/api/chat/conversations/<id>/canvas-tabs"
```

#### `POST /api/chat/questions/:id/answer`

Answer a question an agent asked in the chat.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ answer: string, optionId?: string } or { skipped: true }`
- **Answer:** `202`
- **Errors:** 400; 404 no open question; 409 already answered
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/questions/<id>/answer"
```

#### `POST /api/chat/attachments`

Upload a file for the next message.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Kind:** an upload
- **Query:** `conversationId?: string`
- **Body:** `multipart/form-data with one file, at most 20 MB`
- **Answer:** `{ artifactId, filename, mime, kind, sizeBytes }`
- **Errors:** 413 too large; 503 attachments unavailable
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" -F "file=@./file" "$BUDDI_URL/api/chat/attachments"
```

#### `GET /api/conversations`

Every conversation, newest first (Activity).

- **Auth:** Session or API token.
- **Query:** `limit?: number (50)`
- **Answer:** `{ conversations: Array<{ id, agentId, createdAt, messageCount, lastMessageAt, opening, runs, usage }> }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/conversations"
```

#### `GET /api/conversations/:id`

One conversation as Activity shows it.

- **Auth:** Session or API token.
- **Answer:** `{ id, agentId, createdAt, messages, runs, usage }`
- **Errors:** 404 no such conversation
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/conversations/<id>"
```

### Groups

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/groups` | The groups. | yes |
| POST | `/api/groups` | Make a group. | yes |
| GET | `/api/groups/:id` | One group: who is in it, its latest conversation and request. | yes |
| PATCH | `/api/groups/:id` | Rename, change the coordinator, or change who is in it; what is left out stays. | yes |
| DELETE | `/api/groups/:id` | Delete a group. Undo works for a minute. | yes |
| POST | `/api/groups/:id/restore` | Undo a delete, within the minute. | yes |
| POST | `/api/groups/:id/archive` | Archive a group. | yes |
| POST | `/api/groups/:id/clear` | Clear the group's history; members and memory stay. | yes |
| GET | `/api/groups/:id/conversations` | A group's conversations. | yes |
| POST | `/api/groups/:id/conversations` | Start a new conversation in a group. | yes |
| POST | `/api/groups/:id/messages` | Send a message to a group (its coordinator answers). | yes |

#### `GET /api/groups`

The groups.

- **Auth:** Session or API token.
- **Answer:** `{ groups: Array<{ id, name, coordinator, members, … }> }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups"
```

#### `POST /api/groups`

Make a group.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ name: string, coordinator: agent id, members: agent id[] }`
- **Answer:** `the group`
- **Errors:** 400 a missing name, an unknown agent, or fewer than two agents
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"name":"…","coordinator":"…","members":[]}' "$BUDDI_URL/api/groups"
```

#### `GET /api/groups/:id`

One group: who is in it, its latest conversation and request.

- **Auth:** Session or API token.
- **Answer:** `{ …group, latestConversationId, openRequest, history: { conversations, messages } }`
- **Errors:** 404 no such group
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>"
```

#### `PATCH /api/groups/:id`

Rename, change the coordinator, or change who is in it; what is left out stays.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ name?: string, coordinator?: agent id, members?: agent id[] }`
- **Answer:** `the group`
- **Errors:** 400; 404 no such group
- **Since:** 0.1.0-pre.15

```sh
curl -X PATCH -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/groups/<id>"
```

#### `DELETE /api/groups/:id`

Delete a group. Undo works for a minute.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ undoUntil: string }`
- **Errors:** 404 no such group
- **Since:** 0.1.0-pre.15

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>"
```

#### `POST /api/groups/:id/restore`

Undo a delete, within the minute.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `the group`
- **Errors:** 410 too late
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>/restore"
```

#### `POST /api/groups/:id/archive`

Archive a group.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `204`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>/archive"
```

#### `POST /api/groups/:id/clear`

Clear the group's history; members and memory stay.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ conversations: number }`
- **Errors:** 404
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>/clear"
```

#### `GET /api/groups/:id/conversations`

A group's conversations.

- **Auth:** Session or API token.
- **Answer:** `{ conversations: Array<{ id, startedAt, lastMessageAt, messageCount, opening }> }`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>/conversations"
```

#### `POST /api/groups/:id/conversations`

Start a new conversation in a group.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ conversationId }`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/groups/<id>/conversations"
```

#### `POST /api/groups/:id/messages`

Send a message to a group (its coordinator answers).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ text: string, conversationId?: string, attachmentIds?: string[] }`
- **Answer:** `202 { conversationId, runId, requestId, rolledOver? }`
- **Errors:** 400; 404; 503 chat is not running
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"text":"…"}' "$BUDDI_URL/api/groups/<id>/messages"
```

### Agents

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/agents` | Every agent, their engines, the model accounts, which agent is the default, and which came from the catalogue (package, version, the listed version, drift, delisted; read from the kept list, never fetched). | yes |
| POST | `/api/agents/default` | Make an agent the default (where a chat that names nobody lands). | yes |
| GET | `/api/agents/:id/profile` | One agent whole: its grant with every tool's tier, engine, skills, delegates. | yes |
| GET | `/api/agents/:id/intro` | A new agent's first-open strip in its chat: whether it is still due, whom the agent may ask and who may ask it. | yes |
| POST | `/api/agents/:id/intro/dismiss` | Close a new agent's first-open strip for good. | yes |
| GET | `/api/agents/:id/skills` | Every skill the agent loads; learned ones with their versions. | yes |
| POST | `/api/agents/:id/skills/:skill/remove` | Remove a learned skill (its versions are kept). | yes |
| GET | `/api/skills` | The Skills page: every skill on this computer, grouped yours / learned / from plugins / from the catalogue, with who holds each. The shipped examples are not listed. | yes |
| POST | `/api/skills/bundles` | Read a skill bundle (.zip with SKILL.md, scripts/, assets/) before keeping it: streamed to a temporary folder, checked (20 MB unpacked, 500 files, SKILL.md with a description, no absolute paths, .., links or encrypted entries, nothing executable outside scripts/) and unpacked into staging. Nothing in it runs. | no |
| GET | `/api/skills/bundles/:staged/file` | One file of a staged upload, for the preview's viewer (?path=). | yes |
| GET | `/api/skills/bundles/:staged/image` | A picture in a staged upload (?path=), served under a CSP that runs nothing. | yes |
| POST | `/api/skills/bundles/:staged` | Keep a staged bundle: unpacked into the skills folder under its own directory, SKILL.md written in buddi's front matter (untrusted unless mine), the grant written in each agent's file, all checked by a catalog reload. | no |
| DELETE | `/api/skills/bundles/:staged` | Drop a staged upload nobody kept. | no |
| GET | `/api/skills/:id/file` | One of a bundle's files, for the sheet's viewer (?path=): its text, or its size when it is not text. | yes |
| GET | `/api/skills/:id/image` | A picture in a bundle (?path=), served under a CSP that runs nothing. | yes |
| POST | `/api/skills` | Write a new skill, or save one taken from a single .md (read in the browser): it goes in the owner's skills folder. An upload not marked as theirs is untrusted. | no |
| GET | `/api/skills/:id` | One skill whole: its row, its text, the file as written, a learned one's versions, a bundle's file tree, and what deleting it does. | yes |
| GET | `/api/skills/:id/download` | The skill as its .md file, or a bundle as a .zip with its files, as an attachment. | yes |
| POST | `/api/skills/:id/text` | Edit the text. A learned skill is saved as its next version, marked as the owner's correction; a catalogue one counts as an owner edit for its updates; a plugin's reads only. Who holds it and where it came from are not changed here. | no |
| POST | `/api/skills/:id/grants` | Who uses it: every agent, or the ones named, written in each agent's file (skills:) so the file stays the record. One in an agent's folder is always that agent's, and is given to others one by one. | no |
| POST | `/api/skills/:id/trust` | Mark as mine: an uploaded skill stops being read as outside text (a learned one loses its untrusted mark). | no |
| DELETE | `/api/skills/:id` | Delete a skill. The agents that asked for it stop (their skills: line loses it). A learned one's versions stay and it is not proposed again for 90 days; anything else goes to the trash folder. A plugin's goes with its plugin. | no |
| GET | `/api/agents/:id/tools` | Every installed tool, for the agent’s tool picker. | yes |
| GET | `/api/agents/:id/file` | The agent's file as written: front matter and persona. | yes |
| POST | `/api/agents/:id/file` | Edit the agent's front matter: name, handle, tools, persona…; checked as the loader checks it. | no |
| POST | `/api/agents/:id/delegates` | Which agents this one may hand work to. | no |
| POST | `/api/agents/:id/engine` | Change engine settings (effort, context, idle rollover, where it may look: browser auto/own/chrome/apps…). | yes |
| POST | `/api/agents/:id/account` | Put the agent on a model account and model. | yes |
| GET | `/api/agents/:id/avatar` | The agent's picture (PNG, or the file its front matter names). | yes |
| POST | `/api/agents/:id/avatar` | Upload a picture: PNG, GIF or SVG, at most 1 MB, made square. | yes |
| DELETE | `/api/agents/:id/avatar` | Remove the uploaded picture; the agent's icon is drawn again. | yes |
| GET | `/api/catalogue` | The agent catalogue from withbuddi.com, each package with where it stands here; fetched when stale, the kept copy offline. | yes |
| POST | `/api/catalogue/:name/plan` | What adding this agent would do, writing nothing: plugins installed on the way, picks with defaults and choices, the handle, tools with tiers, missions, the approval preview. | yes |
| POST | `/api/catalogue/:name/install` | Add this agent: missing by-buddi plugins are installed on the way, then the agent; the click is the approval of the plan shown (plan, for the same picks) or of the grant shown (tools). When neither is what resolves, the job stops at confirm. | no |
| GET | `/api/catalogue/jobs/:id` | An install job's progress. | yes |
| POST | `/api/catalogue/jobs/:id/confirm` | Answer a job stopped at confirm (the grant that resolved is not the one shown): yes adds the agent with it, no rejects the approval. | no |
| POST | `/api/catalogue/:name/update/plan` | The update sheet for an agent added from this package: changes, persona diff, tools added and removed, new missions, and whether the owner edited it. | yes |
| POST | `/api/catalogue/:name/update` | Update an agent from its package with the same picks; an edited file only with replace (the old file goes to the trash). The click is the approval. | no |
| GET | `/api/agents/:id/remove` | What removing this agent does: its missions paused, the plugins no other agent uses. Nothing changes. | yes |
| POST | `/api/agents/:id/remove` | Remove from team: the directory goes to the trash and its missions are paused. The click is the approval. | no |
| GET | `/api/agent-offers` | Agents a plugin offers while nobody has them. | yes |
| POST | `/api/agent-offers/:plugin/:agent/dismiss` | Stop offering this agent. | yes |

#### `GET /api/agents`

Every agent, their engines, the model accounts, which agent is the default, and which came from the catalogue (package, version, the listed version, drift, delisted; read from the kept list, never fetched).

- **Auth:** Session or API token.
- **Answer:** `{ agents: AgentView[], engines, providers, providerAccounts, default, catalogue: { [agentId]: { source, package, title, version, latest, drift, delisted, via? } } }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents"
```

#### `POST /api/agents/default`

Make an agent the default (where a chat that names nobody lands).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ agentId: string }`
- **Answer:** JSON
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"agentId":"…"}' "$BUDDI_URL/api/agents/default"
```

#### `GET /api/agents/:id/profile`

One agent whole: its grant with every tool's tier, engine, skills, delegates.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404 no such agent
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/profile"
```

#### `GET /api/agents/:id/intro`

A new agent's first-open strip in its chat: whether it is still due, whom the agent may ask and who may ask it.

- **Auth:** Session or API token.
- **Answer:** `{ show: false } | { show: true, id, handle, asks: 'everyone' | IntroAgent[], askedBy: IntroAgent[] }  // IntroAgent: { id, handle, name, frontDesk? }`
- **Errors:** 404
- **Since:** 0.1.0-pre.45

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/intro"
```

#### `POST /api/agents/:id/intro/dismiss`

Close a new agent's first-open strip for good.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ ok: true }`
- **Errors:** 404
- **Since:** 0.1.0-pre.45

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/intro/dismiss"
```

#### `GET /api/agents/:id/skills`

Every skill the agent loads; learned ones with their versions.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/skills"
```

#### `POST /api/agents/:id/skills/:skill/remove`

Remove a learned skill (its versions are kept).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404; 409 not a learned skill
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/skills/<skill>/remove"
```

#### `GET /api/skills`

The Skills page: every skill on this computer, grouped yours / learned / from plugins / from the catalogue, with who holds each. The shipped examples are not listed.

- **Auth:** Session or API token.
- **Answer:** `{ skills: SkillRow[], agents: [{ id, handle, name, writable }] } where SkillRow is { id (name, or agent/name for one in an agent's folder), name, title, description, group: mine|learned|plugin|catalogue, file, home: agent id | null, every, holders: [{ agent, how: home|every|filter|granted }], untrusted: upload|page|null, provenance, source, created, updatedAt, learned: { by, version, edited, keptAt } | null, from: { kind: plugin, plugin, version, installed } | { kind: catalogue, package, version, agent } | { kind: upload, filename } | null, editable, deletable, shareable, bundle: { files, scripts: path[], size } | null }; an agent's canRunScripts says it holds host.exec, which a bundle's scripts run through`
- **Since:** 0.1.0-pre.32

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills"
```

#### `POST /api/skills/bundles`

Read a skill bundle (.zip with SKILL.md, scripts/, assets/) before keeping it: streamed to a temporary folder, checked (20 MB unpacked, 500 files, SKILL.md with a description, no absolute paths, .., links or encrypted entries, nothing executable outside scripts/) and unpacked into staging. Nothing in it runs.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Kind:** an upload
- **Body:** `the .zip bytes; X-Filename header`
- **Answer:** `{ staged: { id, filename, packed, size, files: [{ path, size, kind: skill|script|font|image|template|data|other, setup? }], scripts, skill: { name, title, description, firstLines }, createdAt } }`
- **Errors:** 400; 413 too big; 415 not a .zip; 422 refused, with { error, refusal: { kind: notzip|big|count|noskill|paths|frontmatter|executable|damaged, filename, size?, files?, entries?: [{ path, why, target? }], looked? } }
- **Since:** 0.1.0-pre.37

```sh
curl -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -F "file=@./file" "$BUDDI_URL/api/skills/bundles"
```

#### `GET /api/skills/bundles/:staged/file`

One file of a staged upload, for the preview's viewer (?path=).

- **Auth:** Session or API token.
- **Answer:** `{ file: { path, size, kind, setup?, text? | binary: true, image? } }`
- **Errors:** 404
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills/bundles/<staged>/file"
```

#### `GET /api/skills/bundles/:staged/image`

A picture in a staged upload (?path=), served under a CSP that runs nothing.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** `image/*`
- **Errors:** 404
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills/bundles/<staged>/image" -o out
```

#### `POST /api/skills/bundles/:staged`

Keep a staged bundle: unpacked into the skills folder under its own directory, SKILL.md written in buddi's front matter (untrusted unless mine), the grant written in each agent's file, all checked by a catalog reload.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Body:** `{ every?: boolean, agents?: agent id[], mine?: boolean }`
- **Answer:** `201 { skill: SkillRow }`
- **Errors:** 400; 404 the upload is gone; 409 a shipped agent, or the catalog refused the result (nothing kept)
- **Since:** 0.1.0-pre.37

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/skills/bundles/<staged>"
```

#### `DELETE /api/skills/bundles/:staged`

Drop a staged upload nobody kept.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Answer:** `{ discarded }`
- **Since:** 0.1.0-pre.37

```sh
curl -X DELETE -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/skills/bundles/<staged>"
```

#### `GET /api/skills/:id/file`

One of a bundle's files, for the sheet's viewer (?path=): its text, or its size when it is not text.

- **Auth:** Session or API token.
- **Answer:** `{ file: { path, size, kind, setup?, text? | binary: true, image? } }`
- **Errors:** 404
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills/<id>/file"
```

#### `GET /api/skills/:id/image`

A picture in a bundle (?path=), served under a CSP that runs nothing.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** `image/*`
- **Errors:** 404
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills/<id>/image" -o out
```

#### `POST /api/skills`

Write a new skill, or save one taken from a single .md (read in the browser): it goes in the owner's skills folder. An upload not marked as theirs is untrusted.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Body:** `{ title, description, body, every?: boolean, agents?: agent id[], upload?: { filename: string (.md), mine?: boolean } }`
- **Answer:** `201 { skill: SkillRow }`
- **Errors:** 400 a field missing or the loader's sentence; 409 an agent that ships with buddi, or the catalog refused the result (nothing written); 413 over 50 KB; 415 not .md
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/skills"
```

#### `GET /api/skills/:id`

One skill whole: its row, its text, the file as written, a learned one's versions, a bundle's file tree, and what deleting it does.

- **Auth:** Session or API token.
- **Answer:** `{ skill: SkillRow, body, text, versions?: number[], bundle?: { files: [{ path, size, kind, setup? }], size, scripts }, onDelete: { stops: agent id[], every, then: trash|versions-kept|catalogue-asks }, agents }`
- **Errors:** 404
- **Since:** 0.1.0-pre.32

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills/<id>"
```

#### `GET /api/skills/:id/download`

The skill as its .md file, or a bundle as a .zip with its files, as an attachment.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** `text/markdown | application/zip`
- **Errors:** 404
- **Since:** 0.1.0-pre.32

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/skills/<id>/download" -o out
```

#### `POST /api/skills/:id/text`

Edit the text. A learned skill is saved as its next version, marked as the owner's correction; a catalogue one counts as an owner edit for its updates; a plugin's reads only. Who holds it and where it came from are not changed here.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Body:** `{ text: the whole file as the Source view shows it } | { body, description?, title? }`
- **Answer:** `{ skill: SkillRow, version?: number, ignored?: string[] }`
- **Errors:** 400; 404; 409 a plugin's skill, or the catalog refused the result (nothing written)
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"text":"…"}' "$BUDDI_URL/api/skills/<id>/text"
```

#### `POST /api/skills/:id/grants`

Who uses it: every agent, or the ones named, written in each agent's file (skills:) so the file stays the record. One in an agent's folder is always that agent's, and is given to others one by one.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Body:** `{ every?: boolean, agents: agent id[] }`
- **Answer:** `{ skill: SkillRow }`
- **Errors:** 400 an unknown agent; 404; 409 an agent that ships with buddi, a name the agent already has, or the catalog refused the result
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"agents":[]}' "$BUDDI_URL/api/skills/<id>/grants"
```

#### `POST /api/skills/:id/trust`

Mark as mine: an uploaded skill stops being read as outside text (a learned one loses its untrusted mark).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Answer:** `{ skill: SkillRow }`
- **Errors:** 404; 409
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/skills/<id>/trust"
```

#### `DELETE /api/skills/:id`

Delete a skill. The agents that asked for it stop (their skills: line loses it). A learned one's versions stay and it is not proposed again for 90 days; anything else goes to the trash folder. A plugin's goes with its plugin.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes the instructions an agent follows: a skill's text, who holds it, or whether it is read as the owner's.
- **Answer:** `{ deleted, stopped: agent id[], movedTo?: string, versionsKept?: string }`
- **Errors:** 404; 409 a plugin's skill while the plugin is installed, or a shipped agent's file needs it; 503 the database, for a learned one
- **Since:** 0.1.0-pre.32

```sh
curl -X DELETE -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/skills/<id>"
```

#### `GET /api/agents/:id/tools`

Every installed tool, for the agent’s tool picker.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/tools"
```

#### `GET /api/agents/:id/file`

The agent's file as written: front matter and persona.

- **Auth:** Session or API token.
- **Answer:** `{ id, file, frontmatter, persona }`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/file"
```

#### `POST /api/agents/:id/file`

Edit the agent's front matter: name, handle, tools, persona…; checked as the loader checks it.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `the editable front matter fields (packages/core ownerEditableInput)`
- **Answer:** JSON
- **Errors:** 400 with the loader’s sentence
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/agents/<id>/file"
```

#### `POST /api/agents/:id/delegates`

Which agents this one may hand work to.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `{ delegates: agent id[] }`
- **Answer:** JSON
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"delegates":[]}' "$BUDDI_URL/api/agents/<id>/delegates"
```

#### `POST /api/agents/:id/engine`

Change engine settings (effort, context, idle rollover, where it may look: browser auto/own/chrome/apps…).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `engine fields; the account and model go through /account`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/engine"
```

#### `POST /api/agents/:id/account`

Put the agent on a model account and model.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ accountId: string, model?: string }`
- **Answer:** JSON
- **Errors:** 400; 404; 503 accounts unavailable
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"accountId":"…"}' "$BUDDI_URL/api/agents/<id>/account"
```

#### `GET /api/agents/:id/avatar`

The agent's picture (PNG, or the file its front matter names).

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** `an image, with an ETag`
- **Errors:** 404 no picture
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/avatar" -o out
```

#### `POST /api/agents/:id/avatar`

Upload a picture: PNG, GIF or SVG, at most 1 MB, made square.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Kind:** an upload
- **Body:** `multipart/form-data with one image`
- **Answer:** `{ picture: string, side: number, source, note? }`
- **Errors:** 404; 413; 415
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" -F "file=@./file" "$BUDDI_URL/api/agents/<id>/avatar"
```

#### `DELETE /api/agents/:id/avatar`

Remove the uploaded picture; the agent's icon is drawn again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `204`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/avatar"
```

#### `GET /api/catalogue`

The agent catalogue from withbuddi.com, each package with where it stands here; fetched when stale, the kept copy offline.

- **Auth:** Session or API token.
- **Query:** `refresh?: 1`
- **Answer:** `{ fetchedAt, stale?, agents: [{ name, version, handle, title, pitch, description, about, category, trust, author, requires, optional, needs, tools, missions: [{ id, name, cron, when, prompt }], fills: [{ id, kind, label, optional, default }], examples, skills: [{ name, description, text }], changes, replaces, avatar, page, claims?, state: ready|needs|installed|unavailable, missing?: [{ kind: plugin, name, range, fix, title, listed, byBuddi } | { kind: need, name, fix }], installed?: { agentId, handle, version, drift: current|update|edited|edited-update, via? }, reason?, addable }], fromPlugins: [{ plugin, agent, handle, name, text, state }], delisted: [{ agentId, handle, name, package, version }], mailbox, problems?, unavailable? }`
- **Since:** 0.1.0-pre.32

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/catalogue"
```

#### `POST /api/catalogue/:name/plan`

What adding this agent would do, writing nothing: plugins installed on the way, picks with defaults and choices, the handle, tools with tiers, missions, the approval preview.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ fills?: { [id]: string }, handle?, missionsOn?: string[] }`
- **Answer:** `{ name, version, title, plugins: [{ name, title, version, byBuddi, fix }], blocked, plan?, id?, handle, fills: [{ id, kind, label, optional?, mission?, value, choices? }], tools: [{ name, tier, description }], missions: [{ id, name, cron, enabled, prompt }], account?, preview: string | null, note? } — plan: the fingerprint of exactly this plan (absent while a plugin is missing); tools: the package's own list while one is`
- **Errors:** 400 a pick or handle refused; 404; 409 already added or unavailable; 503 offline
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/catalogue/<name>/plan"
```

#### `POST /api/catalogue/:name/install`

Add this agent: missing by-buddi plugins are installed on the way, then the agent; the click is the approval of the plan shown (plan, for the same picks) or of the grant shown (tools). When neither is what resolves, the job stops at confirm.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Body:** `{ version, fills?, handle?, missionsOn?: string[], account?, plan?, tools?: string[] }`
- **Answer:** `202 { jobId }`
- **Errors:** 400; 404; 409 already added, the version moved, or something it needs is not here (blocked); 503 offline
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/catalogue/<name>/install"
```

#### `GET /api/catalogue/jobs/:id`

An install job's progress.

- **Auth:** Session or API token.
- **Answer:** `{ id, name, version, title, state: running|confirm|done|failed, steps: [{ kind: plugin|agent, name, title, state, reason? }], agent?: { id, handle, name }, approvalId?, confirm?: { tools: [{ name, tier, description }], unshown: string[], preview }, error?, startedAt, finishedAt? }`
- **Errors:** 404
- **Since:** 0.1.0-pre.32

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/catalogue/jobs/<id>"
```

#### `POST /api/catalogue/jobs/:id/confirm`

Answer a job stopped at confirm (the grant that resolved is not the one shown): yes adds the agent with it, no rejects the approval.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Body:** `{ approve: boolean }`
- **Answer:** `the job`
- **Errors:** 400; 404; 409 not waiting
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"approve":true}' "$BUDDI_URL/api/catalogue/jobs/<id>/confirm"
```

#### `POST /api/catalogue/:name/update/plan`

The update sheet for an agent added from this package: changes, persona diff, tools added and removed, new missions, and whether the owner edited it.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ agentId }`
- **Answer:** `{ plan, agentId, handle, name, title, fromVersion, version, changes, via, edited, replacesOwn: string[], retires: string[], widened, added: [{ name, tier, description }], removed, personaDiff: string[] (unified hunks: @@ -a,b +c,d @@ headers, then - removed, + added and two-space context lines), missionsAdded, preview }`
- **Errors:** 400; 409 already up to date
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/catalogue/<name>/update/plan"
```

#### `POST /api/catalogue/:name/update`

Update an agent from its package with the same picks; an edited file only with replace (the old file goes to the trash). The click is the approval.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Body:** `{ agentId, plan, replace?: true }`
- **Answer:** `{ approvalId, result }`
- **Errors:** 400 no plan; 409 edited without replace, up to date, or the plan moved (code plan-moved)
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/catalogue/<name>/update"
```

#### `GET /api/agents/:id/remove`

What removing this agent does: its missions paused, the plugins no other agent uses. Nothing changes.

- **Auth:** Session or API token.
- **Answer:** `{ id, handle, name, pausesMissions: [{ id, name }], unusedPlugins: string[], handedWorkBy: string[], preview }`
- **Errors:** 400
- **Since:** 0.1.0-pre.32

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agents/<id>/remove"
```

#### `POST /api/agents/:id/remove`

Remove from team: the directory goes to the trash and its missions are paused. The click is the approval.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Answer:** `{ approvalId, result: { id, movedTo, pausedMissions?, unusedPlugins?, delegateListsNotUpdated?: { id, handle }[], message } }`
- **Errors:** 400
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/agents/<id>/remove"
```

#### `GET /api/agent-offers`

Agents a plugin offers while nobody has them.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agent-offers"
```

#### `POST /api/agent-offers/:plugin/:agent/dismiss`

Stop offering this agent.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/agent-offers/<plugin>/<agent>/dismiss"
```

### Approvals, offers and proposals

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/approvals` | Approvals waiting on the owner, and recent decisions. | yes |
| GET | `/api/approvals/:id` | One action whole: the envelope the approval is bound to and the preview the tool rendered. | yes |
| POST | `/api/approvals/:id/approve` | Approve an action. | no |
| POST | `/api/approvals/:id/reject` | Reject an action. Saying no is never refused to a token. | yes |
| GET | `/api/offers` | What agents offered to do next. | yes |
| POST | `/api/offers/:id/take` | Take an offer: its run starts (here if the page has its conversation open). | yes |
| POST | `/api/offers/:id/dismiss` | Dismiss an offer. | yes |
| POST | `/api/offers/dismiss-all` | Dismiss several offers. | yes |
| GET | `/api/proposals` | What agents proposed to change (skills, rules), and the weekly digest. | yes |
| POST | `/api/proposals/:id/keep` | Keep a proposal: its change is applied. | no |
| POST | `/api/proposals/:id/discard` | Discard a proposal. | yes |
| POST | `/api/proposals/keep-all` | Keep a group of open rule proposals. | no |
| POST | `/api/proposals/digest-schedule` | The weekly digest's day and hour. | yes |

#### `GET /api/approvals`

Approvals waiting on the owner, and recent decisions.

- **Auth:** Session or API token.
- **Query:** `limit?: number (50)`
- **Answer:** `{ pending: ApprovalView[], recent: ApprovalView[] }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/approvals"
```

#### `GET /api/approvals/:id`

One action whole: the envelope the approval is bound to and the preview the tool rendered.

- **Auth:** Session or API token.
- **Answer:** `{ action: ApprovalView }`
- **Errors:** 404 no such action
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/approvals/<id>"
```

#### `POST /api/approvals/:id/approve`

Approve an action.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Body:** `{ permissionScope?: 'once'|'conversation'|'always', ownerChoices?: Record<string, string> }`
- **Answer:** JSON
- **Errors:** 400 a bad scope or choice; 404; 409 already decided or expired
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/approvals/<id>/approve"
```

#### `POST /api/approvals/:id/reject`

Reject an action. Saying no is never refused to a token.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404; 409 already decided or expired
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/approvals/<id>/reject"
```

#### `GET /api/offers`

What agents offered to do next.

- **Auth:** Session or API token.
- **Query:** `limit?: number`
- **Answer:** `{ offers: Offer[], … }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/offers"
```

#### `POST /api/offers/:id/take`

Take an offer: its run starts (here if the page has its conversation open).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ conversationId?: string }`
- **Answer:** JSON
- **Errors:** 404; 409 no longer open
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/offers/<id>/take"
```

#### `POST /api/offers/:id/dismiss`

Dismiss an offer.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/offers/<id>/dismiss"
```

#### `POST /api/offers/dismiss-all`

Dismiss several offers.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ ids: string[] }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"ids":[]}' "$BUDDI_URL/api/offers/dismiss-all"
```

#### `GET /api/proposals`

What agents proposed to change (skills, rules), and the weekly digest.

- **Auth:** Session or API token.
- **Answer:** `{ open, recent, digest: { latest, schedule } }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/proposals"
```

#### `POST /api/proposals/:id/keep`

Keep a proposal: its change is applied.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Body:** `{ text?: string }  // the edited text, when the owner edited it`
- **Answer:** JSON
- **Errors:** 404; 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/proposals/<id>/keep"
```

#### `POST /api/proposals/:id/discard`

Discard a proposal.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ reason?: string }`
- **Answer:** JSON
- **Errors:** 404; 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/proposals/<id>/discard"
```

#### `POST /api/proposals/keep-all`

Keep a group of open rule proposals.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Body:** `{ ids: string[] }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.28

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"ids":[]}' "$BUDDI_URL/api/proposals/keep-all"
```

#### `POST /api/proposals/digest-schedule`

The weekly digest's day and hour.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ day: 0–6, hour: 0–23 }`
- **Answer:** `{ schedule }`
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"day":0,"hour":0}' "$BUDDI_URL/api/proposals/digest-schedule"
```

### Missions, jobs, reminders and watchers

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/missions` | Every mission, its schedule, next run and recent occurrences. | yes |
| POST | `/api/missions/:id/enabled` | Switch a mission on or off. | yes |
| POST | `/api/missions/:id/browser` | For a mission that browses: let it use your signed-in Chrome while you are away (`chrome: true`), or keep it in buddi’s own browser. | no |
| POST | `/api/missions/:id/keep` | Keep an agent’s quiet watch after “Still useful?”: its count of silent runs starts again. | yes |
| POST | `/api/missions/:id/still-useful` | Answer “Still useful?” with Keep or Stop. The first answer from any surface decides; a later one changes nothing and says what was decided. | yes |
| POST | `/api/missions/:id/schedule` | Change a mission’s schedule (a new revision). | yes |
| GET | `/api/jobs` | The job queue, paged. `counts.failed` is the failed jobs still asking for the owner; `counts.dismissed` the ones dismissed or quiet after 14 days. | yes |
| GET | `/api/jobs/failures` | Failed jobs grouped by cause, each group with a plain reason and whether a retry is likely to work; the dismissed ones apart. | yes |
| POST | `/api/jobs/dismiss` | Dismiss failed jobs: kept on record, out of the footer count and the default view. | yes |
| POST | `/api/jobs/undismiss` | Take a dismissal back (Undo). | yes |
| POST | `/api/jobs/retry` | Retry failed jobs now, by ids, by cause group, or every one still asking. | yes |
| POST | `/api/jobs/:id/retry` | Retry a failed job. | yes |
| POST | `/api/jobs/:id/cancel` | Cancel a queued or failed job. | yes |
| GET | `/api/reminders` | Reminders agents set, pending and past. | yes |
| POST | `/api/reminders/:id/cancel` | Cancel a pending reminder. | yes |
| GET | `/api/sentinels` | Watchers: each one, whether it is on, its last run, and what they found as the owner reads it — decisions grouped, the recap counted, what he silenced. | yes |
| POST | `/api/sentinels/:id/enabled` | Switch a watcher off or on. | yes |
| POST | `/api/alerts/:key/snooze` | Snooze an open alert, or wake it. | yes |
| POST | `/api/alerts/snooze` | Snooze several alerts at once (Clear all), or wake them (its Undo). | yes |
| POST | `/api/alerts/mute` | "Stop telling me this": silence the alert's subject, or its whole kind. Reversible from Settings → Watchers. | yes |
| POST | `/api/alerts/mutes/:id/remove` | Take a "Stop telling me this" back. | yes |
| POST | `/api/alerts/act` | Run what an alert declared (a run, or a fill with the typed value), as the owner. Named by key and action index, never by tool; a gated tool answers its approval. | yes |
| POST | `/api/alerts/ask` | Ask the agent that answers for these alerts, handing it their briefs. The thread shows what was asked about. | yes |

#### `GET /api/missions`

Every mission, its schedule, next run and recent occurrences.

- **Auth:** Session or API token.
- **Answer:** `{ missions: MissionView[] }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/missions"
```

#### `POST /api/missions/:id/enabled`

Switch a mission on or off.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ enabled: boolean }`
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"enabled":true}' "$BUDDI_URL/api/missions/<id>/enabled"
```

#### `POST /api/missions/:id/browser`

For a mission that browses: let it use your signed-in Chrome while you are away (`chrome: true`), or keep it in buddi’s own browser.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `{ chrome: boolean }`
- **Answer:** `{ id, browser: 'own' | 'owner' }`
- **Errors:** 400; 404; 409 (it opens no page)
- **Since:** 0.1.0-pre.48

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"chrome":true}' "$BUDDI_URL/api/missions/<id>/browser"
```

#### `POST /api/missions/:id/keep`

Keep an agent’s quiet watch after “Still useful?”: its count of silent runs starts again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ id, enabled }`
- **Errors:** 404
- **Since:** 0.1.0-pre.32

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/missions/<id>/keep"
```

#### `POST /api/missions/:id/still-useful`

Answer “Still useful?” with Keep or Stop. The first answer from any surface decides; a later one changes nothing and says what was decided.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ answer: 'keep' | 'stop' }`
- **Answer:** `{ id, enabled, outcome }`
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.35

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"answer":"keep"}' "$BUDDI_URL/api/missions/<id>/still-useful"
```

#### `POST /api/missions/:id/schedule`

Change a mission’s schedule (a new revision).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ cron?: string, timezone?: string, misfirePolicy?: 'skip'|'run-once', deadlineMinutes?: number|null }`
- **Answer:** JSON
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/missions/<id>/schedule"
```

#### `GET /api/jobs`

The job queue, paged. `counts.failed` is the failed jobs still asking for the owner; `counts.dismissed` the ones dismissed or quiet after 14 days.

- **Auth:** Session or API token.
- **Query:** `state?, kind?, limit?, offset?, failed?: 'open'|'dismissed', dismissed?: '0' (leave dismissed failed jobs out)`
- **Answer:** `{ jobs: JobView[], counts, paused }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/jobs"
```

#### `GET /api/jobs/failures`

Failed jobs grouped by cause, each group with a plain reason and whether a retry is likely to work; the dismissed ones apart.

- **Auth:** Session or API token.
- **Answer:** `{ open: FailureGroupView[], dismissed: FailureGroupView[] }`
- **Since:** 0.1.0-pre.30

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/jobs/failures"
```

#### `POST /api/jobs/dismiss`

Dismiss failed jobs: kept on record, out of the footer count and the default view.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ ids?: string[], group?: string, all?: true }`
- **Answer:** `{ ids: string[] }`
- **Errors:** 400
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/jobs/dismiss"
```

#### `POST /api/jobs/undismiss`

Take a dismissal back (Undo).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ ids: string[] }`
- **Answer:** `{ ids: string[] }`
- **Errors:** 400
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"ids":[]}' "$BUDDI_URL/api/jobs/undismiss"
```

#### `POST /api/jobs/retry`

Retry failed jobs now, by ids, by cause group, or every one still asking.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ ids?: string[], group?: string, dismissed?: boolean, all?: true }`
- **Answer:** `{ jobs: JobView[] }`
- **Errors:** 400
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/jobs/retry"
```

#### `POST /api/jobs/:id/retry`

Retry a failed job.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404; 409 not failed
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/jobs/<id>/retry"
```

#### `POST /api/jobs/:id/cancel`

Cancel a queued or failed job.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404; 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/jobs/<id>/cancel"
```

#### `GET /api/reminders`

Reminders agents set, pending and past.

- **Auth:** Session or API token.
- **Query:** `limit?: number`
- **Answer:** `{ reminders }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/reminders"
```

#### `POST /api/reminders/:id/cancel`

Cancel a pending reminder.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ reason?: string }`
- **Answer:** JSON
- **Errors:** 404; 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/reminders/<id>/cancel"
```

#### `GET /api/sentinels`

Watchers: each one, whether it is on, its last run, and what they found as the owner reads it — decisions grouped, the recap counted, what he silenced.

- **Auth:** Session or API token.
- **Answer:** `{ installed, runs, alerts: { open, snoozed, resolved, recap: { count, missionId, nextAt, groups }, mutes } }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/sentinels"
```

#### `POST /api/sentinels/:id/enabled`

Switch a watcher off or on.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ enabled: boolean }`
- **Answer:** `{ sentinelId, enabled }`
- **Errors:** 400 no watcher with that id
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"enabled":true}' "$BUDDI_URL/api/sentinels/<id>/enabled"
```

#### `POST /api/alerts/:key/snooze`

Snooze an open alert, or wake it.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ snoozed: boolean, days?: number }  // days: "Not now", quiet that long; none: until the fact changes`
- **Answer:** `{ key, snoozedAt: string|null, snoozedUntil: string|null }`
- **Errors:** 404 no open alert with that key
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"snoozed":true}' "$BUDDI_URL/api/alerts/<key>/snooze"
```

#### `POST /api/alerts/snooze`

Snooze several alerts at once (Clear all), or wake them (its Undo).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ keys: string[], snoozed: boolean, days?: number }`
- **Answer:** `{ keys: string[] }  // the ones that were open`
- **Errors:** 400
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"keys":[],"snoozed":true}' "$BUDDI_URL/api/alerts/snooze"
```

#### `POST /api/alerts/mute`

"Stop telling me this": silence the alert's subject, or its whole kind. Reversible from Settings → Watchers.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ key: string, scope?: 'subject'|'kind', label?: string }`
- **Answer:** `{ id, label }`
- **Errors:** 404 no open alert with that key
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"key":"…"}' "$BUDDI_URL/api/alerts/mute"
```

#### `POST /api/alerts/mutes/:id/remove`

Take a "Stop telling me this" back.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ removed: true }`
- **Errors:** 404
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/alerts/mutes/<id>/remove"
```

#### `POST /api/alerts/act`

Run what an alert declared (a run, or a fill with the typed value), as the owner. Named by key and action index, never by tool; a gated tool answers its approval.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ entries: Array<{ key: string, action: number, value?: string|number }> }`
- **Answer:** `{ results: Array<{ key, result? , approvalId?, error? }> }`
- **Errors:** 400; 429
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"entries":[]}' "$BUDDI_URL/api/alerts/act"
```

#### `POST /api/alerts/ask`

Ask the agent that answers for these alerts, handing it their briefs. The thread shows what was asked about.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ keys: string[] }`
- **Answer:** `{ agentId, conversationId, runId }`
- **Errors:** 404; 409 no agent answers; 503 chat is not running
- **Since:** 0.1.0-pre.30

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"keys":[]}' "$BUDDI_URL/api/alerts/ask"
```

### Notifications

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/notifications` | The notifications buddi sent, newest first, each with needsOwner; with needs=1 the open ones that ask the owner for something. | yes |
| POST | `/api/notifications/:id/seen` | Mark a notification seen. | yes |
| GET | `/api/notifications/settings` | Where and when buddi reaches the owner. | yes |
| PUT | `/api/notifications/settings` | Change the notification settings. | yes |
| GET | `/api/notifications/focus` | The focus mode now. | yes |
| PUT | `/api/notifications/focus` | Set the focus mode, for a while or until changed. | yes |
| POST | `/api/notifications/test` | Send a test notification on a channel. | yes |
| POST | `/api/notifications/agent-mute` | Mute or unmute an agent's notifications. | yes |
| POST | `/api/presence` | Whether the owner is at the dashboard, which decides where a notification goes. | yes |

#### `GET /api/notifications`

The notifications buddi sent, newest first, each with needsOwner; with needs=1 the open ones that ask the owner for something.

- **Auth:** Session or API token.
- **Query:** `limit?: number, needs?: 1`
- **Answer:** JSON
- **Since:** 0.1.0-pre.18

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/notifications"
```

#### `POST /api/notifications/:id/seen`

Mark a notification seen.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.18

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/notifications/<id>/seen"
```

#### `GET /api/notifications/settings`

Where and when buddi reaches the owner.

- **Auth:** Session or API token.
- **Answer:** `{ settings, channels }`
- **Since:** 0.1.0-pre.18

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/notifications/settings"
```

#### `PUT /api/notifications/settings`

Change the notification settings.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `the settings object`
- **Answer:** `{ settings, channels }`
- **Errors:** 400
- **Since:** 0.1.0-pre.18

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/notifications/settings"
```

#### `GET /api/notifications/focus`

The focus mode now.

- **Auth:** Session or API token.
- **Answer:** `{ focus }`
- **Since:** 0.1.0-pre.23

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/notifications/focus"
```

#### `PUT /api/notifications/focus`

Set the focus mode, for a while or until changed.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ mode: 'normal'|'urgent-only'|'do-not-disturb', duration?: string }`
- **Answer:** `{ focus }`
- **Errors:** 400
- **Since:** 0.1.0-pre.23

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"mode":"normal"}' "$BUDDI_URL/api/notifications/focus"
```

#### `POST /api/notifications/test`

Send a test notification on a channel.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ channel: string }`
- **Answer:** JSON
- **Errors:** 400; 404; 502 the channel failed
- **Since:** 0.1.0-pre.18

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"channel":"…"}' "$BUDDI_URL/api/notifications/test"
```

#### `POST /api/notifications/agent-mute`

Mute or unmute an agent's notifications.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ agentId: string, muted: boolean }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.26

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"agentId":"…","muted":true}' "$BUDDI_URL/api/notifications/agent-mute"
```

#### `POST /api/presence`

Whether the owner is at the dashboard, which decides where a notification goes.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ state: 'active'|'away' }`
- **Answer:** `{ ok: true }`
- **Errors:** 400
- **Since:** 0.1.0-pre.18

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"state":"active"}' "$BUDDI_URL/api/presence"
```

### Memory

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/memory` | What buddi remembers: preferences and notes. | yes |
| POST | `/api/memory/preferences` | Set or correct a preference. | yes |
| POST | `/api/memory/preferences/forget` | Retire a preference. | yes |
| POST | `/api/memory/notes/:id` | Edit a note. | yes |
| POST | `/api/memory/notes/:id/forget` | Forget a note. | yes |
| GET | `/api/memory/people` | The owner’s people: who they are, how to address them, their dates, the next one and whether its reminders are on. | yes |
| POST | `/api/memory/people` | Add a person, or change one by id; reminders switches their date missions. | yes |
| POST | `/api/memory/people/:id/forget` | Forget a person; their reminders go with them. | yes |
| POST | `/api/memory/people/:id/restore` | Bring a forgotten person back (Undo). | yes |

#### `GET /api/memory`

What buddi remembers: preferences and notes.

- **Auth:** Session or API token.
- **Query:** `agent?: agent id  // what that agent sees`
- **Answer:** JSON
- **Errors:** 503 memory unavailable
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/memory"
```

#### `POST /api/memory/preferences`

Set or correct a preference.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ key: lower_snake_case, value: string, scope?: 'shared'|agent id }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"key":"…","value":"…"}' "$BUDDI_URL/api/memory/preferences"
```

#### `POST /api/memory/preferences/forget`

Retire a preference.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ key: string, scope?: string }`
- **Answer:** `204`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"key":"…"}' "$BUDDI_URL/api/memory/preferences/forget"
```

#### `POST /api/memory/notes/:id`

Edit a note.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ content?: string, scope?: string, kind?: 'fact'|'observation'|'todo' }`
- **Answer:** JSON
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/memory/notes/<id>"
```

#### `POST /api/memory/notes/:id/forget`

Forget a note.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `204`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/memory/notes/<id>/forget"
```

#### `GET /api/memory/people`

The owner’s people: who they are, how to address them, their dates, the next one and whether its reminders are on.

- **Auth:** Session or API token.
- **Answer:** `{ people: Array<{ id, name, relationship, addressAs, birthday, anniversary, notes, next: { what, inDays, turning }|null, reminders: boolean|null }>, today }`
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/memory/people"
```

#### `POST /api/memory/people`

Add a person, or change one by id; reminders switches their date missions.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ id?, name, relationship?, addressAs?, notes?: string|null, birthday?, anniversary?: { day, month, year? }|null, reminders?: boolean }`
- **Answer:** `{ person, people }`
- **Errors:** 400; 409 the name is taken
- **Since:** 0.1.0-pre.37

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/memory/people"
```

#### `POST /api/memory/people/:id/forget`

Forget a person; their reminders go with them.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ person, people }`
- **Errors:** 404
- **Since:** 0.1.0-pre.37

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/memory/people/<id>/forget"
```

#### `POST /api/memory/people/:id/restore`

Bring a forgotten person back (Undo).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ person, people }`
- **Errors:** 404
- **Since:** 0.1.0-pre.37

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/memory/people/<id>/restore"
```

### Files

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/reports/audio` | Read the saved audio attached to a report link. | yes |
| GET | `/api/artifacts` | The library: every file buddi holds, paged. | yes |
| GET | `/api/artifacts/:id` | One file: its metadata, where it was used, whether its bytes are still there. | yes |
| GET | `/api/artifacts/:id/download` | The file, as a download. | yes |
| GET | `/api/artifacts/:id/export/:format` | A document converted by buddi, as a download: Markdown as md, pdf or docx; a CSV table as csv or xlsx. The stored format (md, csv) comes back as written, at any size; a conversion takes at most 512 KiB, runs one at a time, and is stopped after 15 seconds. | yes |
| GET | `/api/artifacts/:id/preview` | The file inline, where it is safe to show: images, PDFs, text (as text/plain, its start only). | yes |
| DELETE | `/api/artifacts/:id` | Take back a file uploaded from the dashboard that no message carries. | yes |

#### `GET /api/reports/audio`

Read the saved audio attached to a report link.

- **Auth:** Session or API token.
- **Query:** `link: local report route`
- **Answer:** `{ audio: { fileId, mime, filename, sizeBytes } | null }`
- **Errors:** 400
- **Since:** 0.1.0-pre.49

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/reports/audio"
```

#### `GET /api/artifacts`

The library: every file buddi holds, paged.

- **Auth:** Session or API token.
- **Query:** `q?, origin?: 'uploaded'|'produced'|'unknown', family?, limit?, cursor?`
- **Answer:** `{ entries, nextCursor }`
- **Errors:** 400 a bad filter or cursor
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/artifacts"
```

#### `GET /api/artifacts/:id`

One file: its metadata, where it was used, whether its bytes are still there.

- **Auth:** Session or API token.
- **Query:** `contexts?: offset`
- **Answer:** `{ entry, contexts, available: boolean }`
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/artifacts/<id>"
```

#### `GET /api/artifacts/:id/download`

The file, as a download.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/artifacts/<id>/download" -o out
```

#### `GET /api/artifacts/:id/export/:format`

A document converted by buddi, as a download: Markdown as md, pdf or docx; a CSV table as csv or xlsx. The stored format (md, csv) comes back as written, at any size; a conversion takes at most 512 KiB, runs one at a time, and is stopped after 15 seconds.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** JSON
- **Errors:** 404; 410 contents gone from disk; 413 too large or complex to convert; 415 not offered for this file; 503 another conversion is running (Retry-After); 504 took too long
- **Since:** 0.1.0-pre.35

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/artifacts/<id>/export/<format>" -o out
```

#### `GET /api/artifacts/:id/preview`

The file inline, where it is safe to show: images, PDFs, text (as text/plain, its start only).

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Answer:** JSON
- **Errors:** 404; 415 not previewable
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/artifacts/<id>/preview" -o out
```

#### `DELETE /api/artifacts/:id`

Take back a file uploaded from the dashboard that no message carries.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `204`
- **Errors:** 404; 409 already sent, or not from the dashboard
- **Since:** 0.1.0-pre.15

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/artifacts/<id>"
```

### Your profile

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/owner` | The owner’s profile, places, and the timezones this host knows. | yes |
| POST | `/api/owner` | Change the profile; what is left out stays. | yes |
| POST | `/api/owner/places` | Save a place (new, or by id). | yes |
| POST | `/api/owner/places/find` | Find a place by address or town (Open-Meteo). | yes |
| GET | `/api/owner/birthday` | Home on the owner’s birthday: whether it is today, and the team’s note and picture once sent. | yes |
| POST | `/api/owner/places/remove` | Remove a place. | yes |

#### `GET /api/owner`

The owner’s profile, places, and the timezones this host knows.

- **Auth:** Session or API token.
- **Answer:** `{ preferredName, fullName, pronouns, birthday: { day, month, year|null }|null, timezone, language, about, timeFormat, dateFormat, places, detectedTimezone, zones }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/owner"
```

#### `POST /api/owner`

Change the profile; what is left out stays.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ preferredName?, fullName?, pronouns?, timezone?, language?, about?: string|null, birthday?: { day, month, year? }|null, timeFormat?: '12h'|'24h'|null, dateFormat?: 'short'|'long'|'iso'|null }`
- **Answer:** `as GET`
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/owner"
```

#### `POST /api/owner/places`

Save a place (new, or by id).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ id?, label: string, name: string, address?: string, latitude: number, longitude: number, timezone?: string }`
- **Answer:** `{ place, places }`
- **Errors:** 400
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"label":"…","name":"…","latitude":0,"longitude":0}' "$BUDDI_URL/api/owner/places"
```

#### `POST /api/owner/places/find`

Find a place by address or town (Open-Meteo).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ address: string }`
- **Answer:** `{ found: Array<{ name, latitude, longitude, timezone? }> }`
- **Errors:** 400; 502
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"address":"…"}' "$BUDDI_URL/api/owner/places/find"
```

#### `GET /api/owner/birthday`

Home on the owner’s birthday: whether it is today, and the team’s note and picture once sent.

- **Auth:** Session or API token.
- **Answer:** `{ today, date, name, age, note, from, image }`
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/owner/birthday"
```

#### `POST /api/owner/places/remove`

Remove a place.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ id: string }`
- **Answer:** `{ removed, places }`
- **Errors:** 404
- **Since:** 0.1.0-pre.29

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"id":"…"}' "$BUDDI_URL/api/owner/places/remove"
```

### Model accounts

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/provider-accounts` | Every model account, its state, models and agents; never a key. | yes |
| POST | `/api/provider-accounts/save` | Add or change an account (a key, an address, a default model). | no |
| POST | `/api/provider-accounts/probe-models` | Ask a provider which models a key or address offers, before saving. | yes |
| POST | `/api/provider-accounts/:id/test` | Test an account: ask its default model to reply "ready" (5 tokens, no tools) and say what came back, how long it took and about how many tokens. Within 10 s of the last test of the same account, unchanged, the last result is answered again without calling the provider. Changed in 0.1.0-pre.43: refused to API tokens, the 10 s cooldown, and the reply scrubbed of the credential and every stored secret. | no |
| POST | `/api/provider-accounts/:id/models` | The account’s models. | yes |
| POST | `/api/provider-accounts/:id/remove` | Remove an account. | yes |
| POST | `/api/provider-accounts/:id/login` | Start a ChatGPT (Codex) device sign-in. | no |
| POST | `/api/provider-accounts/:id/cancel-login` | Cancel a sign-in in progress. | yes |
| POST | `/api/provider-accounts/:id/logout` | Sign the account out (its stored sign-in is deleted). | yes |
| POST | `/api/provider-accounts/:id/anthropic/login` | Start a Claude subscription sign-in. | no |
| POST | `/api/provider-accounts/:id/anthropic/complete-login` | Finish it with the code Claude showed. | no |
| POST | `/api/provider-accounts/:id/anthropic/cancel-login` | Cancel a Claude sign-in in progress. | yes |
| POST | `/api/provider-accounts/:id/anthropic/logout` | Sign the Claude subscription out. | yes |
| POST | `/api/provider-accounts/:id/ollama/connect` | Start connecting an Ollama account. | no |
| POST | `/api/provider-accounts/:id/ollama/poll` | Ask whether the Ollama connection finished. | yes |
| POST | `/api/provider-accounts/:id/ollama/disconnect` | Disconnect the Ollama account. | yes |
| GET | `/api/providers` | Legacy global provider settings (installations without named accounts). | yes |
| POST | `/api/providers/anthropic/settings` | Legacy: Anthropic settings. | no |
| POST | `/api/providers/anthropic/test` | Legacy: test Anthropic. | yes |
| POST | `/api/providers/openai/settings` | Legacy: OpenAI settings. | no |
| POST | `/api/providers/openai/test` | Legacy: test OpenAI. | yes |
| POST | `/api/providers/credentials/:name/save` | Legacy: save a credential. | no |
| POST | `/api/providers/credentials/:name/remove` | Legacy: remove a credential. | yes |

#### `GET /api/provider-accounts`

Every model account, its state, models and agents; never a key.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 503 accounts unavailable in this process
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts"
```

#### `POST /api/provider-accounts/save`

Add or change an account (a key, an address, a default model).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ id?, label, kind, apiKey?, baseUrl?, defaultModel, revision? }`
- **Answer:** JSON
- **Errors:** 400; 409 changed elsewhere
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/provider-accounts/save"
```

#### `POST /api/provider-accounts/probe-models`

Ask a provider which models a key or address offers, before saving.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ kind, apiKey?, baseUrl?, accountId? }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/provider-accounts/probe-models"
```

#### `POST /api/provider-accounts/:id/test`

Test an account: ask its default model to reply "ready" (5 tokens, no tools) and say what came back, how long it took and about how many tokens. Within 10 s of the last test of the same account, unchanged, the last result is answered again without calling the provider. Changed in 0.1.0-pre.43: refused to API tokens, the 10 s cooldown, and the reply scrubbed of the credential and every stored secret.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Answer:** `{ state, message, httpStatus, retryAt, checkedAt, model?, reply?, elapsedMs?, tokens?, billing?: "key" | "plan" | null, detail?: string | null }`
- **Errors:** 400 a ChatGPT subscription; 404; 409 a test already running, or the account changed during it
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/provider-accounts/<id>/test"
```

#### `POST /api/provider-accounts/:id/models`

The account’s models.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ refresh?: boolean }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/provider-accounts/<id>/models"
```

#### `POST /api/provider-accounts/:id/remove`

Remove an account.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ revision: number }`
- **Answer:** JSON
- **Errors:** 404; 409 agents still use it, or changed elsewhere
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"revision":0}' "$BUDDI_URL/api/provider-accounts/<id>/remove"
```

#### `POST /api/provider-accounts/:id/login`

Start a ChatGPT (Codex) device sign-in.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ revision? }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/provider-accounts/<id>/login"
```

#### `POST /api/provider-accounts/:id/cancel-login`

Cancel a sign-in in progress.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts/<id>/cancel-login"
```

#### `POST /api/provider-accounts/:id/logout`

Sign the account out (its stored sign-in is deleted).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts/<id>/logout"
```

#### `POST /api/provider-accounts/:id/anthropic/login`

Start a Claude subscription sign-in.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/provider-accounts/<id>/anthropic/login"
```

#### `POST /api/provider-accounts/:id/anthropic/complete-login`

Finish it with the code Claude showed.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ code: string }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"code":"…"}' "$BUDDI_URL/api/provider-accounts/<id>/anthropic/complete-login"
```

#### `POST /api/provider-accounts/:id/anthropic/cancel-login`

Cancel a Claude sign-in in progress.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts/<id>/anthropic/cancel-login"
```

#### `POST /api/provider-accounts/:id/anthropic/logout`

Sign the Claude subscription out.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts/<id>/anthropic/logout"
```

#### `POST /api/provider-accounts/:id/ollama/connect`

Start connecting an Ollama account.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Answer:** JSON
- **Since:** 0.1.0-pre.20

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/provider-accounts/<id>/ollama/connect"
```

#### `POST /api/provider-accounts/:id/ollama/poll`

Ask whether the Ollama connection finished.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.20

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts/<id>/ollama/poll"
```

#### `POST /api/provider-accounts/:id/ollama/disconnect`

Disconnect the Ollama account.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.20

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/provider-accounts/<id>/ollama/disconnect"
```

#### `GET /api/providers`

Legacy global provider settings (installations without named accounts).

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 503
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/providers"
```

#### `POST /api/providers/anthropic/settings`

Legacy: Anthropic settings.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Answer:** JSON
- **Errors:** 410 replaced by model accounts
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/providers/anthropic/settings"
```

#### `POST /api/providers/anthropic/test`

Legacy: test Anthropic.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 410
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/providers/anthropic/test"
```

#### `POST /api/providers/openai/settings`

Legacy: OpenAI settings.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Answer:** JSON
- **Errors:** 410
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/providers/openai/settings"
```

#### `POST /api/providers/openai/test`

Legacy: test OpenAI.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 410
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/providers/openai/test"
```

#### `POST /api/providers/credentials/:name/save`

Legacy: save a credential.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Answer:** JSON
- **Errors:** 410
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/providers/credentials/<name>/save"
```

#### `POST /api/providers/credentials/:name/remove`

Legacy: remove a credential.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 410
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/providers/credentials/<name>/remove"
```

### Connections

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/connections` | Connected MCP services, the catalog, and the agents a connection can be given to. | yes |
| POST | `/api/connections` | Add a service by address, or a program to run (stdio). | no |
| GET | `/api/connections/signals` | What needs the owner across connections (sign-ins lapsed, reviews pending). | yes |
| POST | `/api/connections/callback` | Finish a sign-in: the code and state the service sent back to /connections/callback. | yes |
| GET | `/api/connections/remembered/:agent` | An agent's connection tools that ask first, and which are remembered. | yes |
| POST | `/api/connections/remembered` | Remember (or forget) the owner’s yes for one agent and tool. | no |
| GET | `/api/connections/:id` | One connection. | yes |
| DELETE | `/api/connections/:id` | Disconnect: taken from every agent, its sign-in deleted. | yes |
| POST | `/api/connections/:id/consent` | Start the service’s sign-in; answers the page to send the owner to. | yes |
| POST | `/api/connections/:id/reconnect` | Sign in again. | yes |
| POST | `/api/connections/:id/token` | Sign in with a pasted token. | no |
| POST | `/api/connections/:id/device` | Start a device sign-in (a code to type on the service’s page). | yes |
| GET | `/api/connections/:id/review` | The tools the service offers, for the owner to read before giving them out. | yes |
| POST | `/api/connections/:id/review` | Mark the review read. | yes |
| POST | `/api/connections/:id/grant` | Give the connection’s tools to agents. | no |
| POST | `/api/connections/:id/holders/:agent` | Give or take the connection for one agent. | no |
| GET | `/api/connections/:id/tools` | The connection's tools and their tiers. | yes |
| PUT | `/api/connections/:id/program` | Change a program connection’s command (POST works too). | no |

#### `GET /api/connections`

Connected MCP services, the catalog, and the agents a connection can be given to.

- **Auth:** Session or API token.
- **Answer:** `{ connections, catalog, agents, vault: boolean, tokens: boolean, callbackPath }`
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections"
```

#### `POST /api/connections`

Add a service by address, or a program to run (stdio).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ url: string, name?: string } or { transport: 'stdio', command, args?, env?, name? }`
- **Answer:** `201 { connection, signIn }`
- **Errors:** 400
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/connections"
```

#### `GET /api/connections/signals`

What needs the owner across connections (sign-ins lapsed, reviews pending).

- **Auth:** Session or API token.
- **Answer:** `{ signals }`
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/signals"
```

#### `POST /api/connections/callback`

Finish a sign-in: the code and state the service sent back to /connections/callback.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ state: string, code?: string, error?: string }`
- **Answer:** JSON
- **Errors:** 400 no state; 409 not this session’s sign-in
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"state":"…"}' "$BUDDI_URL/api/connections/callback"
```

#### `GET /api/connections/remembered/:agent`

An agent's connection tools that ask first, and which are remembered.

- **Auth:** Session or API token.
- **Answer:** `{ agent, tools }`
- **Errors:** 404
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/remembered/<agent>"
```

#### `POST /api/connections/remembered`

Remember (or forget) the owner’s yes for one agent and tool.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `{ agent: string, tool: string, remember: boolean }`
- **Answer:** JSON
- **Errors:** 400; 404; 409 this tool is never remembered
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"agent":"…","tool":"…","remember":true}' "$BUDDI_URL/api/connections/remembered"
```

#### `GET /api/connections/:id`

One connection.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/<id>"
```

#### `DELETE /api/connections/:id`

Disconnect: taken from every agent, its sign-in deleted.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404; 409 an agent file could not be changed
- **Since:** 0.1.0-pre.22

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/<id>"
```

#### `POST /api/connections/:id/consent`

Start the service’s sign-in; answers the page to send the owner to.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ cli?: boolean, clientId?: string }`
- **Answer:** `{ url, redirectUri, … }`
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/connections/<id>/consent"
```

#### `POST /api/connections/:id/reconnect`

Sign in again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `as consent`
- **Answer:** JSON
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/<id>/reconnect"
```

#### `POST /api/connections/:id/token`

Sign in with a pasted token.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ token: string, header?: string, prefix?: string }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.25

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"token":"…"}' "$BUDDI_URL/api/connections/<id>/token"
```

#### `POST /api/connections/:id/device`

Start a device sign-in (a code to type on the service’s page).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.25

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/<id>/device"
```

#### `GET /api/connections/:id/review`

The tools the service offers, for the owner to read before giving them out.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/<id>/review"
```

#### `POST /api/connections/:id/review`

Mark the review read.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ hash: string, slug?: string }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"hash":"…"}' "$BUDDI_URL/api/connections/<id>/review"
```

#### `POST /api/connections/:id/grant`

Give the connection’s tools to agents.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `{ agents: agent id[], exact?: boolean }`
- **Answer:** `{ granted, failed, connection }`
- **Errors:** 400; 409 not reviewed, or nothing could be given
- **Since:** 0.1.0-pre.22

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"agents":[]}' "$BUDDI_URL/api/connections/<id>/grant"
```

#### `POST /api/connections/:id/holders/:agent`

Give or take the connection for one agent.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `{ held: boolean }`
- **Answer:** `{ agent, held, connection }`
- **Errors:** 400; 404; 409
- **Since:** 0.1.0-pre.26

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"held":true}' "$BUDDI_URL/api/connections/<id>/holders/<agent>"
```

#### `GET /api/connections/:id/tools`

The connection's tools and their tiers.

- **Auth:** Session or API token.
- **Answer:** `{ connection, tools }`
- **Since:** 0.1.0-pre.22

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/connections/<id>/tools"
```

#### `PUT /api/connections/:id/program`

Change a program connection’s command (POST works too).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ command, args?, env? }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.25

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/connections/<id>/program"
```

### Plugins and plugin pages

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/plugins` | Installed plugins, staged ones waiting to be read, and the trust sentence. | yes |
| GET | `/api/plugin-assets/:plugin/:key` | A plugin's kept image: a PNG drawn by buddi, 128 px square by default, ?size=64 for small icons or ?size=768 for aspect-preserving story images. | yes |
| POST | `/api/plugins/stage` | Fetch a plugin to read before installing (npm name, tarball path or folder). | no |
| POST | `/api/plugins/upload` | Stage a plugin tarball sent as the body. | no |
| GET | `/api/plugins/jobs/:id` | A staging, install or update job. | yes |
| POST | `/api/plugins/staged/:id/approve` | Install what was staged; carries back the integrity the owner was shown. | no |
| POST | `/api/plugins/staged/:id/reject` | Throw a stage away. | yes |
| POST | `/api/plugins/staged/:id/opened` | Record that the owner opened the install card. | yes |
| POST | `/api/plugins/:name/update` | Update a plugin. | no |
| POST | `/api/plugins/:name/uninstall` | Uninstall a plugin; its data too with purge. | no |
| POST | `/api/plugins/:name/disable` | Disable a plugin (its tools and pages go; data stays). | yes |
| POST | `/api/plugins/:name/enable` | Enable it again. | yes |
| POST | `/api/plugins/:plugin/agents/:agent/accept` | Accept an agent a plugin proposes: the owner’s click is the approval. | no |
| GET | `/api/plugins/folders` | Folders under the owner’s home, for "a directory I built". | yes |
| GET | `/api/market` | The plugin list from withbuddi.com (fetched when asked, kept a day). | yes |
| GET | `/api/market/asset` | A listing’s screenshot, fetched through the gateway. | yes |
| GET | `/api/pages` | The screens installed plugins contribute, as descriptors. | yes |
| GET | `/api/pages/:plugin/:query` | One plugin page query, its parameters checked by the query's schema. | yes |
| POST | `/api/pages/:plugin/act` | A write from a plugin's page, as the owner: an auto tool runs; a gated one answers an approval to decide. An API token may only ask: it gets the approval of a gated tool, and 403 for one that would run at once. | yes |
| GET | `/api/preview/:plugin/:name/link` | A one-use link into a plugin preview, on the preview origin. | yes |
| GET | `/api/preview/:plugin/:name/check` | Is the preview served, and does it assume it owns a host. | yes |

#### `GET /api/plugins`

Installed plugins, staged ones waiting to be read, and the trust sentence.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins"
```

#### `GET /api/plugin-assets/:plugin/:key`

A plugin's kept image: a PNG drawn by buddi, 128 px square by default, ?size=64 for small icons or ?size=768 for aspect-preserving story images.

- **Auth:** Session or API token; answered while locked.
- **Kind:** bytes, not JSON
- **Answer:** `image/png, with an ETag`
- **Errors:** 404 no such asset
- **Since:** 0.1.0-pre.36

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugin-assets/<plugin>/<key>" -o out
```

#### `POST /api/plugins/stage`

Fetch a plugin to read before installing (npm name, tarball path or folder).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ spec: string }`
- **Answer:** `202 { job }`
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"spec":"…"}' "$BUDDI_URL/api/plugins/stage"
```

#### `POST /api/plugins/upload`

Stage a plugin tarball sent as the body.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Kind:** an upload
- **Body:** `the .tgz bytes; X-Filename header`
- **Answer:** `202 { job }`
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -F "file=@./file" "$BUDDI_URL/api/plugins/upload"
```

#### `GET /api/plugins/jobs/:id`

A staging, install or update job.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins/jobs/<id>"
```

#### `POST /api/plugins/staged/:id/approve`

Install what was staged; carries back the integrity the owner was shown.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ integrity: string, acknowledgeDrift?: boolean }`
- **Answer:** JSON
- **Errors:** 400; 404; 409 it changed
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"integrity":"…"}' "$BUDDI_URL/api/plugins/staged/<id>/approve"
```

#### `POST /api/plugins/staged/:id/reject`

Throw a stage away.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins/staged/<id>/reject"
```

#### `POST /api/plugins/staged/:id/opened`

Record that the owner opened the install card.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.28

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins/staged/<id>/opened"
```

#### `POST /api/plugins/:name/update`

Update a plugin.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ version?: string, from?: string }`
- **Answer:** `202 { job }`
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/plugins/<name>/update"
```

#### `POST /api/plugins/:name/uninstall`

Uninstall a plugin; its data too with purge.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ purge?: boolean, confirm?: string }`
- **Answer:** JSON
- **Errors:** 409 confirmation needed
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/plugins/<name>/uninstall"
```

#### `POST /api/plugins/:name/disable`

Disable a plugin (its tools and pages go; data stays).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.23

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins/<name>/disable"
```

#### `POST /api/plugins/:name/enable`

Enable it again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.23

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins/<name>/enable"
```

#### `POST /api/plugins/:plugin/agents/:agent/accept`

Accept an agent a plugin proposes: the owner’s click is the approval.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It decides an approval, or the click is the approval. A token never decides for the owner.
- **Answer:** JSON
- **Errors:** 404; 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/plugins/<plugin>/agents/<agent>/accept"
```

#### `GET /api/plugins/folders`

Folders under the owner’s home, for "a directory I built".

- **Auth:** Session or API token.
- **Query:** `path?: string`
- **Answer:** JSON
- **Errors:** 400; 403 outside home; 404
- **Since:** 0.1.0-pre.24

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/plugins/folders"
```

#### `GET /api/market`

The plugin list from withbuddi.com (fetched when asked, kept a day).

- **Auth:** Session or API token.
- **Query:** `refresh?: 1`
- **Answer:** JSON
- **Since:** 0.1.0-pre.24

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/market"
```

#### `GET /api/market/asset`

A listing’s screenshot, fetched through the gateway.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Query:** `url: string`
- **Answer:** JSON
- **Errors:** 400; 415; 502
- **Since:** 0.1.0-pre.24

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/market/asset" -o out
```

#### `GET /api/pages`

The screens installed plugins contribute, as descriptors.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/pages"
```

#### `GET /api/pages/:plugin/:query`

One plugin page query, its parameters checked by the query's schema.

- **Auth:** Session or API token.
- **Query:** `the query’s own parameters`
- **Answer:** `{ data }`
- **Errors:** 400 the plugin’s sentence; 404 no such query
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/pages/<plugin>/<query>"
```

#### `POST /api/pages/:plugin/act`

A write from a plugin's page, as the owner: an auto tool runs; a gated one answers an approval to decide. An API token may only ask: it gets the approval of a gated tool, and 403 for one that would run at once.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ tool: string, args?: object }`
- **Answer:** `{ result } or { approvalId }`
- **Errors:** 400; 403 a token, and a tool that runs without an approval; 404 not a tool of this page; 429
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"tool":"…"}' "$BUDDI_URL/api/pages/<plugin>/act"
```

#### `GET /api/preview/:plugin/:name/link`

A one-use link into a plugin preview, on the preview origin.

- **Auth:** Session or API token.
- **Answer:** `{ url: string }`
- **Errors:** 404; 429; 503 previews not served
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/preview/<plugin>/<name>/link"
```

#### `GET /api/preview/:plugin/:name/check`

Is the preview served, and does it assume it owns a host.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/preview/<plugin>/<name>/check"
```

### Keys and secrets

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/secrets` | Owner secrets by name, with where each may be used. Never a value. | yes |
| GET | `/api/secrets/uses` | Where a secret was used. | yes |
| POST | `/api/secrets/act` | Add, change or remove a secret or its rules. | no |

#### `GET /api/secrets`

Owner secrets by name, with where each may be used. Never a value.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/secrets"
```

#### `GET /api/secrets/uses`

Where a secret was used.

- **Auth:** Session or API token.
- **Query:** `name: string, limit?: number`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/secrets/uses"
```

#### `POST /api/secrets/act`

Add, change or remove a secret or its rules.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ tool: string, args: object }`
- **Answer:** JSON
- **Errors:** 400; 429
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"tool":"…","args":{}}' "$BUDDI_URL/api/secrets/act"
```

### Computer and browser

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/host` | Host execution: standing permissions and recent runs. | yes |
| POST | `/api/host/stop` | Stop an agent’s running commands in a conversation. | yes |
| POST | `/api/host/revoke` | Revoke a standing host-execution permission. | yes |
| GET | `/api/browser` | The agents' browser: installed, running, its session and page. | yes |
| GET | `/api/browser/screenshot` | The browser’s current screen, as JPEG. | yes |
| POST | `/api/browser/install` | Download the browser agents use (about 150 MB); follow on GET /api/browser. | no |
| POST | `/api/browser/check` | Launch the browser once to see it starts. | yes |
| POST | `/api/browser/settings` | Change where agents may look: your Chrome on/off, your apps off/ask/on, sites that need your sign-in, the Stop's expiry, pages at once, show the window, the folder your Chrome saves downloads to (downloadsFolder). A partial object. | no |
| POST | `/api/browser/pin` | Pin one conversation to a route, or clear it. | yes |
| POST | `/api/browser/card` | Answer a browser card (Look, Keep going, Take over, Use my Chrome, Resume) without a chat message. | yes |
| GET | `/api/browser/downloads` | The agents' downloads area: bytes and files by agent, the per-file and per-agent caps, the retention in days, and the files waiting there because they could not be filed (newest day first, at most 200). | yes |
| POST | `/api/browser/downloads/clear` | Empty the agents' downloads area. What waits there is not in Files, so it is gone for good. | yes |
| POST | `/api/browser/downloads/file` | File it: register one waiting download in Files as its agent's, then drop it from the area. | yes |
| GET | `/api/browser/telemetry` | Browser stops by cause, cards and routes over the last days. | yes |
| POST | `/api/browser/stop` | Stop one page, or with no session stop agents' browsing (expires after the set time unless forever). | yes |
| POST | `/api/browser/takeover` | Take over the screen from the agent. | yes |
| POST | `/api/browser/resume` | Give the screen back to the agent. | yes |
| POST | `/api/browser/release` | Release the session. | yes |
| GET | `/api/browser/hand` | WebSocket: drive the taken-over screen (the CSRF value is the first frame). Also says { type: "loginSeen", id, site, username } when the owner signs in on the page they hold. | no |
| POST | `/api/browser/login` | Answer "Save this login?" for a sign-in the owner made on a page they held: save keeps it as an owner secret, never stops asking for that site. | no |
| GET | `/api/extension` | The browser extension: paired or not, connected or not. | yes |
| POST | `/api/extension/pair` | Pair the extension with the code it shows. | no |
| DELETE | `/api/extension/pair` | Forget the paired extension. | yes |
| GET | `/api/extension/socket` | WebSocket: the paired extension's own connection. | no |

#### `GET /api/host`

Host execution: standing permissions and recent runs.

- **Auth:** Session or API token.
- **Query:** `agentId?, conversationId?`
- **Answer:** `{ permissions, runs }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/host"
```

#### `POST /api/host/stop`

Stop an agent’s running commands in a conversation.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ agentId: string, conversationId: string }`
- **Answer:** `{ stopped }`
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"agentId":"…","conversationId":"…"}' "$BUDDI_URL/api/host/stop"
```

#### `POST /api/host/revoke`

Revoke a standing host-execution permission.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ id: uuid }`
- **Answer:** `{ revoked: true }`
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"id":"…"}' "$BUDDI_URL/api/host/revoke"
```

#### `GET /api/browser`

The agents' browser: installed, running, its session and page.

- **Auth:** Session or API token.
- **Query:** `agentId?, conversationId?`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/browser"
```

#### `GET /api/browser/screenshot`

The browser’s current screen, as JPEG.

- **Auth:** Session or API token.
- **Kind:** bytes, not JSON
- **Query:** `sessionId?, v?: page id`
- **Answer:** JSON
- **Errors:** 404 no screen, or not the session or page asked for
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/browser/screenshot" -o out
```

#### `POST /api/browser/install`

Download the browser agents use (about 150 MB); follow on GET /api/browser.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Answer:** `202`
- **Errors:** 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/browser/install"
```

#### `POST /api/browser/check`

Launch the browser once to see it starts.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ ok: boolean, message? }`
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/browser/check"
```

#### `POST /api/browser/settings`

Change where agents may look: your Chrome on/off, your apps off/ask/on, sites that need your sign-in, the Stop's expiry, pages at once, show the window, the folder your Chrome saves downloads to (downloadsFolder). A partial object.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Answer:** JSON
- **Errors:** 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/browser/settings"
```

#### `POST /api/browser/pin`

Pin one conversation to a route, or clear it.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ conversationId: string, route: auto|own|chrome|apps }`
- **Answer:** JSON
- **Errors:** 400; 409
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"conversationId":"…","route":"…"}' "$BUDDI_URL/api/browser/pin"
```

#### `POST /api/browser/card`

Answer a browser card (Look, Keep going, Take over, Use my Chrome, Resume) without a chat message.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ conversationId: string, answer: string }`
- **Answer:** `{ answered?, status }`
- **Errors:** 400
- **Since:** 0.1.0-pre.38

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"conversationId":"…","answer":"…"}' "$BUDDI_URL/api/browser/card"
```

#### `GET /api/browser/downloads`

The agents' downloads area: bytes and files by agent, the per-file and per-agent caps, the retention in days, and the files waiting there because they could not be filed (newest day first, at most 200).

- **Auth:** Session or API token.
- **Answer:** `{ bytes, files, agents: [{ agent, bytes, files }], fileCap, agentCap, retentionDays, waiting: [{ id, agent, day, name, size, mime }] }`
- **Since:** 0.1.0-pre.46

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/browser/downloads"
```

#### `POST /api/browser/downloads/clear`

Empty the agents' downloads area. What waits there is not in Files, so it is gone for good.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `the downloads area, now empty`
- **Errors:** 409
- **Since:** 0.1.0-pre.46

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/browser/downloads/clear"
```

#### `POST /api/browser/downloads/file`

File it: register one waiting download in Files as its agent's, then drop it from the area.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ id }`
- **Answer:** `{ ...the downloads area, filed: { artifactId, name } }`
- **Errors:** 400 · 404 when the file is no longer there · 409
- **Since:** 0.1.0-pre.46

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/browser/downloads/file"
```

#### `GET /api/browser/telemetry`

Browser stops by cause, cards and routes over the last days.

- **Auth:** Session or API token.
- **Query:** `days?: number`
- **Answer:** `{ days, tasks, stops, cards, byCause, routes, stopsPerTask }`
- **Since:** 0.1.0-pre.38

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/browser/telemetry"
```

#### `POST /api/browser/stop`

Stop one page, or with no session stop agents' browsing (expires after the set time unless forever).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ sessionId?: string, forever?: boolean }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/browser/stop"
```

#### `POST /api/browser/takeover`

Take over the screen from the agent.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ sessionId?: string }`
- **Answer:** `the status, with hand: boolean; a page in your Chrome comes to the front there instead and the status carries held: { by: "owner", where: "chrome" }`
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/browser/takeover"
```

#### `POST /api/browser/resume`

Give the screen back to the agent.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ sessionId?: string }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/browser/resume"
```

#### `POST /api/browser/release`

Release the session.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ sessionId?: string }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/browser/release"
```

#### `GET /api/browser/hand`

WebSocket: drive the taken-over screen (the CSRF value is the first frame). Also says { type: "loginSeen", id, site, username } when the owner signs in on the page they hold.

- **Auth:** Dashboard session only. A socket with its own gate: the browser extension pairs, the remote hand needs the dashboard session.
- **Kind:** a WebSocket upgrade
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

#### `POST /api/browser/login`

Answer "Save this login?" for a sign-in the owner made on a page they held: save keeps it as an owner secret, never stops asking for that site.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ id: string, decision: save|later|never }`
- **Answer:** `{ outcome: saved|dismissed|never|gone, saved?: { name, site, username, savedAt } }`
- **Errors:** 400; 409
- **Since:** 0.1.0-pre.39

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"id":"…","decision":"…"}' "$BUDDI_URL/api/browser/login"
```

#### `GET /api/extension`

The browser extension: paired or not, connected or not.

- **Auth:** Session or API token.
- **Answer:** `{ connected: boolean, pending: boolean, path: string, checkout: boolean, buddi: string, extensionMinimum: string, pairedAt?: string, extension?: string, lastSeenAt?: string, portMoved?: { from: number, to: number } }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/extension"
```

#### `POST /api/extension/pair`

Pair the extension with the code it shows.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ code: string }`
- **Answer:** JSON
- **Errors:** 400; 429 five tries in five minutes
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"code":"…"}' "$BUDDI_URL/api/extension/pair"
```

#### `DELETE /api/extension/pair`

Forget the paired extension.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/extension/pair"
```

#### `GET /api/extension/socket`

WebSocket: the paired extension's own connection.

- **Auth:** Dashboard session only. A socket with its own gate: the browser extension pairs, the remote hand needs the dashboard session.
- **Kind:** a WebSocket upgrade
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

### Telegram

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/telegram` | Telegram: configured, running, paired. | yes |
| GET | `/api/telegram/bot` | Which bot. | yes |
| GET | `/api/telegram/devices` | The phones paired with it. | yes |
| POST | `/api/telegram/token` | Save the bot token BotFather gave. | no |
| POST | `/api/telegram/pairing` | A pairing code for a phone. | no |
| DELETE | `/api/telegram/devices/:id` | Unpair a phone, now. | yes |

#### `GET /api/telegram`

Telegram: configured, running, paired.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/telegram"
```

#### `GET /api/telegram/bot`

Which bot.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.19

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/telegram/bot"
```

#### `GET /api/telegram/devices`

The phones paired with it.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.19

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/telegram/devices"
```

#### `POST /api/telegram/token`

Save the bot token BotFather gave.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ token: string }`
- **Answer:** JSON
- **Errors:** 400 not a token Telegram accepts
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"token":"…"}' "$BUDDI_URL/api/telegram/token"
```

#### `POST /api/telegram/pairing`

A pairing code for a phone.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `{ code, expiresAt, … }`
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/telegram/pairing"
```

#### `DELETE /api/telegram/devices/:id`

Unpair a phone, now.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `204`
- **Errors:** 404
- **Since:** 0.1.0-pre.19

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/telegram/devices/<id>"
```

### Backups, version and service

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/service` | Is buddi run by a supervisor, and its status. | yes |
| POST | `/api/service/start` | Start through the supervisor. | yes |
| POST | `/api/service/stop` | Stop buddi. Accepted, then done once the answer is sent; nothing answers after. | yes |
| POST | `/api/service/restart` | Restart buddi; it is back in seconds. | yes |
| GET | `/api/runtimes` | The local-model engine (ONNX Runtime) and the shared models: state, version, sizes. | yes |
| DELETE | `/api/runtimes/onnx` | Remove the engine, and any recorded failure; the next plugin to need it asks again. | yes |
| DELETE | `/api/runtimes/models/:id` | Remove one shared model. | yes |
| GET | `/api/version` | What is running, and what upgrading did before. | yes |
| POST | `/api/version/check` | Check for a newer version now. | yes |
| PUT | `/api/version/check` | Turn the daily check on or off. | yes |
| POST | `/api/upgrade` | Upgrade (then the gateway restarts). | no |
| GET | `/api/upgrade/jobs/:id` | An upgrade job. | yes |
| GET | `/api/backups` | The backups on disk. | yes |
| POST | `/api/backups` | Take a backup now. | yes |
| GET | `/api/backups/jobs/:id` | A backup, verify or restore job. | yes |
| POST | `/api/backups/verify` | Verify a backup. | yes |
| POST | `/api/backups/restore` | Restore a backup over this installation (typed-back confirmation required). | no |
| GET | `/api/backups/schedule` | The backup schedule. | yes |
| PUT | `/api/backups/schedule` | Change the backup schedule. | yes |
| GET | `/api/backups/passphrase` | The backup passphrase. Refused while a lock-screen PIN is set: use POST …/reveal. | no |
| POST | `/api/backups/passphrase/reveal` | The backup passphrase, behind the lock-screen PIN when there is one (counted like an unlock try). | no |
| GET | `/api/backups/passphrase/notice` | Home's passphrase card: the six words once an encrypted backup exists, until they are acknowledged. With a lock-screen PIN set the words stay back (needsPin) and the card reveals them with POST …/reveal. | no |
| POST | `/api/backups/passphrase/notice` | "I saved it": the passphrase card goes for good. | yes |
| PUT | `/api/backups/passphrase` | Set the backup passphrase. | no |
| GET | `/api/system/cli` | buddi.app's command line tool: whether this buddi offers it and where it is installed. | yes |
| POST | `/api/system/cli` | Install buddi.app's command line tool: /usr/local/bin/buddi (an administrator prompt), else ~/.local/bin/buddi. | no |
| GET | `/api/system/uninstall` | Remove buddi from this Mac: what goes, and a confirmation token for the next two calls. | no |
| POST | `/api/system/uninstall/backup` | The last backup, moved to ~/buddi-backups with <archive>.passphrase.txt beside it. | no |
| GET | `/api/system/uninstall/jobs/:id` | Where the last backup has got to; when done, its report has the archive, the passphrase file and the six words. | no |
| POST | `/api/system/uninstall` | Remove buddi: the supervisor runs buddi uninstall (buddi.app finishes it and moves itself to the Trash). Needs the last backup taken first. | no |
| GET | `/api/recovery` | After a restore: the checklist to get through (active: false otherwise). | yes |
| POST | `/api/recovery/leave` | Leave recovery: drop pending work, keep the grants listed, restart. | no |

#### `GET /api/service`

Is buddi run by a supervisor, and its status.

- **Auth:** Session or API token.
- **Answer:** `{ supervised: boolean, supervisor?, status? }`
- **Errors:** 502; 503 the supervisor does not answer
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/service"
```

#### `POST /api/service/start`

Start through the supervisor.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 404 no supervisor; 502; 503
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/service/start"
```

#### `POST /api/service/stop`

Stop buddi. Accepted, then done once the answer is sent; nothing answers after.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `202 { supervised: true, pending: 'stop' }`
- **Errors:** 404 no supported service control
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/service/stop"
```

#### `POST /api/service/restart`

Restart buddi; it is back in seconds.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `202 { supervised: true, pending: 'restart' }`
- **Errors:** 404 no supported service control
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/service/restart"
```

#### `GET /api/runtimes`

The local-model engine (ONNX Runtime) and the shared models: state, version, sizes.

- **Auth:** Session or API token.
- **Answer:** `{ onnx: { state, version, sizeBytes, downloadBytes, platform, available, reason?, sessions }, models: ModelState[] }`
- **Since:** 0.1.0-pre.48

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/runtimes"
```

#### `DELETE /api/runtimes/onnx`

Remove the engine, and any recorded failure; the next plugin to need it asks again.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `the same as GET /api/runtimes`
- **Errors:** 409 downloading
- **Since:** 0.1.0-pre.48

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/runtimes/onnx"
```

#### `DELETE /api/runtimes/models/:id`

Remove one shared model.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `the same as GET /api/runtimes`
- **Errors:** 409 downloading
- **Since:** 0.1.0-pre.48

```sh
curl -X DELETE -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/runtimes/models/<id>"
```

#### `GET /api/version`

What is running, and what upgrading did before.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/version"
```

#### `POST /api/version/check`

Check for a newer version now.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 409; 503
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/version/check"
```

#### `PUT /api/version/check`

Turn the daily check on or off.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ enabled: boolean }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"enabled":true}' "$BUDDI_URL/api/version/check"
```

#### `POST /api/upgrade`

Upgrade (then the gateway restarts).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ version?: string }`
- **Answer:** `202 { job }`
- **Errors:** 400; 409; 503
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/upgrade"
```

#### `GET /api/upgrade/jobs/:id`

An upgrade job.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/upgrade/jobs/<id>"
```

#### `GET /api/backups`

The backups on disk.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/backups"
```

#### `POST /api/backups`

Take a backup now.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ encrypt?: boolean }`
- **Answer:** `202 { job }`
- **Errors:** 400; 503
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/backups"
```

#### `GET /api/backups/jobs/:id`

A backup, verify or restore job.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/backups/jobs/<id>"
```

#### `POST /api/backups/verify`

Verify a backup.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ name: string }`
- **Answer:** `202 { job }`
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"name":"…"}' "$BUDDI_URL/api/backups/verify"
```

#### `POST /api/backups/restore`

Restore a backup over this installation (typed-back confirmation required).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ name, passphrase?, confirm } as JSON, or the archive bytes with X-Filename, X-Backup-Passphrase, X-Backup-Confirm`
- **Answer:** `202 { job }`
- **Errors:** 400; 409
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/backups/restore"
```

#### `GET /api/backups/schedule`

The backup schedule.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/backups/schedule"
```

#### `PUT /api/backups/schedule`

Change the backup schedule.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 400; 409 a checkout schedules its own
- **Since:** 0.1.0-pre.15

```sh
curl -X PUT -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/backups/schedule"
```

#### `GET /api/backups/passphrase`

The backup passphrase. Refused while a lock-screen PIN is set: use POST …/reveal.

- **Auth:** Dashboard session only. It reads or stores a secret.
- **Answer:** `{ passphrase }`
- **Errors:** 403 { needsPin: true }
- **Since:** 0.1.0-pre.15

```sh
curl -b cookies.txt "$BUDDI_URL/api/backups/passphrase"
```

#### `POST /api/backups/passphrase/reveal`

The backup passphrase, behind the lock-screen PIN when there is one (counted like an unlock try).

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ pin?: string }`
- **Answer:** `{ passphrase }`
- **Errors:** 403 wrong or missing PIN; 429 too many tries
- **Since:** 0.1.0-pre.41

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/backups/passphrase/reveal"
```

#### `GET /api/backups/passphrase/notice`

Home's passphrase card: the six words once an encrypted backup exists, until they are acknowledged. With a lock-screen PIN set the words stay back (needsPin) and the card reveals them with POST …/reveal.

- **Auth:** Dashboard session only; from the computer buddi runs on. It reads or stores a secret.
- **Answer:** `{ show: false } or { show: true, passphrase } or { show: true, needsPin: true }`
- **Errors:** 403 not this computer
- **Since:** 0.1.0-pre.41

```sh
curl -b cookies.txt "$BUDDI_URL/api/backups/passphrase/notice"
```

#### `POST /api/backups/passphrase/notice`

"I saved it": the passphrase card goes for good.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** `{ acknowledgedAt }`
- **Since:** 0.1.0-pre.41

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/backups/passphrase/notice"
```

#### `PUT /api/backups/passphrase`

Set the backup passphrase.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It reads or stores a secret.
- **Body:** `{ passphrase: string }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X PUT -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"passphrase":"…"}' "$BUDDI_URL/api/backups/passphrase"
```

#### `GET /api/system/cli`

buddi.app's command line tool: whether this buddi offers it and where it is installed.

- **Auth:** Session or API token; from the computer buddi runs on.
- **Answer:** `{ available, installed: string[], reason? }`
- **Since:** 0.1.0-pre.41

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/system/cli"
```

#### `POST /api/system/cli`

Install buddi.app's command line tool: /usr/local/bin/buddi (an administrator prompt), else ~/.local/bin/buddi.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It installs or runs code buddi has not run before.
- **Answer:** `{ file, lines: string[] }`
- **Errors:** 409 npm's buddi is on PATH, another program's buddi is there, or this is not buddi.app
- **Since:** 0.1.0-pre.41

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/system/cli"
```

#### `GET /api/system/uninstall`

Remove buddi from this Mac: what goes, and a confirmation token for the next two calls.

- **Auth:** Dashboard session only; from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Answer:** `{ available, data, keychain?, service?, app?, backups, appFinishes, token } or { available: false, reason }`
- **Errors:** 403 not this computer
- **Since:** 0.1.0-pre.41

```sh
curl -b cookies.txt "$BUDDI_URL/api/system/uninstall"
```

#### `POST /api/system/uninstall/backup`

The last backup, moved to ~/buddi-backups with <archive>.passphrase.txt beside it.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It reads or stores a secret.
- **Body:** `{ token: string }`
- **Answer:** `202 { job }`
- **Errors:** 403 expired token or not this computer; 409 a checkout, a restore or an upgrade
- **Since:** 0.1.0-pre.41

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"token":"…"}' "$BUDDI_URL/api/system/uninstall/backup"
```

#### `GET /api/system/uninstall/jobs/:id`

Where the last backup has got to; when done, its report has the archive, the passphrase file and the six words.

- **Auth:** Dashboard session only; from the computer buddi runs on. It reads or stores a secret.
- **Answer:** `{ phase, finishedAt?, error?, report?: { archive, passphraseFile?, passphrase? } }`
- **Since:** 0.1.0-pre.41

```sh
curl -b cookies.txt "$BUDDI_URL/api/system/uninstall/jobs/<id>"
```

#### `POST /api/system/uninstall`

Remove buddi: the supervisor runs buddi uninstall (buddi.app finishes it and moves itself to the Trash). Needs the last backup taken first.

- **Auth:** Dashboard session only (a session adds CSRF + Origin); from the computer buddi runs on. It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `{ token: string, wroteItDown: true, keepData?: boolean }`
- **Answer:** `202 { accepted: true }`
- **Errors:** 400 not ticked; 403 expired token or not this computer; 409 no backup yet
- **Since:** 0.1.0-pre.41

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"token":"…","wroteItDown":"…"}' "$BUDDI_URL/api/system/uninstall"
```

#### `GET /api/recovery`

After a restore: the checklist to get through (active: false otherwise).

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/recovery"
```

#### `POST /api/recovery/leave`

Leave recovery: drop pending work, keep the grants listed, restart.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes what an agent may do without asking.
- **Body:** `{ dropPending?: boolean, keepGrants?: string[] }`
- **Answer:** `202 (restarting) or 200`
- **Errors:** 400; 502 the restart could not be asked for
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/recovery/leave"
```

### First run

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| GET | `/api/onboarding` | Where first run stands and what it still needs, with the chapter 3 tiles withbuddi.com lists plugins for. | yes |
| POST | `/api/onboarding/step` | Record a step done. | yes |
| POST | `/api/onboarding/complete` | Finish first run. | yes |
| POST | `/api/onboarding/skip` | Skip first run. | yes |
| GET | `/api/onboarding/agent` | The assistant’s persona, for “change”. | yes |
| POST | `/api/onboarding/agent` | Write the first agent. | yes |
| POST | `/api/onboarding/agent/update` | Change the assistant’s name, face or purpose. | yes |
| POST | `/api/onboarding/brain` | Move the assistant (and the maker following it) to an account and model. | yes |
| GET | `/api/onboarding/ollama` | Is Ollama running on this computer, is it installed, and which model suits it. | yes |
| GET | `/api/onboarding/ollama/pull` | How the model fetch into the local Ollama stands. | yes |
| POST | `/api/onboarding/ollama/pull` | Fetch a model into the local Ollama, with progress. | yes |
| GET | `/api/onboarding/mlxh` | Is mlxh running on this computer. | yes |
| GET | `/api/onboarding/take-on` | Chapter 3's progress, per plugin. | yes |
| POST | `/api/onboarding/take-on` | Record what buddi takes on and start those installs. | no |
| POST | `/api/onboarding/restore` | Restore instead of starting, while nothing is set up yet. | no |

#### `GET /api/onboarding`

Where first run stands and what it still needs, with the chapter 3 tiles withbuddi.com lists plugins for.

- **Auth:** Session or API token.
- **Answer:** `{ state, stepsDone, details, needs, offers: string[] }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding"
```

#### `POST /api/onboarding/step`

Record a step done.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ step: string, conversationId?, accountId?, reach?: { phone?, mailbox?, app?, browser?: boolean } }`
- **Answer:** JSON
- **Errors:** 400
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"step":"…"}' "$BUDDI_URL/api/onboarding/step"
```

#### `POST /api/onboarding/complete`

Finish first run.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Errors:** 409 still needs a model account or an agent
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/complete"
```

#### `POST /api/onboarding/skip`

Skip first run.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Answer:** JSON
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/skip"
```

#### `GET /api/onboarding/agent`

The assistant’s persona, for “change”.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Errors:** 404 no assistant yet
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/agent"
```

#### `POST /api/onboarding/agent`

Write the first agent.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ name, handle, description, instructions?, avatar?, accountId? }`
- **Answer:** `{ agent, id, handle, file, live, accountId }`
- **Errors:** 400; 409 there is one
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/onboarding/agent"
```

#### `POST /api/onboarding/agent/update`

Change the assistant’s name, face or purpose.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ name?, description?, instructions?, avatar? }`
- **Answer:** JSON
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{}' "$BUDDI_URL/api/onboarding/agent/update"
```

#### `POST /api/onboarding/brain`

Move the assistant (and the maker following it) to an account and model.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ accountId: string, model: string }`
- **Answer:** JSON
- **Errors:** 400; 404
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"accountId":"…","model":"…"}' "$BUDDI_URL/api/onboarding/brain"
```

#### `GET /api/onboarding/ollama`

Is Ollama running on this computer, is it installed, and which model suits it.

- **Auth:** Session or API token.
- **Answer:** `{ running, models, baseUrl, downloadUrl, cloudBaseUrl, machine: { platform, memoryGb, gpu, installed, recommended, install, cloudSuggested }, pull }`
- **Since:** 0.1.0-pre.15

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/ollama"
```

#### `GET /api/onboarding/ollama/pull`

How the model fetch into the local Ollama stands.

- **Auth:** Session or API token.
- **Answer:** `{ pull: { model, state, completed, total, status, error? } | null }`
- **Since:** 0.1.0-pre.37

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/ollama/pull"
```

#### `POST /api/onboarding/ollama/pull`

Fetch a model into the local Ollama, with progress.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ model: string }`
- **Answer:** `202 { pull }`
- **Errors:** 400 not a model name; 409 another fetch is going
- **Since:** 0.1.0-pre.37

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"model":"…"}' "$BUDDI_URL/api/onboarding/ollama/pull"
```

#### `GET /api/onboarding/mlxh`

Is mlxh running on this computer.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.25

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/mlxh"
```

#### `GET /api/onboarding/take-on`

Chapter 3's progress, per plugin.

- **Auth:** Session or API token.
- **Answer:** JSON
- **Since:** 0.1.0-pre.25

```sh
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/onboarding/take-on"
```

#### `POST /api/onboarding/take-on`

Record what buddi takes on and start those installs.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It installs or runs code buddi has not run before.
- **Body:** `{ tiles: string[] }`
- **Answer:** `202`
- **Errors:** 400
- **Since:** 0.1.0-pre.25

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" -H "Content-Type: application/json" -d '{"tiles":[]}' "$BUDDI_URL/api/onboarding/take-on"
```

#### `POST /api/onboarding/restore`

Restore instead of starting, while nothing is set up yet.

- **Auth:** Dashboard session only (a session adds CSRF + Origin). It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.
- **Body:** `as /api/backups/restore, without confirm`
- **Answer:** JSON
- **Errors:** 409 already set up
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" "$BUDDI_URL/api/onboarding/restore"
```

### Speech

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| POST | `/api/speech/transcribe` | Transcribe an uploaded recording (the speech plugin). | yes |
| POST | `/api/speech/say` | Speak a text (the speech plugin). | yes |

#### `POST /api/speech/transcribe`

Transcribe an uploaded recording (the speech plugin).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ artifactId: string, conversationId? }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.21

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"artifactId":"…"}' "$BUDDI_URL/api/speech/transcribe"
```

#### `POST /api/speech/say`

Speak a text (the speech plugin).

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ text: string, conversationId? }`
- **Answer:** JSON
- **Since:** 0.1.0-pre.21

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"text":"…"}' "$BUDDI_URL/api/speech/say"
```

### MCP

| Method | Path | What it does | Token |
| --- | --- | --- | --- |
| POST | `/api/mcp/request` | A write asked for through buddi mcp. Never applied here: it becomes an approval; poll GET /api/approvals/:id. | yes |

#### `POST /api/mcp/request`

A write asked for through buddi mcp. Never applied here: it becomes an approval; poll GET /api/approvals/:id.

- **Auth:** Session or API token (a session adds CSRF + Origin).
- **Body:** `{ kind: string, input: object, client?: string }`
- **Answer:** `202 { approvalId, … }`
- **Errors:** 400; 500
- **Since:** 0.1.0-pre.15

```sh
curl -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" -d '{"kind":"…","input":{}}' "$BUDDI_URL/api/mcp/request"
```
