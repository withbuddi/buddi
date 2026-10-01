/**
 * The footer status line, and the dot it folds into on a phone.
 *
 * One thin line under every page, each item a link to where it is decided:
 * how this page reaches buddi (local, the tailnet, or reconnecting), the focus
 * that is on and until when, the work (agents running, the queue running or
 * paused, failed jobs), the approvals waiting, the version with a dot when a
 * newer one is ready, and the time in the owner's zone — naming the zone when
 * this device's is a different one.
 *
 * The time is the only thing that changes by itself, and it changes on the
 * minute: the line re-renders once a minute, the shell around it never does.
 *
 * On a phone the line has no room; it folds into one dot on the rail, the
 * worst of what it says, which opens the same items.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Fragment, useEffect, useState } from 'react';
import { linkDownSince, onLinkChange, type FocusState } from '../api';
import { ACTIVITY_ROUTE, NEEDS_ROUTE, settingsRoute } from '../routes';
import { Icon } from '../ui';
import { FOCUS_LABELS, focusUntilLabel } from './Rail';
import { LOOPBACK } from './Unreachable';
import { useLock } from './lock';
import { fmtClock } from '../format';

export type LinkKind = 'local' | 'tailnet' | 'reconnecting';

/** What the line reads, gathered by the shell from what it already polls. */
export interface ShellStatus {
  link: LinkKind;
  focus: FocusState | null;
  /** Agent runs in progress. */
  working: number;
  paused: boolean;
  failed: number;
  approvals: number;
  /** The running version, and whether a newer one is ready; absent until read. */
  version?: { current: string; latest?: string | undefined; updateAvailable: boolean } | undefined;
  /** The owner's zone. */
  timezone: string;
}

interface Part { key: string; text: string; tone?: 'warning' | 'critical'; dot?: 'working' }

export interface StatusItem {
  key: 'link' | 'focus' | 'work' | 'approvals' | 'version' | 'time';
  route: string;
  /** The accessible name: everything the item says, in words. */
  label: string;
  /** The right-hand group: version and time. */
  end?: boolean;
  dot?: 'good' | 'warning';
  icon?: 'moon';
  count?: number;
  text?: string;
  parts?: Part[];
  mono?: string;
  update?: boolean;
  time?: string;
  zone?: string;
}

const LINK_WORDS: Record<LinkKind, string> = { local: 'Local', tailnet: 'Tailnet', reconnecting: 'Reconnecting…' };

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** This device's own zone. */
export function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Europe/Paris" reads "Paris"; "America/Argentina/Buenos_Aires" reads "Buenos Aires". */
export function zoneName(zone: string): string {
  return zone.includes('/') ? zone.split('/').pop()!.replace(/_/g, ' ') : zone;
}

/** Local on the Mac's own address, the tailnet anywhere else. */
export function linkKind(hostname: string, down: boolean): LinkKind {
  if (down) return 'reconnecting';
  return LOOPBACK.test(hostname) ? 'local' : 'tailnet';
}

/** The items, once, for the footer and the phone's menu alike. */
export function statusItems(s: ShellStatus, now: Date, device: string = deviceZone()): StatusItem[] {
  const items: StatusItem[] = [];
  const linkWords = LINK_WORDS[s.link];
  items.push({ key: 'link', route: settingsRoute('system'), dot: s.link === 'reconnecting' ? 'warning' : 'good', text: linkWords, label: `Connection: ${linkWords}` });
  if (s.focus) {
    const words = `${FOCUS_LABELS[s.focus.mode]} ${focusUntilLabel(s.focus, s.timezone, now)}`;
    items.push({ key: 'focus', route: settingsRoute('notifications'), icon: 'moon', text: words, label: `Focus: ${words}` });
  }
  const parts: Part[] = [];
  if (s.working > 0) parts.push({ key: 'working', dot: 'working', text: `${s.working} ${plural(s.working, 'agent')} working` });
  parts.push(s.paused ? { key: 'queue', tone: 'warning', text: 'Queue paused' } : { key: 'queue', text: 'Queue running' });
  if (s.failed > 0) parts.push({ key: 'failed', tone: 'critical', text: `${s.failed} failed` });
  items.push({
    key: 'work',
    route: s.failed > 0 ? `${ACTIVITY_ROUTE}/jobs?state=failed` : `${ACTIVITY_ROUTE}/jobs`,
    parts,
    label: `Work: ${parts.map((p) => p.text).join(', ')}`,
  });
  if (s.approvals > 0) {
    const words = `${plural(s.approvals, 'approval')} waiting`;
    items.push({ key: 'approvals', route: NEEDS_ROUTE, count: s.approvals, text: words, label: `${s.approvals} ${words}` });
  }
  if (s.version) {
    const update = s.version.updateAvailable && s.version.latest ? s.version.latest : null;
    items.push({
      key: 'version',
      route: settingsRoute('system'),
      end: true,
      mono: `buddi ${s.version.current}`,
      update: update !== null,
      label: `buddi ${s.version.current}${update ? `, a newer buddi is ready: ${update}` : ''}`,
    });
  }
  // The owner's zone; this device's until the session has said it.
  const zone = s.timezone || device;
  const time = fmtClock(now, zone);
  const differs = zone !== device;
  items.push({
    key: 'time',
    route: settingsRoute('you'),
    end: true,
    time,
    ...(differs ? { zone: zoneName(zone) } : {}),
    label: `Your time: ${time}${differs ? `, ${zone}` : ''}`,
  });
  return items;
}

/** The worst of what the line says, for the phone's one dot. */
export function statusTone(s: ShellStatus): 'good' | 'warning' | 'critical' | 'attention' {
  if (s.link === 'reconnecting' || s.failed > 0) return 'critical';
  if (s.paused) return 'warning';
  if (s.approvals > 0 || (s.version?.updateAvailable ?? false)) return 'attention';
  return 'good';
}

/** The minute, re-read on the minute. */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => { setNow(new Date()); arm(); }, 60_000 - (Date.now() % 60_000));
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** True while the page's requests go unanswered: the line says Reconnecting… */
export function useLinkDown(): boolean {
  const [down, setDown] = useState(() => linkDownSince() !== null);
  useEffect(() => onLinkChange(() => setDown(linkDownSince() !== null)), []);
  return down;
}

function StatusContent({ item }: { item: StatusItem }): JSX.Element {
  return (
    <>
      {item.dot ? <span className="shell-status-dot" data-tone={item.dot} aria-hidden="true" /> : null}
      {item.icon ? <Icon name={item.icon} size={12} /> : null}
      {item.count ? <span className="ui-badge" aria-hidden="true">{item.count > 99 ? '99+' : item.count}</span> : null}
      {item.parts?.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 ? <span className="shell-status-sep" aria-hidden="true">·</span> : null}
          {p.dot ? <span className="shell-status-dot" data-tone={p.dot} aria-hidden="true" /> : null}
          <span data-tone={p.tone}>{p.text}</span>
        </Fragment>
      ))}
      {item.text ? <span>{item.text}</span> : null}
      {item.mono ? <span className="shell-status-mono">{item.mono}</span> : null}
      {item.update ? <span className="ui-badge" data-kind="dot" data-testid="status-update-dot" aria-hidden="true" /> : null}
      {item.time ? <span className="shell-status-time">{item.time}</span> : null}
      {item.zone ? <span className="shell-status-zone">{item.zone}</span> : null}
    </>
  );
}

export function StatusBar({ status, onNavigate }: { status: ShellStatus; onNavigate: (route: string) => void }): JSX.Element {
  const now = useMinute();
  const lock = useLock();
  const items = statusItems(status, now);
  const link = (item: StatusItem): JSX.Element => (
    <a
      key={item.key}
      className="shell-status-item"
      data-item={item.key}
      href={item.route}
      aria-label={item.label}
      title={item.label}
      onClick={(e) => { e.preventDefault(); onNavigate(item.route); }}
    >
      <StatusContent item={item} />
    </a>
  );
  return (
    <footer className="shell-status" aria-label="Status">
      {items.filter((i) => !i.end).map(link)}
      <span className="shell-status-spacer" />
      {items.filter((i) => i.end).map(link)}
      {/* Lock now, last: only while a PIN is set. */}
      {lock.pin ? (
        <button type="button" className="shell-status-item shell-status-lock" data-item="lock" aria-label={`Lock now (${lock.shortcut})`} title={`Lock now (${lock.shortcut})`} onClick={() => lock.lockNow()}>
          <Icon name="lock" size={13} />
        </button>
      ) : null}
    </footer>
  );
}

/** The phone's fold: one dot on the rail, the same items behind it. */
export function RailStatus({ status, onNavigate }: { status: ShellStatus; onNavigate: (route: string) => void }): JSX.Element {
  const now = useMinute();
  const lock = useLock();
  const tone = statusTone(status);
  return (
    <div className="rail-status">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="rail-status-btn" aria-label="Status">
            <span className="rail-status-dot" data-tone={tone} data-testid="rail-status-dot" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="ui-menu rail-status-menu" side="right" align="end" sideOffset={10}>
            <DropdownMenu.Label className="ui-menu-label">Status</DropdownMenu.Label>
            {statusItems(status, now).map((item) => (
              <DropdownMenu.Item key={item.key} asChild onSelect={() => onNavigate(item.route)}>
                <a className="ui-menu-item rail-status-item" data-item={item.key} href={item.route} aria-label={item.label}>
                  <span className="rail-status-line"><StatusContent item={item} /></span>
                </a>
              </DropdownMenu.Item>
            ))}
            {/* The footer's padlock, last and apart: only while a PIN is set. */}
            {lock.pin ? (
              <>
                <DropdownMenu.Separator className="ui-menu-sep" />
                <DropdownMenu.Item className="ui-menu-item rail-status-item" data-item="lock" onSelect={() => lock.lockNow()}>
                  <span className="rail-status-line"><Icon name="lock" size={12} /><span>Lock now</span></span>
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
