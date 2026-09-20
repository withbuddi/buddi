import { describe, expect, it } from 'vitest';
import {
  buildPlist,
  buildSystemdUnit,
  escapeXml,
  parseLaunchctlPrint,
  parseSystemctlShow,
  type UnitSpec,
} from './units.js';

const SPEC: UnitSpec = {
  label: 'com.buddi.serve',
  nodePath: '/opt/homebrew/bin/node',
  serveEntry: '/Users/o/buddi/packages/gateway/dist/serve.js',
  workingDirectory: '/Users/o/buddi',
  logFile: '/Users/o/buddi/data/logs/serve.log',
  errorFile: '/Users/o/buddi/data/logs/serve.err',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
};

describe('buildPlist', () => {
  const plist = buildPlist(SPEC);

  it('supports a packaged supervisor with an isolated non-secret data directory', () => {
    const packed = buildPlist({ ...SPEC, args: ['supervise'], environment: { BUDDI_DATA_DIR: '/owner/A & B' } });
    expect(packed).toContain('<string>supervise</string>');
    expect(packed).toContain('<key>BUDDI_DATA_DIR</key>');
    expect(packed).toContain('<string>/owner/A &amp; B</string>');
    expect(packed).not.toMatch(/TOKEN|API_KEY|DATABASE_URL/);
  });

  it('runs the built serve entry with node, from the repo root', () => {
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(plist).toContain('<string>/Users/o/buddi/packages/gateway/dist/serve.js</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/o/buddi</string>');
  });

  it('keeps the service alive and starts it at login', () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('sends stdout and stderr to separate files', () => {
    expect(plist).toContain('<string>/Users/o/buddi/data/logs/serve.log</string>');
    expect(plist).toContain('<string>/Users/o/buddi/data/logs/serve.err</string>');
  });

  it('gives the job a PATH — launchd hands it almost nothing', () => {
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
  });

  it('is a well-formed plist with the label first', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
    expect(plist).toContain('<key>Label</key>\n  <string>com.buddi.serve</string>');
  });

  it('escapes a path that would otherwise break the XML', () => {
    const odd = buildPlist({ ...SPEC, workingDirectory: '/Users/a & b/<buddi>' });
    expect(odd).toContain('/Users/a &amp; b/&lt;buddi&gt;');
    expect(odd).not.toContain('<buddi>');
  });

  it('never puts a credential in the unit — the process reads .env itself', () => {
    expect(plist).not.toMatch(/TOKEN|API_KEY|DATABASE_URL/);
  });
});

describe('escapeXml', () => {
  it('escapes all five entities', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
});

describe('buildSystemdUnit', () => {
  const unit = buildSystemdUnit(SPEC);

  it('describes the same service as the plist', () => {
    expect(unit).toContain(
      'ExecStart=/opt/homebrew/bin/node /Users/o/buddi/packages/gateway/dist/serve.js',
    );
    expect(unit).toContain('WorkingDirectory=/Users/o/buddi');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('StandardOutput=append:/Users/o/buddi/data/logs/serve.log');
    expect(unit).toContain('StandardError=append:/Users/o/buddi/data/logs/serve.err');
    expect(unit).toContain('WantedBy=default.target');
  });
});

describe('parseLaunchctlPrint', () => {
  it('reads the pid of a running job', () => {
    const out = `com.buddi.serve = {
	active count = 1
	path = /Users/o/Library/LaunchAgents/com.buddi.serve.plist
	state = running
	pid = 40321
	program = /opt/homebrew/bin/node
}`;
    expect(parseLaunchctlPrint(out)).toEqual({ running: true, pid: 40321 });
  });

  it('counts a job with state=running but no pid as running', () => {
    expect(parseLaunchctlPrint('\tstate = running\n')).toEqual({ running: true });
  });

  it('reports a loaded but idle job as not running', () => {
    expect(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 0\n')).toEqual({
      running: false,
    });
  });
});

describe('parseSystemctlShow', () => {
  it('reads ActiveState and MainPID', () => {
    expect(parseSystemctlShow('ActiveState=active\nSubState=running\nMainPID=912\n')).toEqual({
      running: true,
      pid: 912,
    });
  });

  it('treats MainPID=0 as no pid', () => {
    expect(parseSystemctlShow('ActiveState=inactive\nSubState=dead\nMainPID=0\n')).toEqual({
      running: false,
    });
  });
});
