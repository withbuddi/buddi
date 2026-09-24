/** Experimental Codex App Server NDJSON client. No credentials or raw stderr in errors. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type RpcMessage = { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
export interface CodexRpc {
  readonly processId?: number;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onMessage(listener: (message: RpcMessage) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export function createCodexRpc(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): CodexRpc {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(message: RpcMessage) => void>();
  const closeListeners = new Set<(error: Error) => void>();
  const decoder = new StringDecoder('utf8');
  let sequence = 0;
  let buffer = '';
  let closed: Error | undefined;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  child.once('exit', resolveStopped);
  child.once('error', resolveStopped);
  const close = (error: Error) => {
    if (closed) return;
    closed = error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
    for (const listener of closeListeners) listener(error);
    // Every client owns its child, never a shared/user Codex process.
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1_000);
    timer.unref();
  };
  const send = (message: RpcMessage) => {
    if (closed) throw closed;
    child.stdin.write(JSON.stringify(message) + '\n');
  };
  child.on('error', () => close(new Error('Codex App Server could not start. Check the configured executable.')));
  child.on('exit', () => close(new Error('Codex App Server exited.')));
  child.stdin.on('error', () => close(new Error('Codex App Server input closed.')));
  child.stderr.resume(); // Drain, never copy auth codes, tokens or provider bodies to logs.
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { close(new Error('Codex protocol frame exceeded the size limit.')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        message = value as RpcMessage;
      } catch { close(new Error('Invalid Codex App Server protocol frame.')); return; }
      if (!message.method && typeof message.id === 'number') {
        const call = pending.get(message.id);
        if (!call) continue;
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error !== undefined) call.reject(new Error('Codex App Server rejected the request.'));
        else call.resolve(message.result);
      } else {
        // Never grant native command/file/permission requests. Tool requests are
        // proposals only: the adapter closes this child before Buddi executes one.
        if (message.id !== undefined && message.method !== 'item/tool/call') {
          send({ id: message.id, error: { code: -32601, message: 'Only Buddi dynamic tools are supported.' } });
          close(new Error('Codex requested an unsupported native capability.'));
          return;
        }
        for (const listener of listeners) listener(message);
      }
    }
  });
  return {
    processId: child.pid,
    request(method, params) {
      if (closed) return Promise.reject(closed);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(new Error('Codex App Server request timed out.')), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    },
    notify(method, params) { send({ method, params }); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onClose(listener) { if (closed) listener(closed); else closeListeners.add(listener); return () => closeListeners.delete(listener); },
    async close() {
      close(new Error('Codex App Server session closed.'));
      if (child.exitCode !== null || child.signalCode !== null) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([stopped, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Codex child did not stop; tool execution must not proceed.')), 3_000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

export async function initializeCodex(rpc: CodexRpc): Promise<void> {
  await rpc.request('initialize', {
    clientInfo: { name: 'buddi_codex_experiment', title: 'Buddi experimental adapter', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  rpc.notify('initialized');
}

/** No shell, no inherited provider keys, no user's Codex configuration. */
export function spawnCodexRpc(options: {
  executable: string;
  profileDir: string;
  cwd: string;
  args: readonly string[];
}): CodexRpc {
  return createCodexRpc(spawn(options.executable, ['app-server', ...options.args], {
    cwd: options.cwd, env: codexChildEnv(options.profileDir), stdio: 'pipe', shell: false,
  }));
}

/**
 * The whole environment a native Codex child gets: a short allowlist, so no
 * ambient provider key (OPENAI_API_KEY and the like) and no owner CODEX_HOME
 * reaches it. CODEX_HOME is the native client's documented per-account
 * configuration, not a change to this process or the owner's CLI environment.
 */
export function codexChildEnv(profileDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  env.CODEX_HOME = profileDir;
  return env;
}
