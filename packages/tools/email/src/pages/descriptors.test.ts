/**
 * The two descriptors, checked where they enter.
 *
 * A page descriptor is data that crosses into a browser which cannot check it,
 * so the check is at `register()` — and these are the mistakes that would
 * otherwise be a blank panel nobody can explain: a query renamed on one side
 * only, a tool that moved, a link to a page that is not there. Each one must
 * be a startup error naming the plugin, the page and the field.
 *
 * It also holds the two promises that are this plugin's, not the engine's:
 * every screen the owner has is contributed rather than compiled in, and none
 * of the tools those screens write through is a tool a model can see.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core';
import { createEmailManifest } from '../index.js';

/** A deep copy, so a test may break one without breaking the next. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('the mail pages, as contributions', () => {
  const manifest = createEmailManifest();

  it('registers, with a rail place and a settings tab', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest)).not.toThrow();
    expect(registry.pages().map((p) => [p.plugin, p.id, p.place])).toEqual([
      ['email', 'mail', 'rail'],
      ['email', 'settings', 'settings'],
    ]);
    expect(registry.queries().map((q) => q.name)).toEqual([
      'threads',
      'thread',
      'draft',
      'message',
      'accounts',
      'policies',
      'watcher_settings',
    ]);
  });

  it('writes only through tools of its own, and none a model is shown', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const listed = new Set(registry.list().map((t) => t.name));
    const owner = [
      'email.add_account',
      'email.remove_account',
      'email.add_rule',
      'email.keep_policies',
      'email.revoke_policies',
      'email.save_draft',
      'email.discard_draft',
    ];
    for (const name of owner) {
      expect(registry.pluginOf(name), `${name} is contributed`).toBe('email');
      expect(listed.has(name), `${name} must not be listed to a model`).toBe(false);
    }
    // Send stays the gated tool an agent uses; the page proposes exactly what
    // an agent would, and the owner approves it on the same card.
    expect(listed.has('email.send')).toBe(true);
    expect(listed.has('email.fetch_attachment')).toBe(true);
  });

  /**
   * Which page writes a model can also make, said out loud.
   *
   * Everything the port added is `ownerOnly`, and the two reused tools are
   * agent tools by design. `email.set_settings` is the one that is neither: a
   * legitimate agent tool ("keep bodies for 30 days", "wait a week before you
   * nudge") that the Watchers form also submits to. It was owner-only before
   * only because it was reached through a route, which is not a property of
   * the tool. This test is the statement that the exception is deliberate —
   * if a page ever writes through a *second* listed tool, it fails.
   */
  it('makes exactly one page write through a tool a model may also call', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const listed = new Set(registry.list().map((t) => t.name));
    const written = registry
      .pageTools('email')
      .filter((name) => listed.has(name))
      .sort();
    expect(written).toEqual(['email.fetch_attachment', 'email.send', 'email.set_settings']);
  });

  it('refuses a page whose query was renamed on one side only', () => {
    const broken = copy(manifest.pages ?? []);
    const mail = broken.find((p) => p.id === 'mail');
    (mail as { body: Array<{ query?: { query: string } }> }).body[1]!.query!.query = 'thredz';
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...manifest, pages: broken })).toThrow(
      /plugin email: page mail, body\[1\]\.query\.query: no query called thredz/,
    );
  });

  it('refuses a page that writes through a tool this plugin does not contribute', () => {
    const broken = copy(manifest.pages ?? []);
    const settings = broken.find((p) => p.id === 'settings');
    const section = (settings as { body: any[] }).body.find((c: any) => c.title === 'Mailboxes');
    section.body[0].actions[0].tool = 'platform.delete_everything';
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...manifest, pages: broken })).toThrow(
      /names platform\.delete_everything, which this plugin does not contribute/,
    );
  });

  it('refuses a link to a page that is not one of its own', () => {
    const broken = copy(manifest.pages ?? []);
    const mail = broken.find((p) => p.id === 'mail');
    const link = (mail as { body: any[] }).body.find((c: any) => c.kind === 'link');
    link.to.page = 'nowhere';
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...manifest, pages: broken })).toThrow(
      /links to nowhere, which is not a page of this plugin/,
    );
  });

  it('refuses a field the component set has no such thing as', () => {
    const broken = copy(manifest.pages ?? []);
    const mail = broken.find((p) => p.id === 'mail');
    (mail as { body: any[] }).body[0].loudness = 11;
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...manifest, pages: broken })).toThrow(
      /invalid page descriptor mail — body\.0/,
    );
  });
});
