/**
 * mlxh, the local MLX model server, from the gateway's side: is it running
 * here, what does it serve, and how long a prompt will it take.
 *
 * Asked from the gateway, never from the page, for the reason Ollama is: the
 * dashboard reaches no host but its own, and the answer is about the machine
 * buddi runs on. Two read-only calls, `GET /mlxh/info` and `GET /v1/models`;
 * nothing here ever sends mlxh a prompt.
 */
import { MLXH_BASE_URL, MLXH_DEFAULT_MAX_PROMPT_TOKENS } from '@buddi/core';
import { createHttpTransport, type HttpTransport } from '@buddi/runtime';

/** How long the probe waits: mlxh's own callers of /mlxh/info give up after about 2 s. */
export const MLXH_TIMEOUT_MS = 2_000;

/** One connection per probe, nothing pooled. */
const mlxhTransport: HttpTransport = createHttpTransport({ idleTimeoutMs: MLXH_TIMEOUT_MS });

export interface MlxhModel {
  id: string;
  /** A worker for it is resident now. */
  loaded: boolean;
  /** Only known once loaded: mlxh reads it from the worker. */
  kind?: 'language' | 'image';
}

export interface MlxhProbe {
  running: boolean;
  /** Where an account for it points, `/v1` included. */
  baseUrl: string;
  /** `mlxh serve` with no model: every installed model, loaded on demand. */
  manager: boolean;
  models: MlxhModel[];
  /**
   * The server's own `max_prompt_tokens`, when it reports one (a pinned
   * `mlxh serve NAME` does; the manager does not). 0 means the limit is off.
   */
  maxPromptTokens?: number;
  workerIdleTimeoutS?: number;
  version?: string;
}

/** Where mlxh answers: the `MLXH_BASE_URL` override, else its default address. */
export function mlxhBaseUrl(env: NodeJS.ProcessEnv | Record<string, string | undefined> = {}): string {
  const raw = env.MLXH_BASE_URL?.trim();
  return (raw || MLXH_BASE_URL).replace(/\/+$/, '');
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
const cleanId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 150 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;

/**
 * Ask mlxh whether it is running, what it has installed, and what it loaded.
 * Never throws: nothing answering, a refusal, or two seconds gone are all
 * `running: false`.
 */
export async function probeMlxh(
  opts: { transport?: HttpTransport; baseUrl?: string; timeoutMs?: number } = {},
): Promise<MlxhProbe> {
  const transport = opts.transport ?? mlxhTransport;
  const baseUrl = (opts.baseUrl ?? MLXH_BASE_URL).replace(/\/+$/, '');
  const origin = baseUrl.replace(/\/v1$/, '');
  const signal = AbortSignal.timeout(opts.timeoutMs ?? MLXH_TIMEOUT_MS);
  const ask = async (url: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const res = await transport(url, { method: 'GET', headers: { Accept: 'application/json' }, signal, maxBytes: 1024 * 1024 });
      if (!res.ok) return undefined;
      return record(await res.json());
    } catch { return undefined; }
  };
  const [info, list] = await Promise.all([ask(`${origin}/mlxh/info`), ask(`${baseUrl}/models`)]);
  if (!info && !list) return { running: false, baseUrl, manager: false, models: [] };

  const workers = new Map<string, Record<string, unknown>>();
  for (const w of Array.isArray(info?.workers) ? info.workers : []) {
    const row = record(w);
    const id = cleanId(row?.model);
    if (row && id && row.state !== 'exited') workers.set(id, row);
  }
  const ids: string[] = [];
  for (const m of Array.isArray(list?.data) ? list.data : []) {
    const id = cleanId(record(m)?.id);
    if (id && !ids.includes(id)) ids.push(id);
  }
  // The manager lists its models by name too; a pinned server names its one.
  for (const name of Array.isArray(info?.models) ? info.models : []) {
    const id = cleanId(name);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const pinned = cleanId(info?.model);
  if (pinned && !ids.includes(pinned)) ids.push(pinned);

  const manager = info?.manager === true || info?.model_kind === 'manager';
  const models: MlxhModel[] = ids.slice(0, 200).map((id) => {
    const worker = workers.get(id);
    const kindRaw = worker?.model_kind ?? (!manager && id === pinned ? info?.model_kind : undefined);
    const kind = kindRaw === 'language' || kindRaw === 'image' ? kindRaw : undefined;
    return { id, loaded: !!worker || (!manager && id === pinned), ...(kind ? { kind } : {}) };
  });
  const settings = record(info?.settings);
  const maxPromptTokens = count(settings?.max_prompt_tokens) ?? count(info?.max_prompt_tokens);
  const idle = info?.worker_idle_timeout_s;
  const version = typeof info?.version === 'string' && info.version.length <= 40 ? info.version : undefined;
  return {
    running: true, baseUrl, manager, models,
    ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
    ...(typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 ? { workerIdleTimeoutS: idle } : {}),
    ...(version ? { version } : {}),
  };
}

/**
 * The window buddi gives an mlxh model: the server's `max_prompt_tokens` when
 * it reported one, else mlxh's default. Null when the server turned the limit
 * off, so buddi's own table for the model decides.
 */
export function mlxhWindow(probe: Pick<MlxhProbe, 'maxPromptTokens'>): number | null {
  if (probe.maxPromptTokens === 0) return null;
  return probe.maxPromptTokens ?? MLXH_DEFAULT_MAX_PROMPT_TOKENS;
}
