/**
 * The nightly job's unit files — pure text, no launchctl.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_HOUR,
  BACKUP_LABEL,
  BACKUP_MINUTE,
  buildBackupPlist,
  buildBackupTimer,
  type BackupUnitSpec,
} from './schedule.js';

const SPEC: BackupUnitSpec = {
  label: BACKUP_LABEL,
  nodePath: '/opt/homebrew/bin/node',
  cliEntry: '/Users/o/buddi/packages/cli/dist/main.js',
  workingDirectory: '/Users/o/buddi',
  logFile: '/Users/o/buddi/data/logs/backup.log',
  errorFile: '/Users/o/buddi/data/logs/backup.err',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  hour: BACKUP_HOUR,
  minute: BACKUP_MINUTE,
  keep: 14,
};

describe('buildBackupPlist', () => {
  const plist = buildBackupPlist(SPEC);

  it('runs `buddi backup create --prune <keep>`', () => {
    expect(plist).toContain('<string>/Users/o/buddi/packages/cli/dist/main.js</string>');
    expect(plist).toContain('<string>backup</string>');
    expect(plist).toContain('<string>create</string>');
    expect(plist).toContain('<string>--prune</string>');
    expect(plist).toContain('<string>14</string>');
  });

  it('fires on the calendar at 03:30 — not on an interval a closed lid would miss', () => {
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).toContain('<key>Hour</key>\n    <integer>3</integer>');
    expect(plist).toContain('<key>Minute</key>\n    <integer>30</integer>');
    expect(plist).not.toContain('StartInterval');
  });

  it('does not run at load — installing a backup tool must not take one', () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });

  it('is a separate label from the server, so one can be off while the other runs', () => {
    expect(plist).toContain('<string>com.buddi.backup</string>');
    expect(plist).not.toContain('com.buddi.serve');
  });

  it('logs to the data dir', () => {
    expect(plist).toContain('<string>/Users/o/buddi/data/logs/backup.log</string>');
    expect(plist).toContain('<string>/Users/o/buddi/data/logs/backup.err</string>');
  });

  it('never puts a credential in the unit', () => {
    expect(plist).not.toMatch(/TOKEN|API_KEY|PASSWORD|DATABASE_URL/);
  });

  it('is well-formed XML with escaped paths', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
    expect(buildBackupPlist({ ...SPEC, workingDirectory: '/a & b' })).toContain('/a &amp; b');
  });
});

describe('buildBackupTimer', () => {
  const units = buildBackupTimer(SPEC);

  it('describes the same job as the plist', () => {
    expect(units.service).toContain(
      'ExecStart=/opt/homebrew/bin/node /Users/o/buddi/packages/cli/dist/main.js backup create --prune 14',
    );
    expect(units.timer).toContain('OnCalendar=*-*-* 03:30:00');
  });

  it('is Persistent, so a machine that was asleep still backs up', () => {
    expect(units.timer).toContain('Persistent=true');
  });
});
