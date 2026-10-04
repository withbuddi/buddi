import { describe, expect, it } from 'vitest';
import {
  connectionRoute,
  legacyRedirect,
  parseConnectionRoute,
  parsePairingCode,
  parsePluginsInstall,
  parsePluginsTab,
  parseSecretRoute,
  parseSecretsAdd,
  SECRETS_ADD_ROUTE,
  secretRoute,
  pluginSettingsRoute,
  parsePluginSettingsRoute,
  pluginRouteParams,
  resolvePluginSettingsRoute,
  settingsSectionOf,
  tipsPageOf,
} from './routes';

describe('buddi.app links to Browser & apps', () => {
  it('lands #/settings/browser on the page, query and all, and reads only a six-digit code', () => {
    expect(legacyRedirect('#/settings/browser')).toBe('#/settings/computer');
    expect(legacyRedirect('#/settings/browser?code=482913')).toBe('#/settings/computer?code=482913');
    expect(legacyRedirect('#/settings/browserx')).toBeNull();
    expect(parsePairingCode('#/settings/computer?code=482913')).toBe('482913');
    expect(parsePairingCode('#/settings/browser?code=482%20913')).toBe('482913');
    expect(parsePairingCode('#/settings/computer?code=48291')).toBeNull();
    expect(parsePairingCode('#/settings/computer?code=abcdef')).toBeNull();
    expect(parsePairingCode('#/settings/secrets?code=482913')).toBeNull();
  });
});

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
    // The header's Add a secret opens the add form by its address.
    expect(parseSecretsAdd(SECRETS_ADD_ROUTE)).toBe(true);
    expect(parseSecretsAdd('#/settings/secrets')).toBe(false);
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

  it('sends a plugin settings hash without a tab to the plugin\'s first tab, so every such route resolves', () => {
    const pages = [{ plugin: 'news', id: 'sources' }, { plugin: 'news', id: 'digest' }, { plugin: 'email', id: 'email' }];
    expect(pluginSettingsRoute('news')).toBe('#/settings/p.news');
    expect(resolvePluginSettingsRoute(pluginSettingsRoute('news'), pages)).toBe('#/settings/p.news.sources');
    expect(resolvePluginSettingsRoute('#/settings/p.news?feed=1', pages)).toBe('#/settings/p.news.sources?feed=1');
    expect(resolvePluginSettingsRoute('#/settings/p.news.gone', pages)).toBe('#/settings/p.news.sources');
    // A tab that exists, a plugin whose page carries its own name, a plugin with no settings, a core section: left alone.
    expect(resolvePluginSettingsRoute('#/settings/p.news.digest', pages)).toBeNull();
    expect(resolvePluginSettingsRoute(pluginSettingsRoute('email'), pages)).toBeNull();
    expect(resolvePluginSettingsRoute('#/settings/p.ghost', pages)).toBeNull();
    expect(resolvePluginSettingsRoute('#/settings/you', pages)).toBeNull();
  });
});
