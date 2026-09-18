import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Native source is part of this package; never compile source supplied by a tool.
if (process.platform === 'darwin') {
  const root = new URL('../', import.meta.url);
  const output = fileURLToPath(new URL('dist/native/buddi-computer', root));
  mkdirSync(fileURLToPath(new URL('dist/native', root)), { recursive: true });
  execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, fileURLToPath(new URL('native/Computer.swift', root)), '-o', output], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.buddi.computer', output], { stdio: 'inherit' });
}
