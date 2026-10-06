/**
 * The ONNX Runtime builds buddi fetches, pinned (docs/plugin-host-api.md §4.2
 * `onnx`, 1.32).
 *
 * The source is the `onnxruntime-node` tarball on the npm registry, because it
 * is the only place Microsoft publishes the small N-API binding
 * (`onnxruntime_binding.node`) beside the shared library it links: the GitHub
 * release archives (`onnxruntime-<os>-<arch>-<ver>.tgz`) carry the C library
 * and no binding. The tarball holds every platform, so buddi downloads it
 * once, checks its sha256 against the pin below, and extracts only this
 * platform's two files, each checked against its own pin, before anything is
 * moved into place or loaded. The rest of the tarball is never written.
 *
 * One version, 1.30.0 (the newest stable), everywhere Microsoft still builds
 * it. 1.24 dropped macOS x64 from both npm and the GitHub releases, and
 * darwin-x64 (1.23.2, the last build that has it) is left out until it has
 * been checked on an Intel Mac (see below). Windows is not offered yet.
 *
 * To move a pin: download the tarball, `shasum -a 256` it and the two files
 * under `package/bin/napi-v6/<platform>/<arch>/`, and change all four numbers
 * here together. Pure data; nothing here does I/O.
 */

/** One file kept from the tarball. */
export interface OnnxPinnedFile {
  /** Its path inside the tarball. */
  entry: string;
  /** Its name on disk, which the binding's rpath expects. */
  name: string;
  sha256: string;
  bytes: number;
}

export interface OnnxPin {
  version: string;
  /** What is downloaded: the whole npm tarball, checked before it is opened. */
  tarball: { url: string; sha256: string; bytes: number };
  /** What is kept: this platform's binding and library. */
  files: readonly OnnxPinnedFile[];
}

/** `<platform>-<arch>`, as Node names them. */
export type OnnxPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64';

const TARBALL_1_30_0 = {
  url: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.30.0.tgz',
  sha256: '6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75',
  bytes: 113_507_888,
};

const BIN = 'package/bin/napi-v6';

/*
 * darwin-x64 is left out for now, so an Intel Mac reads "not available on
 * this platform". Its pin was 1.23.2 (the last release with an Intel Mac
 * binding), keeping `libonnxruntime.1.23.2.dylib` where every other platform
 * keeps the `.1` soname; whether that binding's install name points at that
 * exact file has not been checked. Load it once by hand on an Intel Mac
 * (`otool -L onnxruntime_binding.node`, then a run) before adding it back:
 * tarball onnxruntime-node-1.23.2.tgz, sha256
 * fe70e8de46560c57c2dfb7170770da32dbb21684504a5c904346c44a56e154f2, 97134627 bytes.
 */
export const ONNX_PINS: Readonly<Partial<Record<OnnxPlatform, OnnxPin>>> = {
  'darwin-arm64': {
    version: '1.30.0',
    tarball: TARBALL_1_30_0,
    files: [
      { entry: `${BIN}/darwin/arm64/onnxruntime_binding.node`, name: 'onnxruntime_binding.node', sha256: 'a3f993357759b06ae2411f70af60f5e041d04521ea7f0d12cb7546e411a527dd', bytes: 266_840 },
      { entry: `${BIN}/darwin/arm64/libonnxruntime.1.dylib`, name: 'libonnxruntime.1.dylib', sha256: '685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d', bytes: 44_589_928 },
    ],
  },
  'linux-x64': {
    version: '1.30.0',
    tarball: TARBALL_1_30_0,
    files: [
      { entry: `${BIN}/linux/x64/onnxruntime_binding.node`, name: 'onnxruntime_binding.node', sha256: 'ccdc60b981d93a490cf9513d3f583547252b6e285b72988a96a494f2f006c7b8', bytes: 389_488 },
      { entry: `${BIN}/linux/x64/libonnxruntime.so.1`, name: 'libonnxruntime.so.1', sha256: 'ffb75a925ba05e47b235bb66e3e3911714a80b328a9c9425539feb204aa32a23', bytes: 45_828_512 },
    ],
  },
  'linux-arm64': {
    version: '1.30.0',
    tarball: TARBALL_1_30_0,
    files: [
      { entry: `${BIN}/linux/arm64/onnxruntime_binding.node`, name: 'onnxruntime_binding.node', sha256: 'afec78dc11d38dc81605b068cefe1fc73ffe77ca240c15468aa40786150beac8', bytes: 394_648 },
      { entry: `${BIN}/linux/arm64/libonnxruntime.so.1`, name: 'libonnxruntime.so.1', sha256: '1f549d46250b005580b597f4164984aaf75b3bcb9f3aeb07c7f8a8fe60b23c76', bytes: 25_135_496 },
    ],
  },
};

/** The pin for a platform, or undefined where buddi offers no engine (Windows, anything else). */
export function onnxPinFor(platform: string, arch: string): { key: OnnxPlatform; pin: OnnxPin } | undefined {
  const key = `${platform}-${arch}`;
  const pin = Object.prototype.hasOwnProperty.call(ONNX_PINS, key) ? ONNX_PINS[key as OnnxPlatform] : undefined;
  return pin === undefined ? undefined : { key: key as OnnxPlatform, pin };
}

/** What a pin keeps on disk. */
export function pinnedBytes(pin: OnnxPin): number {
  return pin.files.reduce((sum, file) => sum + file.bytes, 0);
}
