/**
 * The ONNX Runtime N-API binding, opened from a verified folder.
 *
 * buddi talks to `onnxruntime_binding.node` directly instead of through the
 * `onnxruntime-node` package: the package's JavaScript is a thin wrapper, and
 * it would put the whole all-platforms npm package back in the install. The
 * binding is handed a tensor class at `initOrtOnce` and builds its outputs
 * with it; the one here is the minimum it reads and writes (`type`, `data`,
 * `dims`, `location`), the same fields `onnxruntime-common`'s `Tensor` has.
 */
import { isMainThread } from 'node:worker_threads';
import path from 'node:path';
import type { OnnxPin } from './pins.js';

/** The element types the binding understands, by their names. */
export type OnnxTensorType =
  | 'float32'
  | 'float64'
  | 'float16'
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'bool'
  | 'string';

/** A tensor as a plugin hands it in and gets it back: plain data. */
export interface OnnxTensor {
  type: OnnxTensorType;
  data:
    | Float32Array
    | Float64Array
    | Uint16Array
    | Int8Array
    | Uint8Array
    | Int16Array
    | Int32Array
    | Uint32Array
    | BigInt64Array
    | BigUint64Array
    | string[];
  dims: readonly number[];
}

/** The tensor class handed to the binding. */
export class OrtTensor {
  readonly location = 'cpu';
  readonly size: number;
  constructor(
    readonly type: string,
    readonly data: OnnxTensor['data'],
    readonly dims: readonly number[],
  ) {
    this.size = data.length;
  }
}

export interface NativeValueMetadata {
  name: string;
  isTensor: boolean;
  type: number;
  shape: number[];
  symbolicDimensions: string[];
}

export interface NativeSession {
  loadModel(modelPath: string, options: Record<string, unknown>): void;
  readonly inputMetadata: NativeValueMetadata[];
  readonly outputMetadata: NativeValueMetadata[];
  run(feeds: Record<string, OrtTensor>, fetches: Record<string, null>, options: Record<string, unknown>): Record<string, OrtTensor>;
  dispose(): void;
}

/** What `onnxruntime_binding.node` exports. */
export interface OnnxNative {
  InferenceSession: new () => NativeSession;
  initOrtOnce(logLevel: number, tensor: unknown, isMainThread: boolean): void;
}

/**
 * Open the binding in `dir` and initialise it once. The folder has been
 * checked against the pin by the caller; this only loads it.
 */
export function dlopenNative(dir: string, _pin: OnnxPin): OnnxNative {
  const module = { exports: {} as unknown };
  process.dlopen(module, path.join(dir, 'onnxruntime_binding.node'));
  const native = module.exports as OnnxNative;
  if (typeof native?.InferenceSession !== 'function' || typeof native.initOrtOnce !== 'function') {
    throw new Error('the binding does not export InferenceSession and initOrtOnce');
  }
  // Warning level (2): errors and warnings reach the log, nothing chattier.
  native.initOrtOnce(2, OrtTensor, isMainThread);
  return native;
}
