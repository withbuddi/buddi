/**
 * The blocking rules, against the policy that actually ships.
 *
 * Every case here runs through `DEFAULT_POLICY` — the constant the installed
 * manifest hard-wires — rather than through a policy the test built. A suite
 * that proved a permissive policy blocks nothing would be worth nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PORTS,
  BlockedError,
  DEFAULT_POLICY,
  blockedAddress,
  checkUrl,
  isBlockedHostname,
} from '../plugin/url.js';
import { guardedLookup } from './http.js';

/** Call the guarded lookup as a socket would, and promise its outcome. */
function lookupOnce(
  hostname: string,
  answers: Array<{ address: string; family: number }>,
): Promise<{ address: string; family: number }> {
  const lookup = guardedLookup(async () => answers);
  return new Promise((resolve, reject) => {
    (lookup as any)(hostname, {}, (err: unknown, address: string, family: number) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
}

describe('addresses this plugin refuses', () => {
  it('refuses loopback, where the dashboard and the database live', () => {
    expect(blockedAddress('127.0.0.1')).toMatch(/loopback/);
    expect(blockedAddress('127.1.2.3')).toMatch(/loopback/);
    expect(blockedAddress('::1')).toMatch(/loopback/);
  });

  it('refuses every private range', () => {
    expect(blockedAddress('10.0.0.1')).toBeTruthy();
    expect(blockedAddress('172.16.5.4')).toBeTruthy();
    expect(blockedAddress('172.31.255.255')).toBeTruthy();
    expect(blockedAddress('192.168.1.1')).toBeTruthy();
    expect(blockedAddress('fd00::1')).toMatch(/unique-local/);
    expect(blockedAddress('fc00::1')).toMatch(/unique-local/);
  });

  it('refuses link-local, which is where cloud metadata lives', () => {
    expect(blockedAddress('169.254.169.254')).toMatch(/link-local/);
    expect(blockedAddress('169.254.170.2')).toMatch(/link-local/);
    expect(blockedAddress('fe80::1')).toMatch(/link-local/);
  });

  it('refuses the other metadata hiding places', () => {
    // Alibaba's metadata service sits in carrier-grade NAT space.
    expect(blockedAddress('100.100.100.200')).toMatch(/NAT/);
    // AWS's IPv6 metadata endpoint is a unique-local address.
    expect(blockedAddress('fd00:ec2::254')).toMatch(/unique-local/);
  });

  it('refuses the ranges that are not private but are not the internet either', () => {
    expect(blockedAddress('0.0.0.0')).toBeTruthy();
    expect(blockedAddress('224.0.0.1')).toMatch(/multicast/);
    expect(blockedAddress('255.255.255.255')).toBeTruthy();
    expect(blockedAddress('198.18.0.1')).toMatch(/benchmarking/);
    expect(blockedAddress('::')).toBeTruthy();
  });

  it('sees through IPv6 wrappers around a private IPv4 address', () => {
    // Four different spellings of "connect to this machine".
    expect(blockedAddress('::ffff:127.0.0.1')).toMatch(/loopback/);
    expect(blockedAddress('::ffff:7f00:1')).toMatch(/loopback/);
    expect(blockedAddress('64:ff9b::127.0.0.1')).toMatch(/loopback/);
    expect(blockedAddress('2002:7f00:0001::')).toMatch(/loopback/);
    expect(blockedAddress('::ffff:169.254.169.254')).toMatch(/link-local/);
  });

  it('allows an ordinary public address', () => {
    expect(blockedAddress('93.184.216.34')).toBeNull();
    expect(blockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
  });
});

describe('hostnames refused without resolving anything', () => {
  it('refuses the names that mean "here"', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'anything.localhost',
      'printer.local',
      'db.internal',
      'metadata.google.internal',
      'router.home.arpa',
      'nas.lan',
    ]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it('allows ordinary names', () => {
    for (const host of ['example.com', 'www.cars.com', 'api.tavily.com', 'localhost.example.com']) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});

describe('checkUrl', () => {
  const refusal = (url: string): BlockedError => {
    try {
      checkUrl(url);
    } catch (err) {
      return err as BlockedError;
    }
    throw new Error(`expected ${url} to be refused, and it was not`);
  };

  it('refuses every scheme that is not http or https', () => {
    for (const url of [
      'file:///etc/passwd',
      'file://localhost/etc/hosts',
      'ftp://example.com/x',
      'gopher://example.com/',
      'data:text/html,<script>alert(1)</script>',
      'jar:http://example.com!/',
    ]) {
      expect(refusal(url).reason, url).toBe('scheme');
    }
  });

  it('refuses the dashboard and the database by port, before anything else', () => {
    // The two that matter most on this machine. Port first, so this holds even
    // if every address rule below it were deleted.
    expect(refusal('http://127.0.0.1:4317/').reason).toBe('port');
    expect(refusal('http://127.0.0.1:55433/').reason).toBe('port');
    expect(refusal('https://example.com:8080/').reason).toBe('port');
    expect(refusal('http://example.com:22/').reason).toBe('port');
    expect(ALLOWED_PORTS).toEqual([80, 443]);
  });

  it('refuses a private address even on an allowed port', () => {
    expect(refusal('http://127.0.0.1/').reason).toBe('private-address');
    expect(refusal('http://169.254.169.254/latest/meta-data/').reason).toBe('private-address');
    expect(refusal('http://[::1]/').reason).toBe('private-address');
    expect(refusal('https://10.0.0.5/admin').reason).toBe('private-address');
    expect(refusal('http://192.168.1.1/').reason).toBe('private-address');
  });

  it('refuses a URL carrying credentials', () => {
    expect(refusal('https://user:pass@example.com/').reason).toBe('credentials');
  });

  it('refuses a name that means this machine', () => {
    expect(refusal('http://localhost/').reason).toBe('hostname');
    expect(refusal('http://metadata.google.internal/').reason).toBe('hostname');
  });

  it('allows an ordinary page', () => {
    const checked = checkUrl('https://www.cars.com/shopping/ford-bronco/?zip=07030');
    expect(checked.hostname).toBe('www.cars.com');
    expect(checked.literalAddress).toBeNull();
  });
});

describe('guardedLookup — the check that happens after DNS', () => {
  it('lets an ordinary name through, and hands back the address it approved', async () => {
    await expect(lookupOnce('example.com', [{ address: '93.184.216.34', family: 4 }])).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('refuses a public-looking name that resolves to this machine', async () => {
    // The attack a URL-string check cannot see: nothing about
    // `research-notes.example` is suspicious until DNS answers.
    const err = await lookupOnce('research-notes.example', [
      { address: '127.0.0.1', family: 4 },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect((err as BlockedError).reason).toBe('private-address');
    expect((err as BlockedError).message).toContain('127.0.0.1');
  });

  it('refuses a name that resolves to the cloud metadata endpoint', async () => {
    const err = await lookupOnce('cdn.example', [{ address: '169.254.169.254', family: 4 }]).catch(
      (e: unknown) => e,
    );
    expect((err as BlockedError).reason).toBe('private-address');
  });

  it('refuses when ANY answer is private, not just the first', async () => {
    // A name that answers [public, private] is a name trying something. Which
    // address a given Node version picks must not be a security property.
    const err = await lookupOnce('mixed.example', [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]).catch((e: unknown) => e);
    expect((err as BlockedError).reason).toBe('private-address');
  });

  it('refuses a name that resolves to nothing', async () => {
    const err = await lookupOnce('nowhere.example', []).catch((e: unknown) => e);
    expect((err as BlockedError).reason).toBe('unresolvable');
  });

  it('refuses the blocked hostnames before it asks a resolver at all', async () => {
    let asked = false;
    const lookup = guardedLookup(async () => {
      asked = true;
      return [{ address: '93.184.216.34', family: 4 }];
    });
    const err = await new Promise<unknown>((resolve) => {
      (lookup as any)('metadata.google.internal', {}, (e: unknown) => resolve(e));
    });
    expect((err as BlockedError).reason).toBe('hostname');
    expect(asked).toBe(false);
  });

  it('is the policy the shipped manifest uses', () => {
    expect(DEFAULT_POLICY.ports).toEqual([80, 443]);
    expect(DEFAULT_POLICY.blocked('127.0.0.1')).toBeTruthy();
    expect(DEFAULT_POLICY.blockedHostname('localhost')).toBe(true);
  });
});
