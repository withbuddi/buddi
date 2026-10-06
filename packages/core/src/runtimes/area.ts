/**
 * `ctx.buddi.onnx` and `ctx.buddi.models`, for a plugin that declares
 * `uses: ['onnx']` (docs/plugin-host-api.md §4.2, 1.32). Built by
 * `createPluginHost`; a plugin without the declaration has neither.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import type { ActionRecord } from '../actions/types.js';
import type { ModelsArea, OnnxArea } from '../host/types.js';
import { downloadArgs, raiseDownloadCard } from './consent.js';
import { approvedModelFiles, checkModelRequest, modelState, ModelRefusal, startModelDownload, sweepModelTemps } from './models.js';
import { createOnnxSession, onnxApproved, onnxState, OnnxUnavailable, startOnnxDownload, sweepOnnxTemps } from './onnx.js';
import { modelsRoot } from './config.js';

const swept = new Set<string>();

/**
 * Sweep what downloads that died left (half-written `.tmp-*` tarballs and
 * folders) under the engine's version folder and `models/`, once per data
 * directory per process: at boot, from `configurePluginHost`. Never throws.
 */
export async function sweepRuntimesOnce(): Promise<void> {
  const root = modelsRoot();
  if (swept.has(root)) return;
  swept.add(root);
  await sweepOnnxTemps().catch(() => 0);
  await sweepModelTemps().catch(() => 0);
}

export interface RuntimeAreaFacts {
  plugin: string;
  /** The plugin's own directory: a model there may be opened. Made on first use. */
  dir: () => string;
  pool: () => Pool;
  agentId?: string | undefined;
  conversationId?: string | undefined;
  now: () => Date;
  askApproval?: ((action: ActionRecord) => Promise<void>) | undefined;
}

/** Inside `root`, after links are followed. */
function within(file: string, root: string): boolean {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(file);
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const relative = path.relative(realRoot, real);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function onnxAreaOf(facts: RuntimeAreaFacts): OnnxArea {
  const card = (args: Parameters<typeof raiseDownloadCard>[1]) =>
    raiseDownloadCard(
      { pool: facts.pool(), plugin: facts.plugin, agentId: facts.agentId, conversationId: facts.conversationId, now: facts.now, askApproval: facts.askApproval },
      args,
    );
  return {
    async state() {
      return onnxState();
    },
    async ensure(req) {
      let state = onnxState();
      // Approved before a restart cut the download short: it resumes, no second card.
      if (state.state === 'absent' && onnxApproved()) {
        void startOnnxDownload();
        state = onnxState();
      }
      if (state.state === 'failed') return state;
      const model = req?.model;
      // A shared model already kept, or downloading, needs no card of its own.
      const shared = model !== undefined && (model.id !== undefined || model.files !== undefined);
      let modelMissing = false;
      if (shared) {
        const checked = checkModelRequest({ id: model.id ?? '', files: model.files ?? [] });
        const current = modelState(checked.id, checked.files);
        if (current.state === 'failed') throw new ModelRefusal(current.reason ?? `Model ${checked.id} failed.`);
        if (current.state === 'absent' && approvedModelFiles(checked.id, checked.files)) {
          void startModelDownload({ id: checked.id, files: checked.files }).catch(() => {});
        } else {
          modelMissing = current.state === 'absent';
        }
      }
      if (state.state === 'downloading' && !modelMissing) return state;
      const engineMissing = state.state === 'absent';
      // A model the plugin fetches itself rides on the engine's card; once the
      // engine is here, it asks nothing more.
      const forCard = shared ? (modelMissing ? model : undefined) : engineMissing ? model : undefined;
      const args = downloadArgs(facts.plugin, req?.reason ?? '', engineMissing, forCard);
      if (args === undefined) return state;
      return { ...state, pending: await card(args) };
    },
    async createSession(modelPath, opts) {
      if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath)) {
        throw new TypeError('createSession takes an absolute path to a model file');
      }
      if (!within(modelPath, facts.dir()) && !within(modelPath, modelsRoot())) {
        throw new OnnxUnavailable(
          `${facts.plugin} may open a model in its own directory or in buddi's shared models, not ${modelPath}.`,
        );
      }
      const state = onnxState();
      if (state.state !== 'ready') {
        throw new OnnxUnavailable(state.reason ?? `The engine is ${state.state}; ask for it with ctx.buddi.onnx.ensure first.`);
      }
      const session = createOnnxSession(modelPath, opts ?? {});
      // Only the plugin's part: the session's internals stay core's.
      return {
        run: (feeds) => session.run(feeds),
        names: () => session.names(),
        get loaded() {
          return session.loaded;
        },
        close: () => session.close(),
      };
    },
  };
}

export function modelsAreaOf(facts: RuntimeAreaFacts): ModelsArea {
  return {
    async state(id) {
      return modelState(id);
    },
    async ensure(req) {
      const checked = checkModelRequest(req);
      let current = modelState(checked.id, checked.files);
      // Approved before a restart cut the download short: it resumes, no second card.
      if (current.state === 'absent' && approvedModelFiles(checked.id, checked.files)) {
        void startModelDownload({ id: checked.id, files: checked.files }).catch(() => {});
        current = modelState(checked.id, checked.files);
      }
      if (current.state !== 'absent') return { ...current, sizeBytes: current.sizeBytes || checked.bytes };
      const args = downloadArgs(facts.plugin, req.reason, false, { id: checked.id, files: checked.files, ...(req.name ? { name: req.name } : {}) });
      const pending = await raiseDownloadCard(
        { pool: facts.pool(), plugin: facts.plugin, agentId: facts.agentId, conversationId: facts.conversationId, now: facts.now, askApproval: facts.askApproval },
        args!,
      );
      return { ...current, sizeBytes: checked.bytes, pending };
    },
  };
}
