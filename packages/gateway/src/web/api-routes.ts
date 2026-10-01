/**
 * The dashboard's HTTP API, described: one row per method and path.
 *
 * The router itself stays where it is — `path === …` comparisons and regular
 * expressions in `server.ts` and the modules it hands a prefix to — and this
 * table is what is *said* about each route: what it is for, what it takes,
 * what it answers, how it fails, and whether an owner API token may call it.
 *
 * It is held to the source in both directions by `api-routes.test.ts` (every
 * path the source dispatches has a row here, and every row here is a path the
 * source dispatches), it renders `docs/api.md` (`pnpm docs:api`), and the
 * server reads it at run time for one thing: a request carrying an API token
 * is answered only on a row whose `token` is not refused (docs/api.md,
 * "Authentication").
 *
 * Shapes are written TypeScript-style and name the fields a client relies on.
 * Where a route answers a whole page's view, `answer` names its top-level
 * fields; the dashboard's own types in packages/web/src/api.ts are the long
 * form.
 */

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What travels: JSON both ways unless said. */
export type ApiKind = 'json' | 'stream' | 'bytes' | 'upload' | 'socket';

export interface ApiRoute {
  method: ApiMethod;
  /** `/api/…` with `:name` for each path parameter. */
  path: string;
  area: ApiArea;
  summary: string;
  /** Query parameters, `name: shape` comma-separated. */
  query?: string;
  /** The JSON body, or for an upload what to send. */
  body?: string;
  /** The success answer: its status when not 200, then its shape. */
  answer?: string;
  /** The failures a client should expect, beyond the gate's 401/403/423/429. */
  errors?: string;
  kind?: ApiKind;
  /**
   * An owner API token may not call this, and why. The dashboard (a signed-in
   * session) can. Absent: a token may call it like a session can.
   */
  token?: TokenRefusal;
  /** Answered while the dashboard is locked (the lock screen draws from it). */
  whileLocked?: true;
  /** Only from a browser on the computer buddi runs on. */
  localOnly?: true;
}

/** Why a token is refused a route: the four kinds of change only a person at the dashboard makes. */
export const TOKEN_REFUSALS = {
  decides: 'It decides an approval, or the click is the approval. A token never decides for the owner.',
  grants: 'It changes what an agent may do without asking.',
  code: 'It installs or runs code buddi has not run before.',
  access: 'It changes how buddi is reached, unlocked or signed in to, or replaces the whole installation.',
  secret: 'It reads or stores a secret.',
  socket: 'A socket with its own gate: the browser extension pairs, the remote hand needs the dashboard session.',
} as const;
export type TokenRefusal = keyof typeof TOKEN_REFUSALS;

/** The sections of docs/api.md, in order. */
export const API_AREAS = {
  session: 'Session and lock screen',
  tokens: 'API tokens',
  home: 'Home',
  chat: 'Chat',
  groups: 'Groups',
  agents: 'Agents',
  approvals: 'Approvals, offers and proposals',
  work: 'Missions, jobs, reminders and watchers',
  notifications: 'Notifications',
  memory: 'Memory',
  files: 'Files',
  owner: 'Your profile',
  accounts: 'Model accounts',
  connections: 'Connections',
  plugins: 'Plugins and plugin pages',
  secrets: 'Keys and secrets',
  computer: 'Computer and browser',
  telegram: 'Telegram',
  system: 'Backups, version and service',
  onboarding: 'First run',
  speech: 'Speech',
  mcp: 'MCP',
} as const;
export type ApiArea = keyof typeof API_AREAS;

const UUID = 'uuid';
const ERR = '{ error: string }';

export const API_ROUTES: readonly ApiRoute[] = [
  /* ---------------- session and lock screen ---------------- */
  {
    method: 'GET', path: '/api/session', area: 'session', whileLocked: true,
    summary: 'Who is signed in, the CSRF value writes must echo, and facts every page formats with.',
    answer: "{ csrf: string, timezone: string, timeFormat: '12h'|'24h'|null, dateFormat: 'short'|'long'|'iso'|null, host: string, port: number, platform: string, recovery: boolean, scope: 'local'|'remote', signedInThrough: 'local'|'ticket'|'tailscale'|'token', tailscaleName?: string, tailscaleLogin?: string, expiresAt: string, version: string }",
  },
  {
    method: 'GET', path: '/api/lock', area: 'session', whileLocked: true,
    summary: 'The lock screen state: whether a PIN is set and this session is locked.',
    answer: '{ pin: boolean, locked: boolean, lockedAt: string|null, settings: { delayMinutes, background, clock }, image: string|null, … }',
  },
  {
    method: 'POST', path: '/api/lock', area: 'session', whileLocked: true, token: 'access',
    summary: 'Lock this session now.', body: "{ reason?: 'owner'|'idle' }",
    answer: 'the lock state', errors: '409 no PIN is set, or the client is not covered by the lock screen',
  },
  {
    method: 'GET', path: '/api/lock/screen', area: 'session', whileLocked: true,
    summary: 'What the lock screen draws: the time, counts waiting, the focus line, its widgets.',
    query: 'hour?: number',
  },
  {
    method: 'POST', path: '/api/lock/unlock', area: 'session', whileLocked: true, token: 'access',
    summary: 'Unlock with the PIN.', body: '{ pin: string }  // four to eight digits',
    answer: 'the lock state', errors: '400 not a PIN; 403 wrong PIN; 429 wait before trying again',
  },
  {
    method: 'POST', path: '/api/lock/activity', area: 'session', token: 'access',
    summary: 'The page saying the owner is using it, which pushes back the idle lock.', answer: '204',
  },
  {
    method: 'PUT', path: '/api/lock/pin', area: 'session', token: 'access',
    summary: 'Set or change the PIN.', body: '{ pin: string, current?: string }  // current when one is set',
    answer: 'the lock state', errors: '400 not a PIN, or the current PIN missing; 403 wrong current PIN',
  },
  {
    method: 'POST', path: '/api/lock/pin/remove', area: 'session', token: 'access',
    summary: 'Remove the PIN.', body: '{ current: string }', answer: 'the lock state', errors: '400; 403 wrong PIN',
  },
  {
    method: 'PUT', path: '/api/lock/settings', area: 'session', token: 'access',
    summary: 'Lock after, background and clock.',
    body: "{ delayMinutes?: 1|5|15|60|null, background?: string, clock?: { time, date, zone } }",
    answer: 'the lock state', errors: '400 a value out of range; 409 the picture background with no picture',
  },
  {
    method: 'GET', path: '/api/lock/background', area: 'session', whileLocked: true, kind: 'bytes',
    summary: "The lock screen's own picture, as JPEG.", answer: 'image/jpeg, with an ETag', errors: '404 there is no picture',
  },
  {
    method: 'POST', path: '/api/lock/background', area: 'session', kind: 'upload', token: 'access',
    summary: 'Upload the lock screen picture.', body: 'multipart/form-data with one image file, at most 10 MB',
    answer: 'the lock state', errors: '413 too large; 415 not a picture',
  },
  {
    method: 'DELETE', path: '/api/lock/background', area: 'session', token: 'access',
    summary: 'Remove the lock screen picture (the background goes back to a built-in one).', answer: 'the lock state',
  },
  {
    method: 'GET', path: '/api/tailscale', area: 'session',
    summary: 'Tailscale sign-in: the stored setting, the daemon, and the command that serves this dashboard on the tailnet.',
    answer: '{ enabled: boolean, login: string, available: boolean, self: { login, name }|null, proxied: boolean, serveCommand: string }',
  },
  {
    method: 'PUT', path: '/api/tailscale', area: 'session', localOnly: true, token: 'access',
    summary: 'Turn Tailscale sign-in on or off, for one login. Every Tailscale session ends.',
    body: '{ enabled: boolean, login?: string }', answer: 'as GET',
    errors: '400 not a Tailscale login; 403 not from the computer buddi runs on',
  },

  /* ---------------- API tokens ---------------- */
  {
    method: 'GET', path: '/api/api-tokens', area: 'tokens', token: 'access',
    summary: 'The owner API tokens: name, last four characters, when made and last used. Never the token.',
    answer: "{ tokens: Array<{ id, name, hint: string, scope: 'owner', createdVia: 'dashboard'|'cli', createdAt, lastUsedAt: string|null }> }",
  },
  {
    method: 'POST', path: '/api/api-tokens', area: 'tokens', token: 'access',
    summary: 'Make a token. The answer is the only time the token itself is shown.',
    body: '{ name: string }  // 1 to 60 characters', answer: '201 { token: string, apiToken: { id, name, hint, … } }',
    errors: '400 no name, or too long; 409 the limit of 20 live tokens',
  },
  {
    method: 'DELETE', path: '/api/api-tokens/:id', area: 'tokens', token: 'access',
    summary: 'Revoke a token. A request carrying it is refused from the next one on.', answer: '204',
    errors: '404 no live token with that id',
  },

  /* ---------------- home ---------------- */
  {
    method: 'GET', path: '/api/overview', area: 'home',
    summary: "Home's whole first read: plugin blocks and glances, and counts of approvals, jobs, missions, reminders, watchers.",
    answer: '{ now, timezone, paused, home: HomeBlock[], glances, approvals: { pending, oldestPendingAt }, jobs: Record<state, number>, missions, reminders, sentinels, mail, running }',
  },
  { method: 'GET', path: '/api/tips', area: 'home', summary: 'Every tip and its state.', answer: '{ tips: Tip[], enabled: boolean }' },
  {
    method: 'GET', path: '/api/tips/current', area: 'home', summary: "Today's tip on Home, if any (picking one is remembered).",
    query: 'preview?: tip id  // show one as it would look, touching nothing', answer: '{ tip: Tip|null, enabled: boolean }',
    errors: '404 no tip by the preview id',
  },
  { method: 'GET', path: '/api/tips/settings', area: 'home', summary: 'Whether tips are on.', answer: '{ enabled: boolean }' },
  { method: 'PUT', path: '/api/tips/settings', area: 'home', summary: 'Turn tips on or off.', body: '{ enabled: boolean }', answer: '{ enabled: boolean }' },
  { method: 'POST', path: '/api/tips/seen-page', area: 'home', summary: 'Record that a page was opened (tips about it stop).', body: '{ page: string }', answer: '{ ok: true }' },
  { method: 'POST', path: '/api/tips/:id/dismiss', area: 'home', summary: 'Never show this tip again.', answer: '{ ok: true }', errors: '404 no such tip' },
  { method: 'POST', path: '/api/tips/:id/later', area: 'home', summary: 'Show this tip another day.', answer: '{ ok: true }', errors: '404 no such tip' },
  { method: 'POST', path: '/api/tips/:id/restore', area: 'home', summary: 'Bring a dismissed tip back.', answer: '{ ok: true }', errors: '404 no such tip' },
  {
    method: 'GET', path: '/api/widgets', area: 'home', summary: 'The widget gallery, the layout and each placed widget’s body.',
    query: "surface?: 'home'|'lock', hour?: number", answer: '{ gallery, placed: Array<{ id, widget, size, body, updatedAt, … }>, … }',
  },
  {
    method: 'PUT', path: '/api/widgets/home', area: 'home', summary: "Save Home's widget layout.",
    body: "{ placed: Array<{ id, widget, size: 'small'|'medium', settings? }> }", answer: 'the widgets view', errors: '400 an unknown widget or a bad setting',
  },
  {
    method: 'PUT', path: '/api/widgets/lock', area: 'home', summary: "Save the lock screen's widgets (up to four).",
    body: 'as /api/widgets/home', answer: 'the widgets view', errors: '400',
  },
  { method: 'GET', path: '/api/widgets/settings/:widget', area: 'home', summary: "A widget's settings schema.", errors: '404 no such widget' },
  { method: 'POST', path: '/api/widgets/preview', area: 'home', summary: 'One widget’s body with settings not yet saved.', body: '{ widget: string, settings?: object, size? }', errors: '400' },
  {
    method: 'POST', path: '/api/widgets/:placement/refresh', area: 'home', summary: 'Produce one placed widget again, now.',
    query: "surface?: 'home'|'lock', hour?: number", answer: 'the widgets view',
  },
  {
    method: 'POST', path: '/api/home/glances/:id/hidden', area: 'home', summary: 'Hide a Home glance or show it again.',
    body: '{ hidden: boolean }', errors: '404 no such glance',
  },
  { method: 'GET', path: '/api/rail', area: 'home', summary: 'Which plugin pages the owner hid from the rail.', answer: '{ hidden: Array<{ plugin, page }> }' },
  {
    method: 'POST', path: '/api/rail/pages/:plugin/:page/hidden', area: 'home', summary: 'Hide a plugin page from the rail or show it again.',
    body: '{ hidden: boolean }', errors: '404 no such page',
  },
  {
    method: 'GET', path: '/api/events', area: 'home', summary: 'The event log, newest first, paged.',
    query: 'kind?, q?: text in the payload, since?: event id, before?: event id, limit?: 1–500 (100)',
    answer: '{ events: Array<{ id, kind, conversationId, payload, createdAt }>, nextCursor: string|null, latest: string|null }',
  },
  { method: 'GET', path: '/api/events/kinds', area: 'home', summary: 'Every event kind in the log, with its count.', answer: '{ kinds: Array<{ kind, count }> }' },
  { method: 'POST', path: '/api/pause', area: 'home', summary: 'Pause or resume the installation: nothing new is claimed while paused.', body: '{ paused: boolean }' },

  /* ---------------- chat ---------------- */
  { method: 'GET', path: '/api/chat/agents', area: 'chat', summary: 'The agents a chat can be with, with their pictures.', answer: '{ agents: Array<{ id, name, handle, avatar, … }>, default: string }' },
  { method: 'GET', path: '/api/chat/attention', area: 'chat', summary: 'Which agents are waiting on the owner, and why.' },
  {
    method: 'GET', path: '/api/chat/attention/stream', area: 'chat', kind: 'stream',
    summary: 'Server-sent events: one empty frame whenever /api/chat/attention would answer differently.',
    query: 'since?: event id (or Last-Event-ID)', errors: '429 too many open streams for this session',
  },
  { method: 'GET', path: '/api/chat/views', area: 'chat', summary: 'How installed plugins want their tool output drawn.', answer: '{ views: ViewMapping[] }' },
  {
    method: 'GET', path: '/api/chat/:agent/conversations', area: 'chat', summary: "An agent's conversations, newest first.",
    query: 'limit?: number', answer: '{ conversations: Array<{ id, startedAt, lastMessageAt, messageCount, opening }> }', errors: '404 no such agent',
  },
  {
    method: 'POST', path: '/api/chat/:agent/conversations', area: 'chat', summary: 'Start a new conversation with an agent.',
    answer: '{ conversationId: string }', errors: '404 no such agent; 503 chat is not running in this process',
  },
  {
    method: 'POST', path: '/api/chat/:agent/messages', area: 'chat',
    summary: 'Send a message. The turn is accepted, not answered: follow the conversation stream for the reply.',
    body: '{ text: string, conversationId?: string, attachmentIds?: string[], client?: string }',
    answer: '202 { conversationId, runId, queued?: true, pendingId? }  // queued: the agent was working and took it as an interjection',
    errors: '400 a field of the wrong type; 404 no such agent; 503 chat is not running',
  },
  {
    method: 'GET', path: '/api/chat/conversations/:id', area: 'chat', summary: 'A conversation’s transcript: messages, tool calls, runs.',
    answer: '{ id, agentId, messages, runs, usage, carryOver?, … }', errors: '404 no such conversation',
  },
  {
    method: 'GET', path: '/api/chat/conversations/:id/stream', area: 'chat', kind: 'stream',
    summary: 'Server-sent events for one conversation: messages, tool calls, approvals, the run ending.',
    query: 'since?: event id (or Last-Event-ID)', errors: '404 no such conversation; 429 too many open streams',
  },
  {
    method: 'POST', path: '/api/chat/conversations/:id/cancel', area: 'chat', summary: 'Stop the run in progress (a group’s current request, in a group).',
    answer: '{ cancelled: boolean } or { stopped: true }', errors: '503 chat is not running',
  },
  {
    method: 'DELETE', path: '/api/chat/conversations/:id/carry-over', area: 'chat',
    summary: 'Drop the note a rollover carried into this conversation; it leaves every later turn’s context.', answer: '204',
  },
  {
    method: 'POST', path: '/api/chat/questions/:id/answer', area: 'chat', summary: 'Answer a question an agent asked in the chat.',
    body: '{ answer: string, optionId?: string } or { skipped: true }', answer: '202', errors: '400; 404 no open question; 409 already answered',
  },
  {
    method: 'POST', path: '/api/chat/attachments', area: 'chat', kind: 'upload', summary: 'Upload a file for the next message.',
    query: 'conversationId?: string', body: 'multipart/form-data with one file, at most 20 MB',
    answer: '{ artifactId, filename, mime, kind, sizeBytes }', errors: '413 too large; 503 attachments unavailable',
  },
  {
    method: 'GET', path: '/api/conversations', area: 'chat', summary: 'Every conversation, newest first (Activity).',
    query: 'limit?: number (50)', answer: '{ conversations: Array<{ id, agentId, createdAt, messageCount, lastMessageAt, opening, runs, usage }> }',
  },
  {
    method: 'GET', path: '/api/conversations/:id', area: 'chat', summary: 'One conversation as Activity shows it.',
    answer: '{ id, agentId, createdAt, messages, runs, usage }', errors: '404 no such conversation',
  },

  /* ---------------- groups ---------------- */
  { method: 'GET', path: '/api/groups', area: 'groups', summary: 'The groups.', answer: '{ groups: Array<{ id, name, coordinator, members, … }> }' },
  {
    method: 'POST', path: '/api/groups', area: 'groups', summary: 'Make a group.',
    body: '{ name: string, coordinator: agent id, members: agent id[] }', answer: 'the group',
    errors: '400 a missing name, an unknown agent, or fewer than two agents',
  },
  {
    method: 'GET', path: '/api/groups/:id', area: 'groups', summary: 'One group: who is in it, its latest conversation and request.',
    answer: '{ …group, latestConversationId, openRequest, history: { conversations, messages } }', errors: '404 no such group',
  },
  {
    method: 'PATCH', path: '/api/groups/:id', area: 'groups', summary: 'Rename, change the coordinator, or change who is in it; what is left out stays.',
    body: '{ name?: string, coordinator?: agent id, members?: agent id[] }', answer: 'the group', errors: '400; 404 no such group',
  },
  {
    method: 'DELETE', path: '/api/groups/:id', area: 'groups', summary: 'Delete a group. Undo works for a minute.',
    answer: '{ undoUntil: string }', errors: '404 no such group',
  },
  { method: 'POST', path: '/api/groups/:id/restore', area: 'groups', summary: 'Undo a delete, within the minute.', answer: 'the group', errors: '410 too late' },
  { method: 'POST', path: '/api/groups/:id/archive', area: 'groups', summary: 'Archive a group.', answer: '204', errors: '404' },
  {
    method: 'POST', path: '/api/groups/:id/clear', area: 'groups', summary: "Clear the group's history; members and memory stay.",
    answer: '{ conversations: number }', errors: '404',
  },
  {
    method: 'GET', path: '/api/groups/:id/conversations', area: 'groups', summary: "A group's conversations.",
    answer: '{ conversations: Array<{ id, startedAt, lastMessageAt, messageCount, opening }> }', errors: '404',
  },
  { method: 'POST', path: '/api/groups/:id/conversations', area: 'groups', summary: 'Start a new conversation in a group.', answer: '{ conversationId }', errors: '404' },
  {
    method: 'POST', path: '/api/groups/:id/messages', area: 'groups', summary: 'Send a message to a group (its coordinator answers).',
    body: '{ text: string, conversationId?: string, attachmentIds?: string[] }', answer: '202 { conversationId, runId, requestId, rolledOver? }',
    errors: '400; 404; 503 chat is not running',
  },

  /* ---------------- agents ---------------- */
  {
    method: 'GET', path: '/api/agents', area: 'agents', summary: 'Every agent, their engines, the model accounts and which agent is the default.',
    answer: '{ agents: AgentView[], engines, providers, providerAccounts, default }',
  },
  { method: 'POST', path: '/api/agents/default', area: 'agents', summary: 'Make an agent the default (where a chat that names nobody lands).', body: '{ agentId: string }', errors: '400; 404' },
  { method: 'GET', path: '/api/agents/:id/profile', area: 'agents', summary: "One agent whole: its grant with every tool's tier, engine, skills, delegates.", errors: '404 no such agent' },
  { method: 'GET', path: '/api/agents/:id/skills', area: 'agents', summary: 'Every skill the agent loads; learned ones with their versions.', errors: '404' },
  {
    method: 'POST', path: '/api/agents/:id/skills/:skill/remove', area: 'agents', summary: 'Remove a learned skill (its versions are kept).',
    errors: '404; 409 not a learned skill',
  },
  { method: 'GET', path: '/api/agents/:id/tools', area: 'agents', summary: 'Every installed tool, for the agent’s tool picker.', errors: '404' },
  {
    method: 'GET', path: '/api/agents/:id/file', area: 'agents', summary: "The agent's file as written: front matter and persona.",
    answer: '{ id, file, frontmatter, persona }', errors: '404',
  },
  {
    method: 'POST', path: '/api/agents/:id/file', area: 'agents', token: 'grants',
    summary: "Edit the agent's front matter: name, handle, tools, persona…; checked as the loader checks it.",
    body: 'the editable front matter fields (packages/core ownerEditableInput)', errors: '400 with the loader’s sentence',
  },
  {
    method: 'POST', path: '/api/agents/:id/delegates', area: 'agents', token: 'grants',
    summary: 'Which agents this one may hand work to.', body: '{ delegates: agent id[] }', errors: '400; 404',
  },
  {
    method: 'POST', path: '/api/agents/:id/engine', area: 'agents', summary: 'Change engine settings (effort, context, idle rollover…).',
    body: 'engine fields; the account and model go through /account', errors: '400',
  },
  {
    method: 'POST', path: '/api/agents/:id/account', area: 'agents', summary: 'Put the agent on a model account and model.',
    body: '{ accountId: string, model?: string }', errors: '400; 404; 503 accounts unavailable',
  },
  {
    method: 'GET', path: '/api/agents/:id/avatar', area: 'agents', kind: 'bytes', summary: "The agent's picture (PNG, or the file its front matter names).",
    answer: 'an image, with an ETag', errors: '404 no picture',
  },
  {
    method: 'POST', path: '/api/agents/:id/avatar', area: 'agents', kind: 'upload', summary: 'Upload a picture: PNG, GIF or SVG, at most 1 MB, made square.',
    body: 'multipart/form-data with one image', answer: '{ picture: string, side: number, source, note? }', errors: '404; 413; 415',
  },
  { method: 'DELETE', path: '/api/agents/:id/avatar', area: 'agents', summary: "Remove the uploaded picture; the agent's icon is drawn again.", answer: '204', errors: '404' },
  { method: 'GET', path: '/api/teammates', area: 'agents', summary: '"Add a teammate": the starter team and plugin teammates, each added, addable, or why not.' },
  { method: 'GET', path: '/api/agent-offers', area: 'agents', summary: 'Agents a plugin offers while nobody has them.' },
  { method: 'POST', path: '/api/agent-offers/:plugin/:agent/dismiss', area: 'agents', summary: 'Stop offering this agent.', errors: '404' },

  /* ---------------- approvals, offers, proposals ---------------- */
  {
    method: 'GET', path: '/api/approvals', area: 'approvals', summary: 'Approvals waiting on the owner, and recent decisions.',
    query: 'limit?: number (50)', answer: '{ pending: ApprovalView[], recent: ApprovalView[] }',
  },
  {
    method: 'GET', path: '/api/approvals/:id', area: 'approvals', summary: 'One action whole: the envelope the approval is bound to and the preview the tool rendered.',
    answer: '{ action: ApprovalView }', errors: '404 no such action',
  },
  {
    method: 'POST', path: '/api/approvals/:id/approve', area: 'approvals', token: 'decides',
    summary: 'Approve an action.', body: "{ permissionScope?: 'once'|'conversation'|'always', ownerChoices?: Record<string, string> }",
    errors: '400 a bad scope or choice; 404; 409 already decided or expired',
  },
  {
    method: 'POST', path: '/api/approvals/:id/reject', area: 'approvals', summary: 'Reject an action. Saying no is never refused to a token.',
    errors: '404; 409 already decided or expired',
  },
  {
    method: 'GET', path: '/api/offers', area: 'approvals', summary: 'What agents offered to do next.',
    query: 'limit?: number', answer: '{ offers: Offer[], … }',
  },
  {
    method: 'POST', path: '/api/offers/:id/take', area: 'approvals', summary: 'Take an offer: its run starts (here if the page has its conversation open).',
    body: '{ conversationId?: string }', errors: '404; 409 no longer open',
  },
  { method: 'POST', path: '/api/offers/:id/dismiss', area: 'approvals', summary: 'Dismiss an offer.', errors: '404' },
  { method: 'POST', path: '/api/offers/dismiss-all', area: 'approvals', summary: 'Dismiss several offers.', body: '{ ids: string[] }' },
  {
    method: 'GET', path: '/api/proposals', area: 'approvals', summary: 'What agents proposed to change (skills, rules), and the weekly digest.',
    answer: '{ open, recent, digest: { latest, schedule } }',
  },
  {
    method: 'POST', path: '/api/proposals/:id/keep', area: 'approvals', token: 'decides',
    summary: 'Keep a proposal: its change is applied.', body: '{ text?: string }  // the edited text, when the owner edited it', errors: '404; 409',
  },
  { method: 'POST', path: '/api/proposals/:id/discard', area: 'approvals', summary: 'Discard a proposal.', body: '{ reason?: string }', errors: '404; 409' },
  { method: 'POST', path: '/api/proposals/keep-all', area: 'approvals', token: 'decides', summary: 'Keep a group of open rule proposals.', body: '{ ids: string[] }' },
  {
    method: 'POST', path: '/api/proposals/digest-schedule', area: 'approvals', summary: "The weekly digest's day and hour.",
    body: '{ day: 0–6, hour: 0–23 }', answer: '{ schedule }', errors: '400',
  },

  /* ---------------- missions, jobs, reminders, watchers ---------------- */
  { method: 'GET', path: '/api/missions', area: 'work', summary: 'Every mission, its schedule, next run and recent occurrences.', answer: '{ missions: MissionView[] }' },
  { method: 'POST', path: '/api/missions/:id/enabled', area: 'work', summary: 'Switch a mission on or off.', body: '{ enabled: boolean }', errors: '404' },
  {
    method: 'POST', path: '/api/missions/:id/schedule', area: 'work', summary: 'Change a mission’s schedule (a new revision).',
    body: "{ cron?: string, timezone?: string, misfirePolicy?: 'skip'|'run-once', deadlineMinutes?: number|null }", errors: '400; 404',
  },
  {
    method: 'GET', path: '/api/jobs', area: 'work', summary: 'The job queue, paged.',
    query: 'state?, kind?, limit?, offset?', answer: '{ jobs: JobView[], total, counts }',
  },
  { method: 'POST', path: '/api/jobs/:id/retry', area: 'work', summary: 'Retry a failed job.', errors: '404; 409 not failed' },
  { method: 'POST', path: '/api/jobs/:id/cancel', area: 'work', summary: 'Cancel a queued or failed job.', errors: '404; 409' },
  { method: 'GET', path: '/api/reminders', area: 'work', summary: 'Reminders agents set, pending and past.', query: 'limit?: number', answer: '{ reminders }' },
  { method: 'POST', path: '/api/reminders/:id/cancel', area: 'work', summary: 'Cancel a pending reminder.', body: '{ reason?: string }', errors: '404; 409' },
  {
    method: 'GET', path: '/api/sentinels', area: 'work', summary: 'Watchers: each one, whether it is on, its last run and open findings.',
    query: 'limit?: number (50)',
  },
  { method: 'POST', path: '/api/sentinels/:id/enabled', area: 'work', summary: 'Switch a watcher off or on.', body: '{ enabled: boolean }', answer: '{ sentinelId, enabled }', errors: '400 no watcher with that id' },
  {
    method: 'POST', path: '/api/alerts/:key/snooze', area: 'work', summary: 'Snooze an open alert, or wake it.',
    body: '{ snoozed: boolean }', answer: '{ key, snoozedAt: string|null }', errors: '404 no open alert with that key',
  },

  /* ---------------- notifications ---------------- */
  { method: 'GET', path: '/api/notifications', area: 'notifications', summary: 'The notifications buddi sent, newest first.', query: 'limit?: number' },
  { method: 'POST', path: '/api/notifications/:id/seen', area: 'notifications', summary: 'Mark a notification seen.', errors: '404' },
  { method: 'GET', path: '/api/notifications/settings', area: 'notifications', summary: 'Where and when buddi reaches the owner.', answer: '{ settings, channels }' },
  { method: 'PUT', path: '/api/notifications/settings', area: 'notifications', summary: 'Change the notification settings.', body: 'the settings object', answer: '{ settings, channels }', errors: '400' },
  { method: 'GET', path: '/api/notifications/focus', area: 'notifications', summary: 'The focus mode now.', answer: '{ focus }' },
  {
    method: 'PUT', path: '/api/notifications/focus', area: 'notifications', summary: 'Set the focus mode, for a while or until changed.',
    body: "{ mode: 'normal'|'urgent-only'|'do-not-disturb', duration?: string }", answer: '{ focus }', errors: '400',
  },
  { method: 'POST', path: '/api/notifications/test', area: 'notifications', summary: 'Send a test notification on a channel.', body: '{ channel: string }', errors: '400; 404; 502 the channel failed' },
  { method: 'POST', path: '/api/notifications/agent-mute', area: 'notifications', summary: "Mute or unmute an agent's notifications.", body: '{ agentId: string, muted: boolean }', errors: '400' },
  {
    method: 'POST', path: '/api/presence', area: 'notifications', summary: 'Whether the owner is at the dashboard, which decides where a notification goes.',
    body: "{ state: 'active'|'away' }", answer: '{ ok: true }', errors: '400',
  },

  /* ---------------- memory ---------------- */
  {
    method: 'GET', path: '/api/memory', area: 'memory', summary: 'What buddi remembers: preferences and notes.',
    query: 'agent?: agent id  // what that agent sees', errors: '503 memory unavailable',
  },
  {
    method: 'POST', path: '/api/memory/preferences', area: 'memory', summary: 'Set or correct a preference.',
    body: "{ key: lower_snake_case, value: string, scope?: 'shared'|agent id }", errors: '400',
  },
  { method: 'POST', path: '/api/memory/preferences/forget', area: 'memory', summary: 'Retire a preference.', body: '{ key: string, scope?: string }', answer: '204', errors: '404' },
  {
    method: 'POST', path: '/api/memory/notes/:id', area: 'memory', summary: 'Edit a note.',
    body: "{ content?: string, scope?: string, kind?: 'fact'|'observation'|'todo' }", errors: '400; 404',
  },
  { method: 'POST', path: '/api/memory/notes/:id/forget', area: 'memory', summary: 'Forget a note.', answer: '204', errors: '404' },

  /* ---------------- files ---------------- */
  {
    method: 'GET', path: '/api/artifacts', area: 'files', summary: 'The library: every file buddi holds, paged.',
    query: "q?, origin?: 'uploaded'|'produced'|'unknown', family?, limit?, cursor?", answer: '{ entries, nextCursor }', errors: '400 a bad filter or cursor',
  },
  {
    method: 'GET', path: '/api/artifacts/:id', area: 'files', summary: 'One file: its metadata, where it was used, whether its bytes are still there.',
    query: 'contexts?: offset', answer: '{ entry, contexts, available: boolean }', errors: '404',
  },
  { method: 'GET', path: '/api/artifacts/:id/download', area: 'files', kind: 'bytes', summary: 'The file, as a download.', errors: '404' },
  {
    method: 'GET', path: '/api/artifacts/:id/preview', area: 'files', kind: 'bytes',
    summary: 'The file inline, where it is safe to show: images, PDFs, text (as text/plain, its start only).', errors: '404; 415 not previewable',
  },
  {
    method: 'DELETE', path: '/api/artifacts/:id', area: 'files', summary: 'Take back a file uploaded from the dashboard that no message carries.',
    answer: '204', errors: '404; 409 already sent, or not from the dashboard',
  },

  /* ---------------- owner ---------------- */
  { method: 'GET', path: '/api/owner', area: 'owner', summary: 'The owner’s profile, places, and the timezones this host knows.', answer: '{ preferredName, timezone, language, about, timeFormat, dateFormat, places, detectedTimezone, zones }' },
  {
    method: 'POST', path: '/api/owner', area: 'owner', summary: 'Change the profile; what is left out stays.',
    body: "{ preferredName?, timezone?, language?, about?: string|null, timeFormat?: '12h'|'24h'|null, dateFormat?: 'short'|'long'|'iso'|null }", answer: 'as GET', errors: '400',
  },
  {
    method: 'POST', path: '/api/owner/places', area: 'owner', summary: 'Save a place (new, or by id).',
    body: '{ id?, label: string, name: string, address?: string, latitude: number, longitude: number, timezone?: string }', answer: '{ place, places }', errors: '400',
  },
  { method: 'POST', path: '/api/owner/places/find', area: 'owner', summary: 'Find a place by address or town (Open-Meteo).', body: '{ address: string }', answer: '{ found: Array<{ name, latitude, longitude, timezone? }> }', errors: '400; 502' },
  { method: 'POST', path: '/api/owner/places/remove', area: 'owner', summary: 'Remove a place.', body: '{ id: string }', answer: '{ removed, places }', errors: '404' },

  /* ---------------- model accounts ---------------- */
  {
    method: 'GET', path: '/api/provider-accounts', area: 'accounts', summary: 'Every model account, its state, models and agents; never a key.',
    errors: '503 accounts unavailable in this process',
  },
  { method: 'POST', path: '/api/provider-accounts/save', area: 'accounts', token: 'secret', summary: 'Add or change an account (a key, an address, a default model).', body: '{ id?, label, kind, apiKey?, baseUrl?, defaultModel, revision? }', errors: '400; 409 changed elsewhere' },
  { method: 'POST', path: '/api/provider-accounts/probe-models', area: 'accounts', summary: 'Ask a provider which models a key or address offers, before saving.', body: '{ kind, apiKey?, baseUrl?, accountId? }' },
  { method: 'POST', path: '/api/provider-accounts/:id/test', area: 'accounts', summary: 'Test an account with one small call.' },
  { method: 'POST', path: '/api/provider-accounts/:id/models', area: 'accounts', summary: 'The account’s models.', body: '{ refresh?: boolean }' },
  { method: 'POST', path: '/api/provider-accounts/:id/remove', area: 'accounts', summary: 'Remove an account.', body: '{ revision: number }', errors: '404; 409 agents still use it, or changed elsewhere' },
  { method: 'POST', path: '/api/provider-accounts/:id/login', area: 'accounts', token: 'secret', summary: 'Start a ChatGPT (Codex) device sign-in.', body: '{ revision? }' },
  { method: 'POST', path: '/api/provider-accounts/:id/cancel-login', area: 'accounts', summary: 'Cancel a sign-in in progress.' },
  { method: 'POST', path: '/api/provider-accounts/:id/logout', area: 'accounts', summary: 'Sign the account out (its stored sign-in is deleted).' },
  { method: 'POST', path: '/api/provider-accounts/:id/anthropic/login', area: 'accounts', token: 'secret', summary: 'Start a Claude subscription sign-in.' },
  { method: 'POST', path: '/api/provider-accounts/:id/anthropic/complete-login', area: 'accounts', token: 'secret', summary: 'Finish it with the code Claude showed.', body: '{ code: string }' },
  { method: 'POST', path: '/api/provider-accounts/:id/anthropic/cancel-login', area: 'accounts', summary: 'Cancel a Claude sign-in in progress.' },
  { method: 'POST', path: '/api/provider-accounts/:id/anthropic/logout', area: 'accounts', summary: 'Sign the Claude subscription out.' },
  { method: 'POST', path: '/api/provider-accounts/:id/ollama/connect', area: 'accounts', token: 'secret', summary: 'Start connecting an Ollama account.' },
  { method: 'POST', path: '/api/provider-accounts/:id/ollama/poll', area: 'accounts', summary: 'Ask whether the Ollama connection finished.' },
  { method: 'POST', path: '/api/provider-accounts/:id/ollama/disconnect', area: 'accounts', summary: 'Disconnect the Ollama account.' },
  { method: 'GET', path: '/api/providers', area: 'accounts', summary: 'Legacy global provider settings (installations without named accounts).', errors: '503' },
  { method: 'POST', path: '/api/providers/anthropic/settings', area: 'accounts', token: 'secret', summary: 'Legacy: Anthropic settings.', errors: '410 replaced by model accounts' },
  { method: 'POST', path: '/api/providers/anthropic/test', area: 'accounts', summary: 'Legacy: test Anthropic.', errors: '410' },
  { method: 'POST', path: '/api/providers/openai/settings', area: 'accounts', token: 'secret', summary: 'Legacy: OpenAI settings.', errors: '410' },
  { method: 'POST', path: '/api/providers/openai/test', area: 'accounts', summary: 'Legacy: test OpenAI.', errors: '410' },
  { method: 'POST', path: '/api/providers/credentials/:name/save', area: 'accounts', token: 'secret', summary: 'Legacy: save a credential.', errors: '410' },
  { method: 'POST', path: '/api/providers/credentials/:name/remove', area: 'accounts', summary: 'Legacy: remove a credential.', errors: '410' },

  /* ---------------- connections ---------------- */
  {
    method: 'GET', path: '/api/connections', area: 'connections', summary: 'Connected MCP services, the catalog, and the agents a connection can be given to.',
    answer: '{ connections, catalog, agents, vault: boolean, tokens: boolean, callbackPath }',
  },
  {
    method: 'POST', path: '/api/connections', area: 'connections', token: 'code', summary: 'Add a service by address, or a program to run (stdio).',
    body: "{ url: string, name?: string } or { transport: 'stdio', command, args?, env?, name? }", answer: '201 { connection, signIn }', errors: '400',
  },
  { method: 'GET', path: '/api/connections/signals', area: 'connections', summary: 'What needs the owner across connections (sign-ins lapsed, reviews pending).', answer: '{ signals }' },
  {
    method: 'POST', path: '/api/connections/callback', area: 'connections', summary: 'Finish a sign-in: the code and state the service sent back to /connections/callback.',
    body: '{ state: string, code?: string, error?: string }', errors: '400 no state; 409 not this session’s sign-in',
  },
  { method: 'GET', path: '/api/connections/remembered/:agent', area: 'connections', summary: "An agent's connection tools that ask first, and which are remembered.", answer: '{ agent, tools }', errors: '404' },
  {
    method: 'POST', path: '/api/connections/remembered', area: 'connections', token: 'grants', summary: 'Remember (or forget) the owner’s yes for one agent and tool.',
    body: '{ agent: string, tool: string, remember: boolean }', errors: '400; 404; 409 this tool is never remembered',
  },
  { method: 'GET', path: '/api/connections/:id', area: 'connections', summary: 'One connection.', errors: '404' },
  { method: 'DELETE', path: '/api/connections/:id', area: 'connections', summary: 'Disconnect: taken from every agent, its sign-in deleted.', errors: '404; 409 an agent file could not be changed' },
  { method: 'POST', path: '/api/connections/:id/consent', area: 'connections', summary: 'Start the service’s sign-in; answers the page to send the owner to.', body: '{ cli?: boolean, clientId?: string }', answer: '{ url, redirectUri, … }' },
  { method: 'POST', path: '/api/connections/:id/reconnect', area: 'connections', summary: 'Sign in again.', body: 'as consent' },
  { method: 'POST', path: '/api/connections/:id/token', area: 'connections', token: 'secret', summary: 'Sign in with a pasted token.', body: '{ token: string, header?: string, prefix?: string }', errors: '400' },
  { method: 'POST', path: '/api/connections/:id/device', area: 'connections', summary: 'Start a device sign-in (a code to type on the service’s page).' },
  { method: 'GET', path: '/api/connections/:id/review', area: 'connections', summary: 'The tools the service offers, for the owner to read before giving them out.' },
  { method: 'POST', path: '/api/connections/:id/review', area: 'connections', summary: 'Mark the review read.', body: '{ hash: string, slug?: string }', errors: '400' },
  {
    method: 'POST', path: '/api/connections/:id/grant', area: 'connections', token: 'grants', summary: 'Give the connection’s tools to agents.',
    body: '{ agents: agent id[], exact?: boolean }', answer: '{ granted, failed, connection }', errors: '400; 409 not reviewed, or nothing could be given',
  },
  {
    method: 'POST', path: '/api/connections/:id/holders/:agent', area: 'connections', token: 'grants', summary: 'Give or take the connection for one agent.',
    body: '{ held: boolean }', answer: '{ agent, held, connection }', errors: '400; 404; 409',
  },
  { method: 'GET', path: '/api/connections/:id/tools', area: 'connections', summary: "The connection's tools and their tiers.", answer: '{ connection, tools }' },
  { method: 'PUT', path: '/api/connections/:id/program', area: 'connections', token: 'code', summary: 'Change a program connection’s command (POST works too).', body: '{ command, args?, env? }' },

  /* ---------------- plugins and pages ---------------- */
  { method: 'GET', path: '/api/plugins', area: 'plugins', summary: 'Installed plugins, staged ones waiting to be read, and the trust sentence.' },
  { method: 'POST', path: '/api/plugins/stage', area: 'plugins', token: 'code', summary: 'Fetch a plugin to read before installing (npm name, tarball path or folder).', body: '{ spec: string }', answer: '202 { job }', errors: '400' },
  {
    method: 'POST', path: '/api/plugins/upload', area: 'plugins', token: 'code', kind: 'upload', summary: 'Stage a plugin tarball sent as the body.',
    body: 'the .tgz bytes; X-Filename header', answer: '202 { job }', errors: '400',
  },
  { method: 'GET', path: '/api/plugins/jobs/:id', area: 'plugins', summary: 'A staging, install or update job.', errors: '404' },
  {
    method: 'POST', path: '/api/plugins/staged/:id/approve', area: 'plugins', token: 'code',
    summary: 'Install what was staged; carries back the integrity the owner was shown.', body: '{ integrity: string, acknowledgeDrift?: boolean }', errors: '400; 404; 409 it changed',
  },
  { method: 'POST', path: '/api/plugins/staged/:id/reject', area: 'plugins', summary: 'Throw a stage away.' },
  { method: 'POST', path: '/api/plugins/staged/:id/opened', area: 'plugins', summary: 'Record that the owner opened the install card.' },
  { method: 'POST', path: '/api/plugins/:name/update', area: 'plugins', token: 'code', summary: 'Update a plugin.', body: '{ version?: string, from?: string }', answer: '202 { job }' },
  { method: 'POST', path: '/api/plugins/:name/uninstall', area: 'plugins', token: 'code', summary: 'Uninstall a plugin; its data too with purge.', body: '{ purge?: boolean, confirm?: string }', errors: '409 confirmation needed' },
  { method: 'POST', path: '/api/plugins/:name/disable', area: 'plugins', summary: 'Disable a plugin (its tools and pages go; data stays).' },
  { method: 'POST', path: '/api/plugins/:name/enable', area: 'plugins', summary: 'Enable it again.' },
  {
    method: 'POST', path: '/api/plugins/:plugin/agents/:agent/accept', area: 'plugins', token: 'decides',
    summary: 'Accept an agent a plugin proposes: the owner’s click is the approval.', errors: '404; 409',
  },
  { method: 'GET', path: '/api/plugins/folders', area: 'plugins', summary: 'Folders under the owner’s home, for "a directory I built".', query: 'path?: string', errors: '400; 403 outside home; 404' },
  { method: 'GET', path: '/api/market', area: 'plugins', summary: 'The plugin list from withbuddi.com (fetched when asked, kept a day).', query: 'refresh?: 1' },
  { method: 'GET', path: '/api/market/asset', area: 'plugins', kind: 'bytes', summary: 'A listing’s screenshot, fetched through the gateway.', query: 'url: string', errors: '400; 415; 502' },
  { method: 'GET', path: '/api/pages', area: 'plugins', summary: 'The screens installed plugins contribute, as descriptors.' },
  {
    method: 'GET', path: '/api/pages/:plugin/:query', area: 'plugins', summary: "One plugin page query, its parameters checked by the query's schema.",
    query: 'the query’s own parameters', answer: '{ data }', errors: '400 the plugin’s sentence; 404 no such query',
  },
  {
    method: 'POST', path: '/api/pages/:plugin/act', area: 'plugins', summary: "A write from a plugin's page, as the owner: an auto tool runs; a gated one answers an approval to decide. An API token may only ask: it gets the approval of a gated tool, and 403 for one that would run at once.",
    body: '{ tool: string, args?: object }', answer: '{ result } or { approvalId }', errors: '400; 403 a token, and a tool that runs without an approval; 404 not a tool of this page; 429',
  },
  {
    method: 'GET', path: '/api/preview/:plugin/:name/link', area: 'plugins', summary: 'A one-use link into a plugin preview, on the preview origin.',
    answer: '{ url: string }', errors: '404; 429; 503 previews not served',
  },
  { method: 'GET', path: '/api/preview/:plugin/:name/check', area: 'plugins', summary: 'Is the preview served, and does it assume it owns a host.' },

  /* ---------------- secrets ---------------- */
  { method: 'GET', path: '/api/secrets', area: 'secrets', summary: 'Owner secrets by name, with where each may be used. Never a value.' },
  { method: 'GET', path: '/api/secrets/uses', area: 'secrets', summary: 'Where a secret was used.', query: 'name: string, limit?: number' },
  { method: 'POST', path: '/api/secrets/act', area: 'secrets', token: 'secret', summary: 'Add, change or remove a secret or its rules.', body: '{ tool: string, args: object }', errors: '400; 429' },

  /* ---------------- computer and browser ---------------- */
  {
    method: 'GET', path: '/api/host', area: 'computer', summary: 'Host execution: standing permissions and recent runs.',
    query: 'agentId?, conversationId?', answer: '{ permissions, runs }',
  },
  { method: 'POST', path: '/api/host/stop', area: 'computer', summary: 'Stop an agent’s running commands in a conversation.', body: '{ agentId: string, conversationId: string }', answer: '{ stopped }' },
  { method: 'POST', path: '/api/host/revoke', area: 'computer', summary: 'Revoke a standing host-execution permission.', body: '{ id: uuid }', answer: '{ revoked: true }', errors: '400; 404' },
  { method: 'GET', path: '/api/host/apps', area: 'computer', summary: 'Apps installed on this computer.', answer: '{ apps }' },
  { method: 'GET', path: '/api/host/browser-profiles', area: 'computer', summary: "A browser app's profiles.", query: 'app: string', answer: '{ profiles }' },
  { method: 'GET', path: '/api/browser', area: 'computer', summary: "The agents' browser: installed, running, its session and page.", query: 'agentId?, conversationId?' },
  {
    method: 'GET', path: '/api/browser/screenshot', area: 'computer', kind: 'bytes', summary: 'The browser’s current screen, as JPEG.',
    query: 'sessionId?, v?: page id', errors: '404 no screen, or not the session or page asked for',
  },
  { method: 'POST', path: '/api/browser/install', area: 'computer', token: 'code', summary: 'Download the browser agents use (about 150 MB); follow on GET /api/browser.', answer: '202', errors: '409' },
  { method: 'POST', path: '/api/browser/check', area: 'computer', summary: 'Launch the browser once to see it starts.', answer: '{ ok: boolean, message? }' },
  { method: 'POST', path: '/api/browser/settings', area: 'computer', token: 'grants', summary: 'Change the browser control modes.', errors: '409' },
  { method: 'POST', path: '/api/browser/permissions', area: 'computer', summary: 'Check (and optionally ask for) the operating system’s permissions.', body: '{ prompt?: boolean }', errors: '400; 409' },
  { method: 'POST', path: '/api/browser/stop', area: 'computer', summary: 'Stop the browser session.', body: '{ sessionId?: string }' },
  { method: 'POST', path: '/api/browser/takeover', area: 'computer', summary: 'Take over the screen from the agent.', body: '{ sessionId?: string }', answer: 'the status, with hand: boolean' },
  { method: 'POST', path: '/api/browser/resume', area: 'computer', summary: 'Give the screen back to the agent.', body: '{ sessionId?: string }' },
  { method: 'POST', path: '/api/browser/release', area: 'computer', summary: 'Release the session.', body: '{ sessionId?: string }' },
  { method: 'GET', path: '/api/browser/hand', area: 'computer', kind: 'socket', token: 'socket', summary: 'WebSocket: drive the taken-over screen (the CSRF value is the first frame).' },
  { method: 'GET', path: '/api/extension', area: 'computer', summary: 'The browser extension: paired or not, connected or not.' },
  { method: 'POST', path: '/api/extension/pair', area: 'computer', token: 'access', summary: 'Pair the extension with the code it shows.', body: '{ code: string }', errors: '400; 429 five tries in five minutes' },
  { method: 'DELETE', path: '/api/extension/pair', area: 'computer', summary: 'Forget the paired extension.' },
  { method: 'GET', path: '/api/extension/socket', area: 'computer', kind: 'socket', token: 'socket', summary: "WebSocket: the paired extension's own connection." },

  /* ---------------- telegram ---------------- */
  { method: 'GET', path: '/api/telegram', area: 'telegram', summary: 'Telegram: configured, running, paired.' },
  { method: 'GET', path: '/api/telegram/bot', area: 'telegram', summary: 'Which bot.' },
  { method: 'GET', path: '/api/telegram/devices', area: 'telegram', summary: 'The phones paired with it.' },
  { method: 'POST', path: '/api/telegram/token', area: 'telegram', token: 'access', summary: 'Save the bot token BotFather gave.', body: '{ token: string }', errors: '400 not a token Telegram accepts' },
  { method: 'POST', path: '/api/telegram/pairing', area: 'telegram', token: 'access', summary: 'A pairing code for a phone.', answer: '{ code, expiresAt, … }' },
  { method: 'DELETE', path: '/api/telegram/devices/:id', area: 'telegram', summary: 'Unpair a phone, now.', answer: '204', errors: '404' },

  /* ---------------- system ---------------- */
  { method: 'GET', path: '/api/service', area: 'system', summary: 'Is buddi run by a supervisor, and its status.', answer: '{ supervised: boolean, supervisor?, status? }', errors: '502; 503 the supervisor does not answer' },
  { method: 'POST', path: '/api/service/start', area: 'system', summary: 'Start through the supervisor.', errors: '404 no supervisor; 502; 503' },
  { method: 'POST', path: '/api/service/stop', area: 'system', summary: 'Stop buddi. Accepted, then done once the answer is sent; nothing answers after.', answer: "202 { supervised: true, pending: 'stop' }", errors: '404 no supervisor' },
  { method: 'POST', path: '/api/service/restart', area: 'system', summary: 'Restart buddi; it is back in seconds.', answer: "202 { supervised: true, pending: 'restart' }", errors: '404 no supervisor' },
  { method: 'GET', path: '/api/version', area: 'system', summary: 'What is running, and what upgrading did before.' },
  { method: 'POST', path: '/api/version/check', area: 'system', summary: 'Check for a newer version now.', errors: '409; 503' },
  { method: 'PUT', path: '/api/version/check', area: 'system', summary: 'Turn the daily check on or off.', body: '{ enabled: boolean }', errors: '400' },
  { method: 'POST', path: '/api/upgrade', area: 'system', token: 'code', summary: 'Upgrade (then the gateway restarts).', body: '{ version?: string }', answer: '202 { job }', errors: '400; 409; 503' },
  { method: 'GET', path: '/api/upgrade/jobs/:id', area: 'system', summary: 'An upgrade job.', errors: '404' },
  { method: 'GET', path: '/api/backups', area: 'system', summary: 'The backups on disk.' },
  { method: 'POST', path: '/api/backups', area: 'system', summary: 'Take a backup now.', body: '{ encrypt?: boolean }', answer: '202 { job }', errors: '400; 503' },
  { method: 'GET', path: '/api/backups/jobs/:id', area: 'system', summary: 'A backup, verify or restore job.', errors: '404' },
  { method: 'POST', path: '/api/backups/verify', area: 'system', summary: 'Verify a backup.', body: '{ name: string }', answer: '202 { job }', errors: '400; 404' },
  {
    method: 'POST', path: '/api/backups/restore', area: 'system', token: 'access', summary: 'Restore a backup over this installation (typed-back confirmation required).',
    body: '{ name, passphrase?, confirm } as JSON, or the archive bytes with X-Filename, X-Backup-Passphrase, X-Backup-Confirm', answer: '202 { job }', errors: '400; 409',
  },
  { method: 'GET', path: '/api/backups/schedule', area: 'system', summary: 'The backup schedule.' },
  { method: 'PUT', path: '/api/backups/schedule', area: 'system', summary: 'Change the backup schedule.', errors: '400; 409 a checkout schedules its own' },
  { method: 'GET', path: '/api/backups/passphrase', area: 'system', token: 'secret', summary: 'The backup passphrase.', answer: '{ passphrase }' },
  { method: 'PUT', path: '/api/backups/passphrase', area: 'system', token: 'secret', summary: 'Set the backup passphrase.', body: '{ passphrase: string }', errors: '400' },
  { method: 'GET', path: '/api/recovery', area: 'system', summary: 'After a restore: the checklist to get through (active: false otherwise).' },
  {
    method: 'POST', path: '/api/recovery/leave', area: 'system', token: 'grants', summary: 'Leave recovery: drop pending work, keep the grants listed, restart.',
    body: '{ dropPending?: boolean, keepGrants?: string[] }', answer: '202 (restarting) or 200', errors: '400; 502 the restart could not be asked for',
  },

  /* ---------------- first run ---------------- */
  { method: 'GET', path: '/api/onboarding', area: 'onboarding', summary: 'Where first run stands and what it still needs.' },
  { method: 'POST', path: '/api/onboarding/step', area: 'onboarding', summary: 'Record a step done.', body: '{ step: string, conversationId?, accountId?, reach?: { phone?, mailbox?, app?, browser?: boolean } }', errors: '400' },
  { method: 'POST', path: '/api/onboarding/complete', area: 'onboarding', summary: 'Finish first run.', errors: '409 still needs a model account or an agent' },
  { method: 'POST', path: '/api/onboarding/skip', area: 'onboarding', summary: 'Skip first run.' },
  { method: 'GET', path: '/api/onboarding/agent', area: 'onboarding', summary: 'The assistant’s persona, for “change”.', errors: '404 no assistant yet' },
  {
    method: 'POST', path: '/api/onboarding/agent', area: 'onboarding', summary: 'Write the first agent.',
    body: '{ name, handle, description, instructions?, avatar?, accountId? }', answer: '{ agent, id, handle, file, live, accountId }', errors: '400; 409 there is one',
  },
  { method: 'POST', path: '/api/onboarding/agent/update', area: 'onboarding', summary: 'Change the assistant’s name, face or purpose.', body: '{ name?, description?, instructions?, avatar? }', errors: '400; 404' },
  { method: 'POST', path: '/api/onboarding/brain', area: 'onboarding', summary: 'Move the assistant (and the maker following it) to an account and model.', body: '{ accountId: string, model: string }', errors: '400; 404' },
  { method: 'GET', path: '/api/onboarding/ollama', area: 'onboarding', summary: 'Is Ollama running on this computer.' },
  { method: 'GET', path: '/api/onboarding/mlxh', area: 'onboarding', summary: 'Is mlxh running on this computer.' },
  { method: 'GET', path: '/api/onboarding/take-on', area: 'onboarding', summary: "Chapter 3's progress, per plugin." },
  { method: 'POST', path: '/api/onboarding/take-on', area: 'onboarding', token: 'code', summary: 'Record what buddi takes on and start those installs.', body: '{ tiles: string[] }', answer: '202', errors: '400' },
  {
    method: 'POST', path: '/api/onboarding/restore', area: 'onboarding', token: 'access', summary: 'Restore instead of starting, while nothing is set up yet.',
    body: 'as /api/backups/restore, without confirm', errors: '409 already set up',
  },

  /* ---------------- speech ---------------- */
  { method: 'POST', path: '/api/speech/transcribe', area: 'speech', summary: 'Transcribe an uploaded recording (the speech plugin).', body: '{ artifactId: string, conversationId? }' },
  { method: 'POST', path: '/api/speech/say', area: 'speech', summary: 'Speak a text (the speech plugin).', body: '{ text: string, conversationId? }' },

  /* ---------------- mcp ---------------- */
  {
    method: 'POST', path: '/api/mcp/request', area: 'mcp', summary: 'A write asked for through buddi mcp. Never applied here: it becomes an approval; poll GET /api/approvals/:id.',
    body: '{ kind: string, input: object, client?: string }', answer: '202 { approvalId, … }', errors: '400; 500',
  },
];

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

const compiled = API_ROUTES.map((route) => ({
  route,
  re: new RegExp(`^${route.path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`),
  literal: route.path.split('/').filter((seg) => !seg.startsWith(':')).length,
}));

/**
 * The row for a request, or undefined. HEAD is GET. Where a literal path and
 * a template both match (`/api/agents/default` and `/api/agents/:id/…`), the
 * one with more literal segments wins, as the router's order does.
 */
export function matchApiRoute(method: string, pathname: string): ApiRoute | undefined {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const path = pathname.replace(/\/+$/, '') || '/api';
  let best: { route: ApiRoute; literal: number } | undefined;
  for (const c of compiled) {
    if (c.route.method !== m || !c.re.test(path)) continue;
    if (!best || c.literal > best.literal) best = { route: c.route, literal: c.literal };
  }
  return best?.route;
}

/* ------------------------------------------------------------------ *
 * The reference page
 * ------------------------------------------------------------------ */

export function authOf(route: ApiRoute): string {
  const who = route.token ? 'Dashboard session only' : 'Session or API token';
  const csrf = route.method === 'GET' ? '' : ' (a session adds CSRF + Origin)';
  return `${who}${csrf}${route.localOnly ? '; from the computer buddi runs on' : ''}${route.whileLocked ? '; answered while locked' : ''}`;
}

function curlFor(route: ApiRoute): string {
  const url = `"$BUDDI_URL${route.path.replace(/:([a-z]+)/gi, (_, name: string) => `<${name}>`)}"`;
  // A route a token may not call is shown the way a session calls it (docs/api.md, "A session from a script").
  const auth = !route.token
    ? '-H "Authorization: Bearer $BUDDI_TOKEN"'
    : route.method === 'GET' ? '-b cookies.txt' : '-b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL"';
  if (route.kind === 'socket') return '';
  if (route.kind === 'upload') return `curl ${auth} -F "file=@./file" ${url}`;
  if (route.kind === 'stream') return `curl -N ${auth} ${url}`;
  if (route.method === 'GET') return `curl ${auth} ${url}${route.kind === 'bytes' ? ' -o out' : ''}`;
  const body = route.body && route.body.startsWith('{') && !route.body.includes(' or ')
    ? ` -H "Content-Type: application/json" -d '${exampleBody(route.body)}'`
    : '';
  return `curl -X ${route.method} ${auth}${body} ${url}`;
}

/** A plausible JSON body from a shape: required fields only, a placeholder each. */
function exampleBody(shape: string): string {
  const inner = shape.replace(/\/\/.*$/, '').trim().replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  const fields: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if ('{[<('.includes(ch)) depth += 1;
    if ('}]>)'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { fields.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') fields.push(current);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const m = /^\s*([A-Za-z_]+)(\?)?\s*:\s*(.*)$/.exec(field);
    if (!m || m[2] === '?') continue;
    const type = m[3]!.trim();
    out[m[1]!] = /^boolean/.test(type) ? true
      : /^number|^\d/.test(type) ? 0
        : /\[\]$|^Array/.test(type) ? []
          : /^object|^\{|^Record/.test(type) ? {}
          : /^'([^']+)'/.test(type) ? /^'([^']+)'/.exec(type)![1]
            : '…';
  }
  return JSON.stringify(out);
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** docs/api.md's body, from the table. `intro` is the hand-written opening. */
export function renderApiReference(routes: readonly ApiRoute[] = API_ROUTES, intro: string = API_INTRO): string {
  const out: string[] = [intro.trimEnd(), ''];
  out.push('## Routes', '');
  out.push(
    `${routes.length} routes in ${Object.keys(API_AREAS).length} areas. Paths are under the dashboard's address; \`:name\` is a path parameter.`,
    '**Token** says whether an API token may call the route; where it may not, the example uses a dashboard session.',
    '**Since** is the first release with the route; 0.1.0-pre.15 is the earliest release in the public history, so it also stands for earlier.',
    '',
  );
  for (const [area, title] of Object.entries(API_AREAS)) {
    const rows = routes.filter((r) => r.area === area);
    if (rows.length === 0) continue;
    out.push(`- [${title}](#${title.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')})`);
  }
  out.push('');
  for (const [area, title] of Object.entries(API_AREAS)) {
    const rows = routes.filter((r) => r.area === area);
    if (rows.length === 0) continue;
    out.push(`### ${title}`, '');
    out.push('| Method | Path | What it does | Token |', '| --- | --- | --- | --- |');
    for (const r of rows) out.push(`| ${r.method} | \`${r.path}\` | ${cell(r.summary)} | ${r.token ? 'no' : 'yes'} |`);
    out.push('');
    for (const r of rows) {
      out.push(`#### \`${r.method} ${r.path}\``, '');
      out.push(r.summary, '');
      const facts: string[] = [];
      facts.push(`- **Auth:** ${authOf(r)}.${r.token ? ` ${TOKEN_REFUSALS[r.token]}` : ''}`);
      if (r.kind && r.kind !== 'json') facts.push(`- **Kind:** ${{ stream: 'server-sent events (text/event-stream)', bytes: 'bytes, not JSON', upload: 'an upload', socket: 'a WebSocket upgrade' }[r.kind]}`);
      if (r.query) facts.push(`- **Query:** \`${r.query}\``);
      if (r.body) facts.push(`- **Body:** \`${r.body}\``);
      facts.push(`- **Answer:** ${r.answer ? `\`${r.answer}\`` : 'JSON'}`);
      if (r.errors) facts.push(`- **Errors:** ${r.errors}`);
      facts.push(`- **Since:** ${API_SINCE[`${r.method} ${r.path}`] ?? 'unreleased'}`);
      out.push(...facts, '');
      const curl = curlFor(r);
      if (curl) out.push('```sh', curl, '```', '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The opening of docs/api.md: everything a client needs before the first route. */
export const API_INTRO = `# The HTTP API

Everything the dashboard does, it does through this API, so buddi works
without the dashboard: a script, another program or \`curl\` can do what the
page does. This page is generated from the gateway's route table
(\`packages/gateway/src/web/api-routes.ts\`) by \`pnpm docs:api\`, and a test
fails when a route is missing from it.

## Where it is

The API is served by the gateway, on the dashboard's own address, under
\`/api\`:

- **This computer:** \`http://127.0.0.1:4317\` by default (\`BUDDI_WEB_PORT\`
  changes the port; \`buddi status\` prints the address).
- **Your tailnet:** the HTTPS address \`tailscale serve\` gives the dashboard
  (Settings → System → Tailscale prints the command).

Requests and answers are JSON (\`Content-Type: application/json\`), except
where a route says *bytes*, *upload*, *server-sent events* or *WebSocket*. A
JSON body is at most 64 KB. Paths ignore a trailing slash.

## Authentication

Every \`/api\` route answers only the owner. There are two ways to be the
owner:

**An API token** — for scripts and programs. Make one in Settings → API
tokens, or in a terminal:

\`\`\`sh
buddi api-token create "home automation"
\`\`\`

It is shown once. Send it on every request:

\`\`\`sh
export BUDDI_URL=http://127.0.0.1:4317 BUDDI_TOKEN=buddi_…
curl -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/overview"
\`\`\`

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

Those answer \`403 { "error": "An API token cannot …" }\`. Everything a gated
tool does still waits on its approval card, which the owner decides on the
dashboard or Telegram. Tokens are kept hashed (SHA-256); the gateway never
stores or logs the token itself. \`buddi api-token list\` and Settings show
each one's name, last four characters and when it was last used;
\`buddi api-token revoke <id>\` (or Revoke in Settings) ends it at the next
request.

**A dashboard session** — what the browser holds. It comes from a sign-in
link (\`buddi dashboard\`: a five-minute ticket, \`?t=…\`, exchanged at a
page URL and never under \`/api\`) or a Tailscale identity the owner allowed;
a source checkout bound to loopback also mints one for any request from this
computer. The session is a cookie
(\`buddi_session_<port>\`, HttpOnly, SameSite=Strict). Every request that is
not a GET or HEAD must also carry:

- \`X-Buddi-CSRF\`: the \`csrf\` value from \`GET /api/session\` (also in the
  \`buddi_csrf_<port>\` cookie, which must match), and
- \`Origin\`: the dashboard's own origin.

### A session from a script

A program on the computer buddi runs on can hold a session the way
\`buddi mcp\` does, which also reaches the routes a token may not: exchange
a five-minute ticket once, keep the cookies, and read the CSRF value.

\`\`\`sh
curl -s -c cookies.txt -o /dev/null "$BUDDI_URL/?t=$(buddi dashboard --token)"
CSRF=$(curl -s -b cookies.txt "$BUDDI_URL/api/session" | sed -E 's/.*"csrf":"([^"]+)".*/\\1/')
curl -b cookies.txt -H "X-Buddi-CSRF: $CSRF" -H "Origin: $BUDDI_URL" \\
  -H "Content-Type: application/json" -d '{"paused":true}' "$BUDDI_URL/api/pause"
\`\`\`

\`buddi dashboard --token\` reads the installation's own secret, so it works
only on that computer. A wrong or expired ticket counts as a failed sign-in.

## Answers and errors

A success is \`200\` with JSON unless the route says otherwise (\`201\`
created, \`202\` accepted and still running — follow the job or stream it
names, \`204\` no body). A refusal is a status with \`{ "error": "<a sentence
for a person>" }\`, sometimes with more fields. The gate answers before any
route, with an empty body:

| Status | Meaning |
| --- | --- |
| 401 | Not signed in: no session, or the token is unknown or revoked. |
| 403 | A write without its CSRF header or Origin; or, with JSON, a route a token may not call. |
| 404 | \`{ "error": "no such endpoint" }\` for a path that is not a route. |
| 405 | A method the path does not take. |
| 423 | \`{ "locked": true, … }\`: the dashboard session is locked (Settings → Lock screen). Tokens are not covered. |
| 429 | Too many failed sign-ins from this address; \`Retry-After\` says when to try again. |
| 503 | Tailscale could not be asked, or a part of buddi is not running in this process. |

## Rate limits and lockout

A request that presents a credential that is wrong — a stale session cookie,
an expired sign-in link, an unknown or revoked API token — counts as a failed
sign-in for its address: ten in a minute and that address is answered
\`429\` until the minute is over. Each distinct wrong value counts once a
window, so one forgotten client cannot lock the owner out on its own. All
tailnet and SSH-tunnel traffic arrives from 127.0.0.1 and shares one budget.
A request with no credential at all counts as nothing.

Beyond that: at most a few open event streams per session (\`429\`), five
extension pairing tries in five minutes, and plugin page writes have their
own limit.

## Streams

\`GET /api/chat/conversations/:id/stream\` and \`GET /api/chat/attention/stream\`
are server-sent events. Reconnect with \`Last-Event-ID\` (or \`?since=\`) to
resume where you left off. A turn sent with \`POST /api/chat/:agent/messages\`
is answered \`202\` at once; its reply arrives on the stream.

## Example: talk to an agent headless

\`\`\`sh
# who is there
curl -s -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/agents"
# say something to the default assistant (its id from the list above)
curl -s -X POST -H "Authorization: Bearer $BUDDI_TOKEN" -H "Content-Type: application/json" \\
  -d '{"text":"What is on my calendar today?"}' "$BUDDI_URL/api/chat/<agent>/messages"
# follow the reply
curl -N -H "Authorization: Bearer $BUDDI_TOKEN" "$BUDDI_URL/api/chat/conversations/<conversationId>/stream"
\`\`\`
`;

/**
 * The release each route first shipped in, from the history (the earliest
 * tag whose gateway source dispatched it). A route added since the last
 * release has no entry and reads "unreleased" until the release adds it.
 */
export const API_SINCE: Readonly<Record<string, string>> = {
  'GET /api/session': '0.1.0-pre.15',
  'GET /api/tailscale': '0.1.0-pre.15',
  'PUT /api/tailscale': '0.1.0-pre.15',
  'GET /api/overview': '0.1.0-pre.15',
  'GET /api/tips': '0.1.0-pre.22',
  'GET /api/tips/current': '0.1.0-pre.22',
  'GET /api/tips/settings': '0.1.0-pre.22',
  'PUT /api/tips/settings': '0.1.0-pre.22',
  'POST /api/tips/seen-page': '0.1.0-pre.22',
  'POST /api/tips/:id/dismiss': '0.1.0-pre.22',
  'POST /api/tips/:id/later': '0.1.0-pre.22',
  'POST /api/tips/:id/restore': '0.1.0-pre.22',
  'POST /api/home/glances/:id/hidden': '0.1.0-pre.23',
  'GET /api/rail': '0.1.0-pre.23',
  'POST /api/rail/pages/:plugin/:page/hidden': '0.1.0-pre.23',
  'GET /api/events': '0.1.0-pre.15',
  'GET /api/events/kinds': '0.1.0-pre.15',
  'POST /api/pause': '0.1.0-pre.15',
  'GET /api/chat/agents': '0.1.0-pre.15',
  'GET /api/chat/attention': '0.1.0-pre.15',
  'GET /api/chat/attention/stream': '0.1.0-pre.15',
  'GET /api/chat/views': '0.1.0-pre.15',
  'GET /api/chat/:agent/conversations': '0.1.0-pre.15',
  'POST /api/chat/:agent/conversations': '0.1.0-pre.15',
  'POST /api/chat/:agent/messages': '0.1.0-pre.15',
  'GET /api/chat/conversations/:id': '0.1.0-pre.15',
  'GET /api/chat/conversations/:id/stream': '0.1.0-pre.15',
  'POST /api/chat/conversations/:id/cancel': '0.1.0-pre.15',
  'DELETE /api/chat/conversations/:id/carry-over': '0.1.0-pre.28',
  'POST /api/chat/questions/:id/answer': '0.1.0-pre.15',
  'POST /api/chat/attachments': '0.1.0-pre.15',
  'GET /api/conversations': '0.1.0-pre.15',
  'GET /api/conversations/:id': '0.1.0-pre.15',
  'GET /api/groups': '0.1.0-pre.15',
  'POST /api/groups': '0.1.0-pre.15',
  'GET /api/groups/:id': '0.1.0-pre.15',
  'PATCH /api/groups/:id': '0.1.0-pre.15',
  'DELETE /api/groups/:id': '0.1.0-pre.15',
  'POST /api/groups/:id/archive': '0.1.0-pre.15',
  'GET /api/groups/:id/conversations': '0.1.0-pre.15',
  'POST /api/groups/:id/conversations': '0.1.0-pre.15',
  'POST /api/groups/:id/messages': '0.1.0-pre.15',
  'GET /api/agents': '0.1.0-pre.15',
  'POST /api/agents/default': '0.1.0-pre.15',
  'GET /api/agents/:id/profile': '0.1.0-pre.15',
  'GET /api/agents/:id/skills': '0.1.0-pre.15',
  'POST /api/agents/:id/skills/:skill/remove': '0.1.0-pre.15',
  'GET /api/agents/:id/tools': '0.1.0-pre.15',
  'GET /api/agents/:id/file': '0.1.0-pre.15',
  'POST /api/agents/:id/file': '0.1.0-pre.15',
  'POST /api/agents/:id/delegates': '0.1.0-pre.15',
  'POST /api/agents/:id/engine': '0.1.0-pre.15',
  'POST /api/agents/:id/account': '0.1.0-pre.15',
  'GET /api/agents/:id/avatar': '0.1.0-pre.15',
  'POST /api/agents/:id/avatar': '0.1.0-pre.15',
  'DELETE /api/agents/:id/avatar': '0.1.0-pre.15',
  'GET /api/teammates': '0.1.0-pre.22',
  'GET /api/agent-offers': '0.1.0-pre.15',
  'POST /api/agent-offers/:plugin/:agent/dismiss': '0.1.0-pre.15',
  'GET /api/approvals': '0.1.0-pre.15',
  'GET /api/approvals/:id': '0.1.0-pre.15',
  'POST /api/approvals/:id/approve': '0.1.0-pre.15',
  'POST /api/approvals/:id/reject': '0.1.0-pre.15',
  'GET /api/offers': '0.1.0-pre.15',
  'POST /api/offers/:id/take': '0.1.0-pre.15',
  'POST /api/offers/:id/dismiss': '0.1.0-pre.15',
  'POST /api/offers/dismiss-all': '0.1.0-pre.15',
  'GET /api/proposals': '0.1.0-pre.15',
  'POST /api/proposals/:id/keep': '0.1.0-pre.15',
  'POST /api/proposals/:id/discard': '0.1.0-pre.15',
  'POST /api/proposals/keep-all': '0.1.0-pre.28',
  'POST /api/proposals/digest-schedule': '0.1.0-pre.15',
  'GET /api/missions': '0.1.0-pre.15',
  'POST /api/missions/:id/enabled': '0.1.0-pre.15',
  'POST /api/missions/:id/schedule': '0.1.0-pre.15',
  'GET /api/jobs': '0.1.0-pre.15',
  'POST /api/jobs/:id/retry': '0.1.0-pre.15',
  'POST /api/jobs/:id/cancel': '0.1.0-pre.15',
  'GET /api/reminders': '0.1.0-pre.15',
  'POST /api/reminders/:id/cancel': '0.1.0-pre.15',
  'GET /api/sentinels': '0.1.0-pre.15',
  'POST /api/sentinels/:id/enabled': '0.1.0-pre.15',
  'POST /api/alerts/:key/snooze': '0.1.0-pre.15',
  'GET /api/notifications': '0.1.0-pre.18',
  'POST /api/notifications/:id/seen': '0.1.0-pre.18',
  'GET /api/notifications/settings': '0.1.0-pre.18',
  'PUT /api/notifications/settings': '0.1.0-pre.18',
  'GET /api/notifications/focus': '0.1.0-pre.23',
  'PUT /api/notifications/focus': '0.1.0-pre.23',
  'POST /api/notifications/test': '0.1.0-pre.18',
  'POST /api/notifications/agent-mute': '0.1.0-pre.26',
  'POST /api/presence': '0.1.0-pre.18',
  'GET /api/memory': '0.1.0-pre.15',
  'POST /api/memory/preferences': '0.1.0-pre.15',
  'POST /api/memory/preferences/forget': '0.1.0-pre.15',
  'POST /api/memory/notes/:id': '0.1.0-pre.15',
  'POST /api/memory/notes/:id/forget': '0.1.0-pre.15',
  'GET /api/artifacts': '0.1.0-pre.15',
  'GET /api/artifacts/:id': '0.1.0-pre.15',
  'GET /api/artifacts/:id/download': '0.1.0-pre.15',
  'GET /api/artifacts/:id/preview': '0.1.0-pre.15',
  'DELETE /api/artifacts/:id': '0.1.0-pre.15',
  'GET /api/owner': '0.1.0-pre.15',
  'POST /api/owner': '0.1.0-pre.15',
  'GET /api/provider-accounts': '0.1.0-pre.15',
  'POST /api/provider-accounts/save': '0.1.0-pre.15',
  'POST /api/provider-accounts/probe-models': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/test': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/models': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/remove': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/login': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/cancel-login': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/logout': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/anthropic/login': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/anthropic/complete-login': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/anthropic/cancel-login': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/anthropic/logout': '0.1.0-pre.15',
  'POST /api/provider-accounts/:id/ollama/connect': '0.1.0-pre.20',
  'POST /api/provider-accounts/:id/ollama/poll': '0.1.0-pre.20',
  'POST /api/provider-accounts/:id/ollama/disconnect': '0.1.0-pre.20',
  'GET /api/providers': '0.1.0-pre.15',
  'POST /api/providers/anthropic/settings': '0.1.0-pre.15',
  'POST /api/providers/anthropic/test': '0.1.0-pre.15',
  'POST /api/providers/openai/settings': '0.1.0-pre.15',
  'POST /api/providers/openai/test': '0.1.0-pre.15',
  'POST /api/providers/credentials/:name/save': '0.1.0-pre.15',
  'POST /api/providers/credentials/:name/remove': '0.1.0-pre.15',
  'GET /api/connections': '0.1.0-pre.22',
  'POST /api/connections': '0.1.0-pre.22',
  'GET /api/connections/signals': '0.1.0-pre.22',
  'POST /api/connections/callback': '0.1.0-pre.22',
  'GET /api/connections/remembered/:agent': '0.1.0-pre.22',
  'POST /api/connections/remembered': '0.1.0-pre.22',
  'GET /api/connections/:id': '0.1.0-pre.22',
  'DELETE /api/connections/:id': '0.1.0-pre.22',
  'POST /api/connections/:id/consent': '0.1.0-pre.22',
  'POST /api/connections/:id/reconnect': '0.1.0-pre.22',
  'POST /api/connections/:id/token': '0.1.0-pre.25',
  'POST /api/connections/:id/device': '0.1.0-pre.25',
  'GET /api/connections/:id/review': '0.1.0-pre.22',
  'POST /api/connections/:id/review': '0.1.0-pre.22',
  'POST /api/connections/:id/grant': '0.1.0-pre.22',
  'POST /api/connections/:id/holders/:agent': '0.1.0-pre.26',
  'GET /api/connections/:id/tools': '0.1.0-pre.22',
  'PUT /api/connections/:id/program': '0.1.0-pre.25',
  'GET /api/plugins': '0.1.0-pre.15',
  'POST /api/plugins/stage': '0.1.0-pre.15',
  'POST /api/plugins/upload': '0.1.0-pre.15',
  'GET /api/plugins/jobs/:id': '0.1.0-pre.15',
  'POST /api/plugins/staged/:id/approve': '0.1.0-pre.15',
  'POST /api/plugins/staged/:id/reject': '0.1.0-pre.15',
  'POST /api/plugins/staged/:id/opened': '0.1.0-pre.28',
  'POST /api/plugins/:name/update': '0.1.0-pre.15',
  'POST /api/plugins/:name/uninstall': '0.1.0-pre.15',
  'POST /api/plugins/:name/disable': '0.1.0-pre.23',
  'POST /api/plugins/:name/enable': '0.1.0-pre.23',
  'POST /api/plugins/:plugin/agents/:agent/accept': '0.1.0-pre.15',
  'GET /api/plugins/folders': '0.1.0-pre.24',
  'GET /api/market': '0.1.0-pre.24',
  'GET /api/market/asset': '0.1.0-pre.24',
  'GET /api/pages': '0.1.0-pre.15',
  'GET /api/pages/:plugin/:query': '0.1.0-pre.15',
  'POST /api/pages/:plugin/act': '0.1.0-pre.15',
  'GET /api/preview/:plugin/:name/link': '0.1.0-pre.15',
  'GET /api/preview/:plugin/:name/check': '0.1.0-pre.15',
  'GET /api/secrets': '0.1.0-pre.15',
  'GET /api/secrets/uses': '0.1.0-pre.15',
  'POST /api/secrets/act': '0.1.0-pre.15',
  'GET /api/host': '0.1.0-pre.15',
  'POST /api/host/stop': '0.1.0-pre.15',
  'POST /api/host/revoke': '0.1.0-pre.15',
  'GET /api/host/apps': '0.1.0-pre.15',
  'GET /api/host/browser-profiles': '0.1.0-pre.15',
  'GET /api/browser': '0.1.0-pre.15',
  'GET /api/browser/screenshot': '0.1.0-pre.15',
  'POST /api/browser/install': '0.1.0-pre.15',
  'POST /api/browser/check': '0.1.0-pre.15',
  'POST /api/browser/settings': '0.1.0-pre.15',
  'POST /api/browser/permissions': '0.1.0-pre.15',
  'POST /api/browser/stop': '0.1.0-pre.15',
  'POST /api/browser/takeover': '0.1.0-pre.15',
  'POST /api/browser/resume': '0.1.0-pre.15',
  'POST /api/browser/release': '0.1.0-pre.15',
  'GET /api/browser/hand': '0.1.0-pre.15',
  'GET /api/extension': '0.1.0-pre.15',
  'POST /api/extension/pair': '0.1.0-pre.15',
  'DELETE /api/extension/pair': '0.1.0-pre.15',
  'GET /api/extension/socket': '0.1.0-pre.15',
  'GET /api/telegram': '0.1.0-pre.15',
  'GET /api/telegram/bot': '0.1.0-pre.19',
  'GET /api/telegram/devices': '0.1.0-pre.19',
  'POST /api/telegram/token': '0.1.0-pre.15',
  'POST /api/telegram/pairing': '0.1.0-pre.15',
  'DELETE /api/telegram/devices/:id': '0.1.0-pre.19',
  'GET /api/service': '0.1.0-pre.15',
  'POST /api/service/start': '0.1.0-pre.15',
  'POST /api/service/stop': '0.1.0-pre.15',
  'POST /api/service/restart': '0.1.0-pre.15',
  'GET /api/version': '0.1.0-pre.15',
  'POST /api/version/check': '0.1.0-pre.15',
  'PUT /api/version/check': '0.1.0-pre.15',
  'POST /api/upgrade': '0.1.0-pre.15',
  'GET /api/upgrade/jobs/:id': '0.1.0-pre.15',
  'GET /api/backups': '0.1.0-pre.15',
  'POST /api/backups': '0.1.0-pre.15',
  'GET /api/backups/jobs/:id': '0.1.0-pre.15',
  'POST /api/backups/verify': '0.1.0-pre.15',
  'POST /api/backups/restore': '0.1.0-pre.15',
  'GET /api/backups/schedule': '0.1.0-pre.15',
  'PUT /api/backups/schedule': '0.1.0-pre.15',
  'GET /api/backups/passphrase': '0.1.0-pre.15',
  'PUT /api/backups/passphrase': '0.1.0-pre.15',
  'GET /api/recovery': '0.1.0-pre.15',
  'POST /api/recovery/leave': '0.1.0-pre.15',
  'GET /api/onboarding': '0.1.0-pre.15',
  'POST /api/onboarding/step': '0.1.0-pre.15',
  'POST /api/onboarding/complete': '0.1.0-pre.15',
  'POST /api/onboarding/skip': '0.1.0-pre.15',
  'GET /api/onboarding/agent': '0.1.0-pre.15',
  'POST /api/onboarding/agent': '0.1.0-pre.15',
  'POST /api/onboarding/agent/update': '0.1.0-pre.15',
  'POST /api/onboarding/brain': '0.1.0-pre.15',
  'GET /api/onboarding/ollama': '0.1.0-pre.15',
  'GET /api/onboarding/mlxh': '0.1.0-pre.25',
  'GET /api/onboarding/take-on': '0.1.0-pre.25',
  'POST /api/onboarding/take-on': '0.1.0-pre.25',
  'POST /api/onboarding/restore': '0.1.0-pre.15',
  'POST /api/speech/transcribe': '0.1.0-pre.21',
  'POST /api/speech/say': '0.1.0-pre.21',
  'POST /api/mcp/request': '0.1.0-pre.15',
};
