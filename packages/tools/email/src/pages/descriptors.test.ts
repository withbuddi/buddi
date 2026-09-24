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
      'rule_threads',
      'watcher_settings',
    ]);
  });

  it('says above the send card that nothing has been sent, and no query of mail is sensitive', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const found: Array<{ tool?: string; pending?: string }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const o = node as { tool?: unknown; pending?: string };
        if (o.tool === 'email.send') found.push(o as { tool: string; pending?: string });
        Object.values(node).forEach(walk);
      }
    };
    walk(registry.pages());
    expect(found.length).toBeGreaterThan(0);
    for (const send of found) expect(send.pending).toMatch(/^Nothing has been sent\. /);
    expect(registry.queries().filter((q) => q.sensitive)).toEqual([]);
  });

  it('writes only through tools of its own, and none a model is shown', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const listed = new Set(registry.list().map((t) => t.name));
    const owner = [
      'email.add_account',
      'email.remove_account',
      'email.add_rule',
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

  /**
   * The rule drawer asks for exactly one matcher, whatever the scope.
   *
   * `matcher` is typed and `thread` is picked, and each is shown only for the
   * scopes it belongs to — so for every scope there must be exactly one of
   * them on screen, and it must be the required one. A descriptor that hid
   * both would be a form nobody can submit; one that showed both would be two
   * answers to one question.
   */
  it('shows one matcher per scope, and it is the required one', () => {
    const settings = (manifest.pages ?? []).find((page) => page.id === 'settings')!;
    const section = (settings.body as any[]).find((c) => c.title === 'Policies');
    const form = section.body.find((c: any) => c.kind === 'form' && c.drawer?.title === 'Add a rule');
    const matchers = form.fields.filter((f: any) => f.name === 'matcher' || f.name === 'thread');
    expect(matchers).toHaveLength(2);

    const shows = (field: any, scope: string): boolean => {
      const when = field.when;
      if (!when) return true;
      const value = { scope }[when.path as 'scope'];
      const holds = when.in ? when.in.includes(value) : value === when.equals;
      return when.not ? !holds : holds;
    };
    for (const scope of ['sender', 'domain', 'list-id', 'thread']) {
      const visible = matchers.filter((field: any) => shows(field, scope));
      expect(visible.map((f: any) => f.name), scope).toEqual([scope === 'thread' ? 'thread' : 'matcher']);
      expect(visible[0].required, `${scope}: the one on screen is the required one`).toBe(true);
    }
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
    const section = (mail as { body: any[] }).body.find((c: any) => c.kind === 'section');
    section.actions[0].to.page = 'nowhere';
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
