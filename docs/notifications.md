# Notifications

What buddi tells you without being asked, when it tells you, and where.

A **surface** is where you talk to buddi: the dashboard, the Telegram chat.
A **channel** is how buddi reaches you when you are not looking: a
Telegram message, a notification on this computer. Telegram is both. Core decides what reaches you and when;
a channel only carries it.

## What reaches you

| Kind | What it is | Urgency |
| --- | --- | --- |
| `approval` | A run that nobody is watching wants to do something gated, and waits for you. | `now` |
| `question` | A run asked you something and waits for the answer. Questions are asked inside a conversation you are in today, so none arrive here yet. | `now` |
| `watcher` | A watcher or a source found something: a wake-up, a mail worth reading. | `now` |
| `reminder` | A reminder an agent promised you came due. | `now` |
| `failure` | Background jobs died and will not be retried. | `now` |
| `recap` | A mission's report, the weekly recap, the learning digest, the answer to an action you tapped. | `now` |
| `plugin` | A plugin that declared `owner:notify` has something to say. | its choice |

A mission that decides to stay silent sends nothing and writes nothing here.

## When and where

| Urgency | You are on the dashboard | You are away |
| --- | --- | --- |
| `now` | Kept for the dashboard. If you have not seen it after 10 minutes, it goes to your channel anyway. | Your channel, at once. |
| `today` | Kept for the dashboard. | One line in the end-of-day message on your channel. |
| `digest` | Kept for the record. | Kept for the record; the recap can read it. |

- **On the dashboard** means the page told buddi in the last two minutes
  that you are looking at it: the page tells buddi every 30 seconds while it
  is in front, and says so when you leave it. Telegram messages you send count as being on
  Telegram, and a message then goes to Telegram straight away.
- **The end of the day** is 18:00 on your clock (the timezone in your owner
  profile, else `BUDDI_TZ`). Everything held for the day goes out as one
  message: "Today, 3 things:", then one line each with the agent's name.
  Anything you already dealt with is left out.
- **Quiet hours** hold `now` messages until they end, except approvals and
  questions: you asked for those by starting the run.
- **The same thing again.** A message with the same key as one not yet sent
  replaces it rather than adding a second. The same key more than three
  times in an hour waits for the end-of-day message, and says so once.
- **Nowhere to go.** With no channel, nothing fails: the message is kept, and
  its row says `no channel`. A channel that refuses or errors is written on
  the row the same way. Nothing retries it.

Titles and text are scrubbed for your stored secrets before they are kept
or sent. Where you are is never sent anywhere.

## On the dashboard

- **A card at the top right** for each `now` message kept for the dashboard:
  the title, its first line, the agent's face, and "See" when it has a link.
  Drawing it marks it seen, so it does not go to your channel ten minutes
  later. Three at most; the rest wait under "and N more". Dismissing one is
  the same as seeing it. The page checks for new ones every 30 seconds while
  you are there, and when you come back to it.
- **Home, under "Needs you"**: watcher finds, reminders, failures, reports
  and plugin messages not seen yet, and whatever is held for the end of the
  day, one line each with the agent. Approvals keep their own cards and are
  not listed twice. The greeting counts them.
- **Settings → Notifications**: the default channel with a "Send a test"
  button for each, a channel or Off per kind (approvals and questions cannot
  be off), quiet hours and the end of the day, and the last twenty messages
  with where each went and whether you saw it.

## Settings

Kept in `core.notification_settings`; every value has a default, so no row
is a complete answer.

| Setting | Default | What it does |
| --- | --- | --- |
| Default channel | Telegram, else the system notification, else the first there is | Where messages go. |
| Per kind | the default channel | A channel, or `off`: kept for the record, never sent. Approvals and questions cannot be off. |
| Quiet hours | none | Start and end on your clock, like `22:00` and `07:00`. |
| End of day | `18:00` | When the day's held items go out. |

## Channels

| Channel | Kind | What it sends | What leaves the machine |
| --- | --- | --- | --- |
| Telegram | `telegram.chat` | The message as text, with offers as buttons. An approval is the card with its Approve and Reject buttons, the same one a run in the chat gets. | The title and text, to Telegram. |
| System notification | `local.notification` | The title and the first 200 characters of the text, on the computer buddi runs on. | Nothing. |

- **Telegram** is registered when the bot is running.
- **System notification** is registered at boot where there is something to
  show on. On a Mac, `terminal-notifier` when it is installed (a click opens
  the dashboard, on this machine's address), otherwise `osascript`'s
  `display notification` (a click opens nothing). The service is a user
  LaunchAgent, so it runs in your session and can show one. On Linux,
  `notify-send` when it is installed and `DISPLAY` or `WAYLAND_DISPLAY` is
  set for the service. Anywhere else, no channel. A command that fails or
  takes more than 5 seconds is refused, with the first line it printed as
  the reason.

With no default picked, messages go to Telegram, then the system
notification, then a plugin's channel. A channel is registered with
`registerChannel({ kind, describe, can, priority?, deliver })`; `deliver`
answers `{ id }`, `'refused'` or `{ refused: reason }`, or throws.

## The record

`core.owner_notifications` has one row per message: `kind`, `urgency`,
`title`, `text`, `link` (a dashboard route), `offers`, `dedupe_key`,
`agent_id`, `plugin_id`, `action_id` (an approval's action), `state`,
`due_at`, `channel`, `created_at`, `sent_at`, `seen_at`, `acted_at`,
`error`.

| State | Means |
| --- | --- |
| `shown` | Kept for the dashboard; `due_at` is when it goes to the channel if unseen. |
| `held` | Waiting for `due_at`: the end of the day, or the end of quiet hours. |
| `stored` | Kept for the record, never sent. |
| `sending` | One delivery has it. |
| `sent` | A channel took it; `channel` says which. |
| `failed` | No channel took it; `error` says why. |

`seen_at` is set when the dashboard shows it or you open its link.
`acted_at` is set when you decide the approval it names, wherever you
decide it. A notification never adds a dot or a count to the rail: what is
waiting is still only pending approvals and held questions
([architecture.md](architecture.md), "The attention model").

`core.owner_presence` has one row per surface: `surface`, `last_active_at`,
`away_at`.

## The API

In core:

```ts
notifyOwner(pool, { now?, timezone? }, {
  kind, urgency, title, text?, link?: { route }, offers?, dedupeKey?, agentId?,
}): Promise<{ id, state, channel, error, deduped, lowered }>
notificationsTick(pool, deps, now)   // the gateway runs it every 60 s
markSeen(pool, id), markActed(pool, id), listNotifications(pool, { limit })
listDigestNotifications(pool, since)
presenceTouch(pool, surface, now, 'active' | 'away'), ownerPresent(pool, now)
registerChannel(channel), deliverTo(kind, message)
```

For a plugin, `ctx.buddi.owner.notify({ urgency, title, text?, link?,
dedupeKey?, agentId? })`, declared as `owner:notify`
([plugin-host-api.md](plugin-host-api.md) §4.2). The kind is always
`plugin`; the owner's settings pick the channel.

The dashboard's endpoints:

| Request | Answers |
| --- | --- |
| `GET /api/notifications?limit=20` | `{ notifications }`, newest first, at most 100. |
| `POST /api/notifications/:id/seen` | `{ ok: true }`, or 404. |
| `GET /api/notifications/settings` | `{ settings, channels }`. |
| `PUT /api/notifications/settings` | The whole value replaced; 400 with a sentence when it cannot be. |
| `POST /api/notifications/test` `{ channel }` | `{ ok: true }` once that channel took one line; 404 for a channel that is not there, 502 with a sentence when it refused. Not recorded. |
| `POST /api/presence` `{ state: 'active' \| 'away' }` | `{ ok: true }`. The page sends `active` when it loads or comes back in front and every 30 seconds while it stays there, and `away` on blur or hide; at most one a second. |
