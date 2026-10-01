import { describe, expect, it } from 'vitest';
import {
  connectionRoute,
  parseConnectionRoute,
  parsePluginsInstall,
  parsePluginsTab,
  parseSecretRoute,
  secretRoute,
  pluginSettingsRoute,
  parsePluginSettingsRoute,
  pluginRouteParams,
  settingsSectionOf,
  tipsPageOf,
} from './routes';

describe('tipsPageOf', () => {
  it('names the place, and the section for Settings and plugin places, never an id', () => {
    expect(tipsPageOf('')).toBe('home');
    expect(tipsPageOf('#/')).toBe('home');
    expect(tipsPageOf('#/chat/planner/1234')).toBe('chat');
    expect(tipsPageOf('#/chat?group=new')).toBe('chat');
    expect(tipsPageOf('#/settings/notifications')).toBe('settings/notifications');
    expect(tipsPageOf('#/settings/p.email.settings')).toBe('settings/p.email.settings');
    expect(tipsPageOf('#/p/email/mail/abc')).toBe('p/email');
    expect(tipsPageOf('#/agents?tab=missions')).toBe('agents');
    expect(tipsPageOf('#/%zz')).toBeNull();
  });
});

describe('Settings → Plugins links', () => {
  it('reads the spec a market link asks to install', () => {
    expect(parsePluginsInstall('#/settings/plugins?install=%40withbuddi%2Fplugin-weather%400.1.0')).toBe(
      '@withbuddi/plugin-weather@0.1.0',
    );
    expect(parsePluginsInstall('#/settings/plugins?install=@withbuddi/plugin-weather@0.1.0')).toBe(
      '@withbuddi/plugin-weather@0.1.0',
    );
    expect(parsePluginsInstall('#/settings/plugins')).toBeNull();
    expect(parsePluginsInstall('#/settings/plugins?install=')).toBeNull();
    expect(parsePluginsInstall('#/settings/proposals?install=x')).toBeNull();
    expect(settingsSectionOf('#/settings/plugins?install=x')).toBe('plugins');
  });

  it('opens Browse on ?tab=browse, and Installed for an install link', () => {
    expect(parsePluginsTab('#/settings/plugins?tab=browse')).toBe('browse');
    expect(parsePluginsTab('#/settings/plugins')).toBe('installed');
    expect(parsePluginsTab('#/settings/plugins?tab=browse&install=x')).toBe('installed');
  });
});

describe('the recovery checklist links', () => {
  it('round-trips a connection and a secret, and names their sections', () => {
    expect(connectionRoute('c-1')).toBe('#/settings/connections?connection=c-1');
    expect(parseConnectionRoute(connectionRoute('c-1'))).toBe('c-1');
    expect(parseConnectionRoute('#/settings/connections')).toBeNull();
    expect(settingsSectionOf(connectionRoute('c-1'))).toBe('connections');
    expect(secretRoute('EMAIL_YOU_1a2b')).toBe('#/settings/secrets?secret=EMAIL_YOU_1a2b');
    expect(parseSecretRoute(secretRoute('EMAIL_YOU_1a2b'))).toBe('EMAIL_YOU_1a2b');
    expect(parseSecretRoute('#/settings/connections?secret=x')).toBeNull();
    expect(settingsSectionOf(secretRoute('x'))).toBe('secrets');
  });

  it('carries a plugin page\'s parameters, so a mailbox lands with Set password open', () => {
    const route = pluginSettingsRoute('email', 'settings', { account: 'mb-1', set: 'password' });
    expect(route).toBe('#/settings/p.email.settings?account=mb-1&set=password');
    expect(parsePluginSettingsRoute(route)).toEqual({ plugin: 'email', page: 'settings' });
    expect(settingsSectionOf(route)).toBe('p.email.settings');
    expect(pluginRouteParams(route)).toEqual({ account: 'mb-1', set: 'password' });
    expect(pluginRouteParams('#/settings/p.email.settings')).toEqual({});
  });
});
