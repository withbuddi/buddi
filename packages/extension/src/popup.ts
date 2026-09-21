/*
 * The popup: where the owner points this browser at their buddi, reads the
 * pairing code, and takes it back.
 *
 * It holds no connection of its own. Everything it shows comes from the
 * service worker, which is the only thing that speaks to a buddi.
 */

import type { ClientState } from './protocol.js';

declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

const TONES: Record<ClientState['connection'], { word: string; tone: string }> = {
  offline: { word: 'Not connected', tone: 'idle' },
  connecting: { word: 'Connecting', tone: 'waiting' },
  pairing: { word: 'Waiting to be paired', tone: 'waiting' },
  paired: { word: 'Connected', tone: 'good' },
};

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function render(state: ClientState): void {
  const badge = el('state');
  const { word, tone } = TONES[state.connection] ?? TONES.offline;
  badge.textContent = state.installation && state.connection === 'paired' ? `Connected to ${state.installation}` : word;
  badge.dataset['tone'] = state.error && state.connection === 'offline' ? 'bad' : tone;
  const pairing = el('pairing');
  if (state.code) { pairing.hidden = false; el('code').textContent = state.code; } else { pairing.hidden = true; }
  el('hint').textContent = state.error && state.connection === 'offline'
    ? state.error
    : 'The address of the buddi running on this machine.';
}

async function ask<T>(message: unknown): Promise<T | undefined> {
  try { return await chrome.runtime.sendMessage(message) as T; } catch { return undefined; }
}

async function main(): Promise<void> {
  const field = el<HTMLInputElement>('gateway');
  const address = await ask<{ gateway: string }>({ type: 'buddi-gateway' });
  field.value = address?.gateway ?? '';
  const current = await ask<{ state: ClientState }>({ type: 'buddi-get-state' });
  if (current?.state) render(current.state);

  el('connect').addEventListener('click', async () => {
    const answer = await ask<{ state?: ClientState; error?: string }>({ type: 'buddi-connect', gateway: field.value.trim() });
    if (answer?.error) { el('hint').textContent = answer.error; return; }
    if (answer?.state) render(answer.state);
  });
  el('forget').addEventListener('click', async () => {
    const answer = await ask<{ state: ClientState }>({ type: 'buddi-forget' });
    if (answer?.state) render(answer.state);
  });
}

// The worker pushes every state change; the popup only listens while it is open.
(chrome as unknown as { runtime: { onMessage: { addListener(fn: (message: unknown) => void): void } } })
  .runtime.onMessage.addListener((message) => {
    const frame = message as { type?: string; state?: ClientState } | null;
    if (frame?.type === 'buddi-state' && frame.state) render(frame.state);
  });

void main();
