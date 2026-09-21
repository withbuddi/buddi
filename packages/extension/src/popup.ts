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

/** How long the button admits to having copied before going back to offering it. */
export const COPIED_FOR = 2000;

/**
 * The code is six digits read off one screen and typed into another, which is
 * exactly the errand a clipboard is for.
 *
 * `textContent` only: the code comes from the gateway over a socket, and this
 * page never builds markup out of anything it was sent. A clipboard write can
 * be refused (no permission, no focus), and a button that then lied would be
 * worse than one that says nothing, so a refusal leaves the word alone.
 */
export function wireCopy(button: HTMLButtonElement, read: () => string): void {
  let restore: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    void (async () => {
      try { await navigator.clipboard.writeText(read()); } catch { return; }
      button.textContent = 'Copied';
      if (restore) clearTimeout(restore);
      restore = setTimeout(() => { button.textContent = 'Copy'; restore = undefined; }, COPIED_FOR);
    })();
  });
}

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

  wireCopy(el<HTMLButtonElement>('copy'), () => el('code').textContent ?? '');

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

/*
 * The worker pushes every state change; the popup only listens while it is
 * open. Guarded on `chrome` existing so that importing this file outside an
 * extension page — which is what its test does — wires nothing up and runs
 * nothing.
 */
if (typeof chrome !== 'undefined') {
  (chrome as unknown as { runtime: { onMessage: { addListener(fn: (message: unknown) => void): void } } })
    .runtime.onMessage.addListener((message) => {
      const frame = message as { type?: string; state?: ClientState } | null;
      if (frame?.type === 'buddi-state' && frame.state) render(frame.state);
    });

  void main();
}
