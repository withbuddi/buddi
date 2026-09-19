import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getOwnerProfile, isKnownTimezone, localDateTimeString, type PluginManifest, type SystemContext, type ToolContext } from '@buddi/core';

const exec = promisify(execFile);
const clean = (value: string): string => value.trim().replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 120);
async function command(file: string, args: string[]): Promise<string | null> {
  try { return clean((await exec(file, args, { timeout: 1500, maxBuffer: 8192 })).stdout) || null; }
  catch { return null; }
}

export interface HostFacts {
  os: string; version: string; kernel: string; architecture: string;
  hardwareModel: string | null; hostTimezone: string; execution: string;
}
let cached: { at: number; value: Promise<HostFacts> } | undefined;
/** Only allowlisted facts. Never hostname, serial number, usernames, paths or environment dumps. */
export function hostFacts(): Promise<HostFacts> {
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const value = (async (): Promise<HostFacts> => {
    const platform = os.platform();
    let version = os.release();
    let hardwareModel: string | null = null;
    if (platform === 'darwin') {
      const [product, model] = await Promise.all([
        command('/usr/bin/sw_vers', ['-productVersion']),
        command('/usr/sbin/sysctl', ['-n', 'hw.model']),
      ]);
      version = product ?? version; hardwareModel = model;
    } else if (platform === 'linux') {
      try { hardwareModel = clean(await readFile('/sys/devices/virtual/dmi/id/product_name', 'utf8')) || null; } catch { /* Not exposed on every host/container. */ }
    }
    let container = false;
    if (platform === 'linux') {
      try { await readFile('/.dockerenv'); container = true; } catch { /* Absence does not prove bare metal. */ }
    }
    return { os: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform,
      version, kernel: os.release(), architecture: os.arch(), hardwareModel,
      hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      execution: container ? 'Detected container; facts describe the runtime environment.' : 'Buddi server host; container/VM status not verified. This is not necessarily the dashboard client device.' };
  })();
  cached = { at: Date.now(), value }; return value;
}

export async function systemTime(ctx: ToolContext) {
  let timezone = isKnownTimezone(ctx.timezone) ? ctx.timezone : 'UTC';
  let timezoneSource = 'configured fallback';
  try {
    const profile = await getOwnerProfile(ctx.db);
    if (profile.timezone && isKnownTimezone(profile.timezone)) {
      timezone = profile.timezone.trim(); timezoneSource = 'owner profile';
    }
  } catch { timezoneSource = 'configured fallback (owner profile unavailable)'; }
  const now = ctx.now();
  return { utc: now.toISOString(), local: localDateTimeString(now, timezone), timezone, timezoneSource };
}

export async function systemInfo(ctx: ToolContext) {
  const [time, host] = await Promise.all([systemTime(ctx), hostFacts()]);
  return { time, host, note: 'Host facts do not grant access. Use granted host/browser status tools for live permissions and availability. Existing schedules retain their saved timezone.' };
}

export async function systemContext(ctx: ToolContext): Promise<SystemContext> {
  const info = await systemInfo(ctx);
  return { timezone: info.time.timezone, prompt: 'Current platform context (authoritative over dates in persona or conversation history):\n' +
    JSON.stringify(info) + '\nThis clock is a turn-start snapshot. Use system.time for a fresh reading and system.info to check host facts. Interpret today/yesterday in the owner timezone unless the user specifies otherwise.' };
}

export function createSystemManifest(): PluginManifest {
  return { name: 'system', version: '0.1.0', schema: 'system', migrationsDir: '', tools: [
    { name: 'system.time', description: 'Read the current UTC and owner-local date/time and confirmed timezone. Always available; no approval needed.', tier: 'auto', input: z.object({}).strict(), execute: async (_input, ctx) => systemTime(ctx) },
    { name: 'system.info', description: 'Read server-host OS/version, architecture, hardware model when detectable, host timezone, and current owner-local time. Not the dashboard client. No credentials or serial numbers.', tier: 'auto', input: z.object({}).strict(), execute: async (_input, ctx) => systemInfo(ctx) },
  ] };
}
