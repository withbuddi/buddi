/**
 * The conversation's browser session, as the canvas sees it.
 *
 * Two things live here. The *tab*: a live session belongs to a conversation,
 * not to whichever chat happens to be visible, so the panel only appears when
 * the gateway says this conversation is the one driving. And the *steps*: the
 * actions taken on that screen, read back out of the conversation's own
 * recorded calls, so a reload shows the same list and no agent was asked to
 * report anything.
 *
 * This is the one page module that names the browser tool. It is a platform
 * surface — the owner's machine, with controls that stop it — not a plugin's
 * view, and the canvas package it feeds still knows the name of no tool.
 */
import type { BrowserStatus } from '../api';
import type { ChatBlock, ChatMessage } from './types';
import type { Renderable } from '../canvas/types';

/** Driving the screen. Every one of these is a step in the panel's list. */
export const BROWSER_ACT = 'browser.act';
/** Reading the mode and the current task. The panel already says both. */
export const BROWSER_STATUS = 'browser.status';

/**
 * The calls the Browser panel covers. While it is on the canvas, none of them
 * opens a tab of its own.
 */
export const BROWSER_TOOLS: ReadonlySet<string> = new Set([BROWSER_ACT, BROWSER_STATUS]);

/** One action on the owner's screen, with how it went. */
export interface BrowserStep {
  /** The recorded call's id — what a chat row clicks through to. */
  id: string;
  /** `navigate`, `click`, `fill`… — the agent's own word for what it did. */
  action: string;
  /** Where it went or what it touched, in a few words. Never a typed value. */
  target: string | null;
  /** `null` while the call is still out. */
  ok: boolean | null;
  /** Why it failed, when it did. */
  error: string | null;
  at: string | null;
}

/** Live sessions belong to a conversation, not to whichever chat is visible. */
export function conversationBrowser(
  status: BrowserStatus | undefined,
  agentId: string | null,
  conversationId: string | null,
): Renderable | null {
  const session = status?.session;
  if (!session || !agentId || !conversationId || session.agentId !== agentId || session.conversationId !== conversationId) return null;
  return {
    id: `host-browser:${session.id}`,
    title: status.mode === 'computer' ? 'Computer' : 'Browser', tool: 'Host browser', renderer: 'browser', source: 'browser',
    // A session being driven right now holds the strip: it is the one thing
    // on this canvas that is still moving.
    pinned: true,
    props: {}, at: null, substantial: false,
  };
}

/**
 * The same tab once the session is over: the last screenshot, kept, and no
 * longer holding the strip. History does not get to pin itself.
 */
export function endedBrowser(tab: Renderable): Renderable {
  return { ...tab, title: `${tab.title} (ended)`, pinned: false };
}

/** Every step this conversation took on the screen, oldest first. */
export function browserSteps(messages: readonly ChatMessage[]): BrowserStep[] {
  const steps: BrowserStep[] = [];
  const byId = new Map<string, BrowserStep>();
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use' && block.name === BROWSER_ACT) {
        const step: BrowserStep = {
          id: block.id,
          action: actionOf(block.input) ?? 'act',
          target: targetOf(block.input),
          ok: null,
          error: null,
          at: message.at ?? null,
        };
        steps.push(step);
        byId.set(block.id, step);
        continue;
      }
      if (block.type !== 'tool_result') continue;
      const step = byId.get(block.toolUseId);
      if (!step) continue;
      step.ok = block.ok;
      if (!block.ok) step.error = reasonOf(block);
    }
  }
  return steps;
}

/** Which of the recorded steps a chat row points at, if any. */
export function stepFor(messages: readonly ChatMessage[], toolUseId: string): string | null {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return BROWSER_TOOLS.has(block.name) ? block.id : null;
      }
    }
  }
  return null;
}

function actionOf(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null;
  const action = (input as Record<string, unknown>)['action'];
  return typeof action === 'string' && action !== '' ? action : null;
}

/**
 * What the action was aimed at, summarised.
 *
 * A URL, an app, a named element, a reference — never the `value` of a fill,
 * because what is typed into a form is the owner's business and this list is
 * on screen for as long as the session lasts.
 */
function targetOf(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  for (const key of ['url', 'appId', 'direction', 'key', 'tabId']) {
    const found = record[key];
    if (typeof found === 'string' && found !== '') return found;
  }
  const target = record['target'];
  if (target !== null && typeof target === 'object') {
    const shape = target as Record<string, unknown>;
    const name = shape['name'];
    if (typeof name === 'string' && name !== '') return name;
    const ref = shape['ref'];
    if (typeof ref === 'string' && ref !== '') return ref;
    if (typeof shape['x'] === 'number' && typeof shape['y'] === 'number') return `${shape['x']}, ${shape['y']}`;
  }
  return null;
}

/** The failure in one line: the server's words, whichever half they arrived in. */
function reasonOf(block: Extract<ChatBlock, { type: 'tool_result' }>): string | null {
  for (const candidate of [block.error, block.output]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (candidate !== null && typeof candidate === 'object') {
      for (const key of ['message', 'error', 'reason']) {
        const found = (candidate as Record<string, unknown>)[key];
        if (typeof found === 'string' && found.trim() !== '') return found.trim();
      }
    }
  }
  return null;
}
