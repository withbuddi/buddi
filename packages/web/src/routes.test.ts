import { describe, expect, it } from 'vitest';
import { parsePluginsInstall, parsePluginsTab, settingsSectionOf, tipsPageOf } from './routes';

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
