/**
 * The tips' routes (docs/dashboard.md, Home):
 *
 *   GET  /api/tips                 { tips: [...rows], enabled }   every rule and where it stands (the Tips list)
 *   GET  /api/tips/current         { tip | null, enabled }   today's tip, if any
 *   POST /api/tips/:id/dismiss     "Not this again": never again
 *   POST /api/tips/:id/later       ×: not before its cooldown has passed
 *   POST /api/tips/:id/restore     "Bring back": forget a dismissal
 *   POST /api/tips/seen-page { page }   the dashboard opened a page (once a day each)
 *   GET  /api/tips/settings        { enabled }
 *   PUT  /api/tips/settings { enabled }   Settings → Notifications → Tips on Home
 *
 * State lives in `core.web_settings`: `tips.state` (the engine's), `tips.enabled`
 * (absent is on) and `tips.pages`.
 */
import { dayIn, dismissTip, laterTip, listTips, pickTip, restoreTip, type TipsState } from './engine.js';
import { PAGE_NAME, recordPageSeen, type Facts, type SettingsStore } from './facts.js';
import { TIPS, type TipRule } from './rules.js';

export const TIPS_STATE_KEY = 'tips.state';
export const TIPS_ENABLED_KEY = 'tips.enabled';

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

/** Whether tips are on. Anything but an explicit `false` is on. */
export async function tipsEnabled(store: SettingsStore): Promise<boolean> {
  const value = await store.read<unknown>(TIPS_ENABLED_KEY).catch(() => null);
  return value !== false;
}

export async function tipsRoute(
  deps: TipsRouteDeps,
  request: { method: string; path: string; body?: Record<string, unknown>; preview?: string | null },
): Promise<TipsReply> {
  const { method, path } = request;
  const body = request.body ?? {};
  const rules = deps.rules ?? TIPS;
  const today = dayIn(deps.now(), deps.timezone);

  if (path === '/api/tips/settings') {
    if (method === 'PUT') {
      if (typeof body.enabled !== 'boolean') return { status: 400, body: { error: '`enabled` must be true or false.' } };
      await deps.store.write(TIPS_ENABLED_KEY, body.enabled);
    } else if (method !== 'GET') {
      return { status: 405, body: { error: 'GET or PUT.' } };
    }
    return { status: 200, body: { enabled: await tipsEnabled(deps.store) } };
  }

  if (path === '/api/tips') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only.' } };
    // Reads only: listing never marks a tip shown. It reads while tips are off too.
    const tips = listTips(rules, await deps.facts(), await readState(deps.store), today);
    return { status: 200, body: { tips, enabled: await tipsEnabled(deps.store) } };
  }

  if (path === '/api/tips/current') {
    if (method !== 'GET') return { status: 405, body: { error: 'GET only.' } };
    // `?preview=<id>` shows one rule's card as it would look, touching no state:
    // for eyeballing copy and layout on Home (`#/?tip=<id>`).
    const preview = request.preview ?? null;
    if (preview !== null) {
      const rule = rules.find((r) => r.id === preview);
      return rule
        ? { status: 200, body: { tip: { id: rule.id, text: rule.text, action: { ...rule.action } }, enabled: true, preview: true } }
        : { status: 404, body: { error: `No tip called "${preview}". Known: ${rules.map((r) => r.id).join(', ')}.` } };
    }
    if (!(await tipsEnabled(deps.store))) return { status: 200, body: { tip: null, enabled: false } };
    const previous = await readState(deps.store);
    const { tip, state } = pickTip(rules, await deps.facts(), previous, today);
    if (JSON.stringify(state) !== JSON.stringify(previous)) await deps.store.write(TIPS_STATE_KEY, state);
    return { status: 200, body: { tip, enabled: true } };
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
