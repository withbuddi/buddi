import type { Vault } from '@buddi/core';
import {
  createCodexAppServerAdapter, initializeCodex, openCodexSession, assertCodexIsolation,
  type CodexSession, type CompletionRequest, type CompletionResponse,
} from '@buddi/runtime';

export interface CodexLoginView {
  state: 'pending' | 'connected' | 'cancelled' | 'failed';
  verificationUrl?: string; userCode?: string; expiresAt?: string;
  message?: string;
}
export interface CodexAccountAccess {
  id: string;
  /** A reference, never a token. Metadata lives in Postgres, credentials in vault. */
  secretRef: string;
  /** Owner service rechecks revision/enabled state before opening or saving. */
  check(): Promise<void>;
}

/**
 * Owns only native account sessions, not permission decisions or tool execution.
 * Operations on one account are exclusive; other accounts remain independent.
 * The gateway must hold a cross-process account lock for each operation.
 */
export class CodexAccounts {
  #active = new Map<string, { cancel(): Promise<void> }>();
  #logins = new Map<string, CodexLoginView>();
  constructor(readonly deps: {
    vault: Vault;
    open?: (credential: string | null) => Promise<CodexSession>;
    loginTimeoutMs?: number;
  }) {}
  view(id: string): CodexLoginView | null { return this.#logins.get(id) ?? null; }
  async cancel(id: string): Promise<void> { await this.#active.get(id)?.cancel(); }
  forget(id: string): void { this.#logins.delete(id); }
  #reserve(id: string, cancel: () => Promise<void>) {
    if (this.#active.has(id)) throw new Error('This Codex account is busy. Finish or cancel its current operation first.');
    this.#active.set(id, { cancel });
  }
  async #open(access: CodexAccountAccess, credential: string | null) {
    await access.check();
    return (this.deps.open ?? openCodexSession)(credential);
  }

  /** No credential is loaded for sign-in, so reconnect cannot reuse another login. */
  async login(access: CodexAccountAccess): Promise<{ view: CodexLoginView; finished: Promise<void> }> {
    let session: CodexSession | undefined;
    let cancelled = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let cleanup: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeListener = () => {};
    let removeClose = () => {};
    let loginId: string | undefined;
    let earlyCompletion: { loginId?: string; success?: boolean } | undefined;
    let committing = false;
    const end = (state: CodexLoginView['state'], message?: string) => {
      if (cleanup) return cleanup;
      cleanup = (async () => {
        clearTimeout(timer); removeListener(); removeClose();
        try {
          if (session) {
            await session.rpc.close();
            if (state === 'connected' && !cancelled) {
              const credential = await session.credential();
              if (!credential) throw new Error('No subscription credential was saved.');
              await access.check();
              if (cancelled) throw new Error('Sign-in cancelled.');
              committing = true;
              await this.deps.vault.set(access.secretRef, credential);
            }
          }
          this.#logins.set(access.id, { state: cancelled ? 'cancelled' : state, message });
        } catch {
          this.#logins.set(access.id, { state: 'failed', message: 'Could not finish sign-in securely. Check the host vault and reconnect.' });
        } finally {
          try { await session?.dispose(); }
          finally { this.#active.delete(access.id); finish(); }
        }
      })();
      // Login completion is asynchronous. Surface a sanitized state, not an
      // unhandled rejection containing filesystem/authentication details.
      void cleanup.catch(() => { this.#logins.set(access.id, { state: 'failed', message: 'Native session cleanup failed. Check the host.' }); });
      return cleanup;
    };
    this.#reserve(access.id, async () => {
      if (committing) { await cleanup; return; }
      cancelled = true;
      if (session && loginId) await session.rpc.request('account/login/cancel', { loginId }).catch(() => {});
      await end('cancelled');
    });
    try {
      session = await this.#open(access, null);
      if (cancelled) { await session.dispose(); throw new Error('Sign-in cancelled.'); }
      await initializeCodex(session.rpc);
      await assertCodexIsolation(session.rpc, session.cwd);
      removeClose = session.rpc.onClose(() => { void end('failed', 'Codex sign-in process closed.'); });
      removeListener = session.rpc.onMessage(message => {
        if (message.method !== 'account/login/completed') return;
        const result = message.params as { loginId?: string; success?: boolean };
        if (!loginId) { earlyCompletion = result; return; }
        if (result.loginId !== loginId) return;
        void end(result.success ? 'connected' : 'failed', result.success ? undefined : 'Sign-in did not complete. Try again.');
      });
      const result = await session.rpc.request('account/login/start', { type: 'chatgptDeviceCode' }) as {
        type?: string; loginId?: string; verificationUrl?: string; userCode?: string;
      };
      if (result.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' ||
        result.verificationUrl !== 'https://auth.openai.com/codex/device' ||
        typeof result.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(result.userCode)) {
        throw new Error('Codex returned an unsupported device sign-in response.');
      }
      loginId = result.loginId;
      if (cancelled || cleanup) throw new Error('Sign-in ended before the device challenge was ready.');
      const timeout = this.deps.loginTimeoutMs ?? 5 * 60_000;
      const view: CodexLoginView = { state: 'pending', verificationUrl: result.verificationUrl, userCode: result.userCode,
        expiresAt: new Date(Date.now() + timeout).toISOString() };
      this.#logins.set(access.id, view);
      timer = setTimeout(() => { cancelled = true; void end('cancelled', 'Sign-in timed out. Start again.'); }, timeout);
      timer.unref();
      if (earlyCompletion?.loginId === loginId) void end(earlyCompletion.success ? 'connected' : 'failed');
      return { view, finished };
    } catch (error) {
      await end('failed', 'Could not start Codex sign-in. Check the installed client and host vault.');
      throw error;
    }
  }

  async complete(access: CodexAccountAccess, model: string, request: CompletionRequest): Promise<CompletionResponse> {
    let session: CodexSession | undefined;
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    this.#reserve(access.id, async () => { controller.abort(); await session?.rpc.close(); await finished; });
    try {
      const credential = await this.deps.vault.get(access.secretRef);
      if (!credential) throw new Error('Connect this Codex subscription account first.');
      session = await this.#open(access, credential);
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      return await createCodexAppServerAdapter({ model, cwd: session.cwd, connect: () => session!.rpc }).complete({ ...request, signal });
    } finally {
      try {
        if (session) {
          await session.rpc.close();
          const refreshed = await session.credential();
          if (refreshed && !controller.signal.aborted) {
            await access.check();
            await this.deps.vault.set(access.secretRef, refreshed);
          }
        }
      } finally { try { await session?.dispose(); } finally { this.#active.delete(access.id); finish(); } }
    }
  }
}
