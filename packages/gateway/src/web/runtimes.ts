/**
 * Settings → System, "Local models": the ONNX engine and the shared models
 * (host API 1.32, docs/plugin-host-api.md §4.2 `onnx`). A read of where each
 * stands, and Remove. Nothing here downloads: a download starts only from the
 * owner's approved card.
 */
import { listModels, onnxSessionCounts, onnxState, removeModel, removeOnnxRuntime } from '@buddi/core';

export interface RuntimesAnswer {
  status: number;
  body: unknown;
}

export function runtimesView(): RuntimesAnswer {
  return { status: 200, body: { onnx: { ...onnxState(), sessions: onnxSessionCounts() }, models: listModels() } };
}

/** `DELETE /api/runtimes/onnx`. */
export async function removeEngineRoute(): Promise<RuntimesAnswer> {
  const result = await removeOnnxRuntime();
  if (result.refused !== undefined) return { status: 409, body: { error: result.refused } };
  return runtimesView();
}

/** `DELETE /api/runtimes/models/:id`. */
export async function removeModelRoute(id: string): Promise<RuntimesAnswer> {
  const result = await removeModel(id);
  if (result.refused !== undefined) return { status: 409, body: { error: result.refused } };
  return runtimesView();
}
