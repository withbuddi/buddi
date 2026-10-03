import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/*
 * The computer helper: one Swift file, compiled with the Xcode command line
 * tools' swiftc and signed ad hoc (Apple Silicon refuses to run an unsigned
 * arm64 binary). Nothing happens off macOS: the helper is simply absent there,
 * and computer control is macOS-only.
 *
 * `--universal` (or BUDDI_NATIVE_UNIVERSAL=1) builds arm64 and x86_64 and
 * joins them with lipo: what the release ships, built by the release
 * workflow's macOS job. A local build compiles this Mac's architecture only.
 */
// Native source is part of this package; never compile source supplied by a tool.
if (process.platform === 'darwin') {
  const root = new URL('../', import.meta.url);
  const output = fileURLToPath(new URL('dist/native/buddi-computer', root));
  const source = fileURLToPath(new URL('native/Computer.swift', root));
  mkdirSync(fileURLToPath(new URL('dist/native', root)), { recursive: true });
  const universal = process.argv.includes('--universal') || process.env.BUDDI_NATIVE_UNIVERSAL === '1';
  const compile = (arch, to) => execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${arch}-apple-macosx14.0`, source, '-o', to], { stdio: 'inherit' });
  if (universal) {
    const slices = ['arm64', 'x86_64'].map((arch) => ({ arch, file: `${output}-${arch}` }));
    try {
      for (const { arch, file } of slices) compile(arch, file);
      execFileSync('/usr/bin/lipo', ['-create', ...slices.map((s) => s.file), '-output', output], { stdio: 'inherit' });
    } finally { for (const { file } of slices) rmSync(file, { force: true }); }
  } else {
    compile(process.arch === 'arm64' ? 'arm64' : 'x86_64', output);
  }
  // Signed after lipo: joining slices would invalidate a signature made before.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.buddi.computer', output], { stdio: 'inherit' });
}
