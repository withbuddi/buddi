/**
 * The tips' routes (docs/dashboard.md, Home):
 *
 *   GET  /api/tips                 { tips: [...rows] }   every rule and where it stands
 *   GET  /api/tips/current         { tip | null }   today's tip, if any
 *   GET  /api/tips/queue           { tips: [...], dismissed }   the bulb's stack: today's tip first, then every other
 *                                  one that holds and is not dismissed, ready ones before those in their cooldown;
 *                                  `dismissed` counts the dismissed ones that hold
 *                                  (`?peek=1`: today's and the ready ones only, nothing marked shown: for the bulb's dot)
 *   POST /api/tips/:id/dismiss     "Not this again": never again
 *   POST /api/tips/:id/later       ×: not before its cooldown has passed
 *   POST /api/tips/:id/restore     "Bring back": forget a dismissal
 *   POST /api/tips/seen-page { page }   the dashboard opened a page (once a day each)
 *
 * State lives in `core.web_settings`: `tips.state` (the engine's) and
 * `tips.pages`. A `tips.enabled` left from the old "Tips on Home" switch is
 * ignored: tips sit behind the bulb, which is the owner's choice to look.
 */
import { dayIn, dismissTip, laterTip, listTips, pickQueue, pickTip, restoreTip, viewOf, type TipsState } from './engine.js';
import { PAGE_NAME, recordPageSeen, type Facts, type SettingsStore } from './facts.js';
import { TIPS, type TipRule } from './rules.js';

export const TIPS_STATE_KEY = 'tips.state';

export interface TipsRouteDeps {
  store: SettingsStore;
  facts: () => Promise<Facts>;
  now: () => Date;
  timezone: string;
  /** The rules; `TIPS` unless a test passes its own. */
  rules?: readonly TipRule[];
}

export interface TipsReply {
  status: number;
  body: unknown;
}

async function readState(store: SettingsStore): Promise<TipsState> {
  const value = await store.read<TipsState>(TIPS_STATE_KEY).catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function tipsRoute(
  deps: TipsRouteDeps,
  request: { method: string; path: string; body?: Record<string, unknown>; preview?: string | null; peek?: boolean },
): Promise<TipsReply> {
  const { method, path } = request;
  const body = request.body ?? {};
  const rules = deps.rules ?? TIPS;
  const today = dayIn(deps.now(), deps.timezone);

  if (path === '/api/tips') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only.' } };
    // Reads only: listing never marks a tip shown.
    const tips = listTips(rules, await deps.facts(), await readState(deps.store), today);
    return { status: 200, body: { tips } };
  }

  if (path === '/api/tips/current') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only.' } };
    // `?preview=<id>` shows one rule's card as it would look, touching no state:
    // for eyeballing copy and layout on Home (`#/?tip=<id>`).
    const preview = request.preview ?? null;
    if (preview !== null) {
      const rule = rules.find((r) => r.id === preview);
      return rule
        ? { status: 200, body: { tip: viewOf(rule, await deps.facts()), preview: true } }
        : { status: 404, body: { error: `No tip called "${preview}". Known: ${rules.map((r) => r.id).join(', ')}.` } };
    }
    const previous = await readState(deps.store);
    const { tip, state } = pickTip(rules, await deps.facts(), previous, today);
    if (JSON.stringify(state) !== JSON.stringify(previous)) await deps.store.write(TIPS_STATE_KEY, state);
    return { status: 200, body: { tip } };
  }

  if (path === '/api/tips/queue') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only.' } };
    // `?preview=a,b,c` stacks those rules' cards as they would look, touching no state.
    const preview = request.preview ?? null;
    if (preview !== null) {
      const ids = preview.split(',').map((id) => id.trim()).filter(Boolean);
      const unknown = ids.filter((id) => !rules.some((r) => r.id === id));
      if (ids.length === 0 || unknown.length) {
        return { status: 404, body: { error: `No tip called "${unknown[0] ?? preview}". Known: ${rules.map((r) => r.id).join(', ')}.` } };
      }
      const f = await deps.facts();
      return { status: 200, body: { tips: ids.map((id) => viewOf(rules.find((r) => r.id === id)!, f)), preview: true } };
    }
    const previous = await readState(deps.store);
    const { tips, state, dismissed } = pickQueue(rules, await deps.facts(), previous, today, { open: !request.peek });
    // A peek keeps the holds counting but marks nothing shown: the owner has
    // not opened the stack, so no tip's cooldown starts.
    const front = tips[0]?.id;
    if (request.peek && front && state[front]?.shownAt !== previous[front]?.shownAt) {
      const before = previous[front]?.shownAt;
      if (before) state[front] = { ...state[front], shownAt: before };
      else {
        const { shownAt: _s, ...rest } = state[front]!;
        state[front] = rest;
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(previous)) await deps.store.write(TIPS_STATE_KEY, state);
    return { status: 200, body: { tips, dismissed } };
  }

  if (path === '/api/tips/seen-page') {
    if (method !== 'POST') return { status: 405, body: { error: 'POST only.' } };
    const page = typeof body.page === 'string' ? body.page.trim().toLowerCase() : '';
    if (!PAGE_NAME.test(page)) return { status: 400, body: { error: '`page` must name a page.' } };
    await recordPageSeen(deps.store, page, today);
    return { status: 200, body: { ok: true } };
  }

  const act = /^\/api\/tips\/([a-z0-9-]+)\/(dismiss|later|restore)$/.exec(path);
  if (act) {
    if (method !== 'POST') return { status: 405, body: { error: 'POST only.' } };
    const id = act[1]!;
    if (!rules.some((rule) => rule.id === id)) return { status: 404, body: { error: `There is no tip "${id}".` } };
    const previous = await readState(deps.store);
    const next = act[2] === 'dismiss' ? dismissTip(previous, id, today) : act[2] === 'restore' ? restoreTip(previous, id) : laterTip(previous, id, today);
    await deps.store.write(TIPS_STATE_KEY, next);
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: 'No such tips route.' } };
}
