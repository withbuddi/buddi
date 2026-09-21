/*
 * The page half, injected on demand.
 *
 * It is not declared in the manifest for every page: the worker injects it
 * with `chrome.scripting` when a command needs the document, which keeps the
 * extension off every site the owner visits on their own. Injection is
 * idempotent, so a second observation reuses the registry the first one built.
 *
 * What it does *not* do is dispatch input. Clicks, typing and keys go through
 * the debugger in the worker, because a synthetic DOM event is not a real one
 * and half the web knows the difference. The page side only finds the element,
 * scrolls it into view and reports where it is.
 */

import { accessibleName, collect, roleOf, type CollectedElement } from './tree.js';

interface Registry {
  /*
   * Refs are looked up by name, and a page that has moved on must not hand back
   * a detached node, so each entry is a weak handle: the document decides how
   * long the element lives, this map never does.
   */
  refs: Map<string, WeakRef<Element>>;
  signatures: WeakMap<Element, string>;
  generation: number;
}

export interface Located {
  ok: boolean;
  reason?: string;
  /** Viewport pixels, which is what the debugger's Input domain speaks. */
  point?: { x: number; y: number };
  password?: boolean;
  role?: string;
  name?: string;
}

const KEY = '__buddiBrowser';

function registry(): Registry {
  const holder = globalThis as unknown as Record<string, Registry | undefined>;
  const existing = holder[`${KEY}Registry`];
  if (existing) return existing;
  const created: Registry = { refs: new Map(), signatures: new WeakMap(), generation: 0 };
  holder[`${KEY}Registry`] = created;
  return created;
}

/** What has to stay the same between an observation and the command that acts on it. */
function signature(el: Element): string {
  return JSON.stringify([el.tagName, roleOf(el), accessibleName(el),
    el.getAttribute('type') ?? '', el.getAttribute('href') ?? '', el.hasAttribute('disabled')]);
}

function resolve(ref: string): Element | null {
  const state = registry();
  const element = state.refs.get(ref)?.deref() ?? null;
  if (!element || !element.isConnected) return null;
  if (state.signatures.get(element) !== signature(element)) return null;
  return element;
}

function observe(): { url: string; title: string; tree: string; elements: CollectedElement[]; scroll: { x: number; y: number } } {
  const state = registry();
  state.refs.clear();
  const result = collect(document);
  result.elements.forEach((element, index) => {
    const node = result.nodes[index];
    if (!node) return;
    state.refs.set(element.id, new WeakRef(node));
    state.signatures.set(node, signature(node));
  });
  state.generation += 1;
  return { url: result.url, title: result.title, tree: result.tree, elements: result.elements, scroll: result.scroll };
}

function locate(ref: string, options: { focus?: boolean; clear?: boolean } = {}): Located {
  const element = resolve(ref);
  if (!element) return { ok: false, reason: 'The referenced element changed or disappeared.' };
  const input = element as HTMLInputElement;
  const password = element.tagName.toLowerCase() === 'input' && input.type?.toLowerCase() === 'password';
  if (password && (options.focus || options.clear)) return { ok: false, password: true, reason: 'Use human takeover to enter passwords on the host, not chat.' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (options.focus && 'focus' in element) (element as HTMLElement).focus();
  if (options.clear && 'value' in element) {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const rect = element.getBoundingClientRect();
  return { ok: true, password, role: roleOf(element), name: accessibleName(element),
    point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } };
}

/** A native `select` is the one control where setting the value is the honest action. */
function choose(ref: string, value: string): Located {
  const element = resolve(ref);
  if (!element) return { ok: false, reason: 'The referenced element changed or disappeared.' };
  const select = element as HTMLSelectElement;
  if (select.tagName?.toLowerCase() !== 'select') return { ok: false, reason: 'That element is not a select.' };
  const option = Array.from(select.options).find((candidate) => candidate.label === value || candidate.text === value || candidate.value === value);
  if (!option) return { ok: false, reason: `No option named ${value} in that select.` };
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, role: 'combobox', name: accessibleName(select) };
}

function scrollPage(direction: 'up' | 'down'): { ok: true } {
  window.scrollBy({ top: direction === 'up' ? -600 : 600, behavior: 'instant' as ScrollBehavior });
  return { ok: true };
}

const api = { observe, locate, choose, scroll: scrollPage };
export type ContentApi = typeof api;
(globalThis as unknown as Record<string, ContentApi>)[KEY] = api;
