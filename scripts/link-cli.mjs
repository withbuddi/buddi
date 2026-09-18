import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const configured = spawnSync('pnpm', ['config', 'get', 'global-bin-dir'], {
  encoding: 'utf8',
});
if (configured.status !== 0) process.exit(configured.status ?? 1);

const explicit = configured.stdout.trim();
const bin = explicit && explicit !== 'undefined'
  ? explicit
  : process.env.PNPM_HOME ? join(process.env.PNPM_HOME, 'bin') : (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'pnpm', 'bin')
    : join(homedir(), '.local', 'share', 'pnpm'));
const pnpmHome = process.env.PNPM_HOME || dirname(bin);
const path = [bin, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
const linked = spawnSync('pnpm', ['add', '--global', './packages/cli'], {
  stdio: 'inherit',
  env: { ...process.env, PATH: path, PNPM_HOME: pnpmHome },
});
process.exit(linked.status ?? 1);
