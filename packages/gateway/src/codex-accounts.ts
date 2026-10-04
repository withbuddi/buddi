import type { CodexImage, CodexImageOptions, CodexProfile, Vault } from '@buddi/core';
import {
  CodexOAuthProtocol, codexAccountEmail, createCodexDirectAdapter, generateCodexImage, listCodexModels, readCodexTokens, refreshDiscipline, stageCodexProfile,
  type AccountModels, type CodexTokens, type CompletionRequest, type CompletionResponse, type HttpTransport,
} from '@buddi/runtime';

export interface CodexLoginView {
  state: 'pending' | 'connected' | 'cancelled' | 'failed';
  verificationUrl?: string; userCode?: string; expiresAt?: string;
  message?: string;
  /** Once connected: the address the ChatGPT account signed in with, when its token names one. */
  account?: string;
}
export interface CodexAccountAccess {
  id: string;
  /** A reference, never a token. Metadata lives in Postgres, credentials in vault. */
  secretRef: string;
  /** Owner service rechecks revision/enabled state before opening or saving. */
  check(): Promise<void>;
}

const REFRESH_SKEW_MS = 5 * 60_000;
const SAVE_FAILED = 'Could not save ChatGPT credentials securely. Check the host vault and reconnect.';

/**
 * ChatGPT subscription accounts: buddi's own device sign-in, the refresh of
 * the vault envelope, and the calls that use it. Operations on one account are
 * exclusive; other accounts stay independent. The gateway holds a
 * cross-process account lock around each operation, which is what makes the
 * single-use refresh token safe to rotate.
 */
export class CodexAccounts {
  #active = new Map<string, { cancel(): Promise<void> }>();
  #logins = new Map<string, CodexLoginView>();
  readonly protocol: CodexOAuthProtocol;
  readonly now: () => number;
  constructor(readonly deps: {
    vault: Vault;
    protocol?: CodexOAuthProtocol;
    transport?: HttpTransport;
    now?: () => number;
    loginTimeoutMs?: number;
  }) {
    this.now = deps.now ?? Date.now;
    this.protocol = deps.protocol ?? new CodexOAuthProtocol(deps.transport, this.now);
  }
  view(id: string): CodexLoginView | null { return this.#logins.get(id) ?? null; }
  async cancel(id: string): Promise<void> { await this.#active.get(id)?.cancel(); }
  forget(id: string): void { this.#logins.delete(id); }
  #reserve(id: string, cancel: () => Promise<void>) {
    if (this.#active.has(id)) throw new Error('This ChatGPT account is busy. Finish or cancel its current operation first.');
    this.#active.set(id, { cancel });
  }
  /** Run `work` holding the account; `cancel` aborts it. */
  async #exclusive<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.#reserve(id, async () => { controller.abort(); await finished; });
    try { return await work(controller.signal); }
    finally { this.#active.delete(id); finish(); }
  }

  /**
   * The account's tokens, refreshed when they expire within five minutes. A
   * durable `refreshing` marker is written first so a crash or a failed save
   * never lets another process replay a consumed refresh token.
   */
  #credential(access: CodexAccountAccess): Promise<CodexTokens> {
    return refreshDiscipline(this.deps.vault, access.secretRef, { read: readCodexTokens, refresh: (t) => this.protocol.refresh(t) }, this.now, {
      skewMs: REFRESH_SKEW_MS,
      beforeRefresh: () => access.check(),
      messages: {
        missing: 'Connect this ChatGPT subscription account first.',
        interrupted: 'ChatGPT token refresh was interrupted or failed. Reconnect this account.',
        refreshFailed: 'ChatGPT token refresh failed. Reconnect this account.',
        unsaved: 'ChatGPT credentials rotated but could not be saved. Reconnect this account.',
      },
    });
  }

  /**
   * Device sign-in: the owner opens the link, types the code on openai.com,
   * and buddi polls in the background. Nothing is written to the vault until
   * the tokens are in hand and the account is rechecked, so a cancelled or
   * failed reconnect keeps the old credential.
   */
  async login(access: CodexAccountAccess): Promise<{ view: CodexLoginView; finished: Promise<void> }> {
    let cancelled = false;
    let committing = false;
    let wake: (() => void) | undefined;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const release = () => { this.#active.delete(access.id); finish(); };
    this.#reserve(access.id, async () => {
      if (!committing) { cancelled = true; wake?.(); }
      await finished;
    });
    let start;
    try {
      await access.check();
      start = await this.protocol.startDevice();
      if (cancelled) throw new Error('Sign-in cancelled.');
    } catch (error) {
      const message = error instanceof Error && /ChatGPT|Device code|cancelled/.test(error.message) ? error.message : 'Could not start ChatGPT sign-in. Check the host vault and try again.';
      this.#logins.set(access.id, { state: cancelled ? 'cancelled' : 'failed', message });
      release();
      throw error;
    }
    const deadline = Math.min(start.expiresAt, this.now() + (this.deps.loginTimeoutMs ?? 15 * 60_000));
    const view: CodexLoginView = { state: 'pending', verificationUrl: start.verificationUrl, userCode: start.userCode, expiresAt: new Date(deadline).toISOString() };
    this.#logins.set(access.id, view);
    const end = (state: CodexLoginView['state'], message?: string, account?: string) => {
      this.#logins.set(access.id, { state: cancelled && state !== 'connected' ? 'cancelled' : state, ...(message ? { message } : {}), ...(account ? { account } : {}) });
    };
    const sleep = (ms: number) => new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.max(0, Math.min(ms, deadline - this.now())));
      timer.unref?.();
      wake = () => { clearTimeout(timer); resolve(); };
    });
    const poll = async () => {
      let interval = start.intervalMs;
      try {
        for (;;) {
          await sleep(interval);
          if (cancelled) return end('cancelled', 'Sign-in cancelled.');
          if (this.now() >= deadline) return end('failed', 'Sign-in timed out. Start again.');
          const result = await this.protocol.pollDevice(start.deviceAuthId, start.userCode);
          if (cancelled) return end('cancelled', 'Sign-in cancelled.');
          if (result === 'pending') continue;
          if (result === 'slow_down') { interval += 5_000; continue; }
          if ('denied' in result) return end('failed', result.denied);
          const tokens = await this.protocol.exchange(result);
          await access.check().catch(() => { throw new Error('This account was changed or disabled during sign-in. Start again.'); });
          if (cancelled) return end('cancelled', 'Sign-in cancelled.');
          committing = true;
          try { await this.deps.vault.set(access.secretRef, JSON.stringify(tokens)); }
          catch { return end('failed', SAVE_FAILED); }
          return end('connected', undefined, codexAccountEmail(tokens.idToken, tokens.accessToken));
        }
      } catch (error) {
        end('failed', error instanceof Error && /ChatGPT|account|Start/.test(error.message) ? error.message : 'Sign-in did not complete. Try again.');
      } finally { release(); }
    };
    void poll();
    return { view, finished };
  }

  async complete(access: CodexAccountAccess, model: string, request: CompletionRequest): Promise<CompletionResponse> {
    return this.#exclusive(access.id, async (abort) => {
      const tokens = await this.#credential(access);
      const signal = request.signal ? AbortSignal.any([request.signal, abort]) : abort;
      return createCodexDirectAdapter({ model, accessToken: tokens.accessToken, accountId: tokens.accountId, ...(this.deps.transport ? { transport: this.deps.transport } : {}) })
        .complete({ ...request, signal });
    });
  }

  async models(access: CodexAccountAccess): Promise<AccountModels> {
    return this.#exclusive(access.id, async () => {
      const tokens = await this.#credential(access);
      return listCodexModels({ accessToken: tokens.accessToken, accountId: tokens.accountId, ...(this.deps.transport ? { transport: this.deps.transport } : {}) });
    });
  }

  /**
   * One picture through the hosted `image_generation` tool (the image
   * plugin's `ctx.buddi.accounts.generateCodexImage`). Same exclusivity and
   * refresh as a chat turn; the token stays here.
   */
  async generateImage(access: CodexAccountAccess, model: string, options: CodexImageOptions): Promise<CodexImage> {
    return this.#exclusive(access.id, async (abort) => {
      const tokens = await this.#credential(access);
      await access.check();
      const signal = options.signal ? AbortSignal.any([options.signal, abort]) : abort;
      return generateCodexImage(
        { model, accessToken: tokens.accessToken, accountId: tokens.accountId, ...(this.deps.transport ? { transport: this.deps.transport } : {}) },
        { prompt: options.prompt, references: options.references, ...(options.size ? { size: options.size } : {}), signal },
      );
    });
  }

  /**
   * Stage this account's credential in a private profile and hand it to `use`,
   * which runs its own native child (the image plugin's `codex exec`). A
   * refresh the child made is saved back; the profile is removed afterwards
   * whatever happened.
   */
  async withProfile<T>(access: CodexAccountAccess, use: (profile: CodexProfile) => Promise<T>): Promise<T> {
    return this.#exclusive(access.id, async (abort) => {
      const tokens = await this.#credential(access);
      await access.check();
      const staged = await stageCodexProfile(tokens);
      try {
        return await use({ home: staged.home, env: staged.env });
      } finally {
        try {
          const after = await staged.credential().catch(() => null);
          if (after && !abort.aborted && (after.accessToken !== tokens.accessToken || after.refreshToken !== tokens.refreshToken)) {
            await access.check();
            await this.deps.vault.set(access.secretRef, JSON.stringify(after));
          }
        } finally { await staged.dispose(); }
      }
    });
  }
}
