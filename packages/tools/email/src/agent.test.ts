/**
 * The agent the mail plugin proposes: the id the poll hands mail to, the role
 * the watchers ask for, and a grant that stays inside what a model may hold.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core/testing';
import { createEmailManifest, TRIAGE_AGENT_ID } from './index.js';
import { mailAgents, TRIAGE_OFFER_QUERY, TRIAGE_OFFER_TEXT } from './agent.js';

describe('the proposed mail agent', () => {
  const manifest = createEmailManifest();
  const proposal = manifest.agents?.find((a) => a.id === TRIAGE_AGENT_ID);

  it('is proposed under the id the poll hands every new message to', () => {
    expect(manifest.agents).toEqual(mailAgents);
    expect(proposal).toMatchObject({ id: 'mail-triage', handle: 'mail', name: 'Mail', language: 'mirror' });
    // `email.waiting-on-me` asks for `mail`, `email.receipt-or-bill` falls back to it.
    expect(proposal?.roles).toEqual(['mail']);
  });

  it('asks for tools this plugin has, named one by one, and never an ownerOnly one', () => {
    const tools = proposal?.tools ?? [];
    expect(tools.every((name) => !name.includes('*'))).toBe(true);
    const ours = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    for (const name of tools.filter((t) => t.startsWith('email.'))) {
      expect(ours.has(name), name).toBe(true);
      expect(ours.get(name)?.ownerOnly, name).not.toBe(true);
    }
    // Every model-facing email tool but the owner's own settings.
    const modelFacing = manifest.tools.filter((t) => !t.ownerOnly).map((t) => t.name);
    expect(modelFacing.filter((name) => !tools.includes(name))).toEqual(['email.set_settings']);
    expect(tools).toEqual(expect.arrayContaining(['memory.note', 'memory.recall', 'reminder.set', 'canvas.show']));
    expect(tools.some((name) => name.startsWith('platform.'))).toBe(false);
  });

  it('says in its persona that it drafts, never sends on its own, and says what is waiting', () => {
    const persona = proposal?.persona ?? '';
    expect(persona).toContain('email.triage_record');
    expect(persona).toContain('email.draft_reply');
    expect(persona).toMatch(/never send on your own/i);
    expect(persona).toContain('mission.silent');
    expect(persona).toMatch(/what is waiting/i);
  });

  it('is offered on Home once there is a mailbox, and on the settings page in place', () => {
    expect(proposal?.offer).toEqual({ text: TRIAGE_OFFER_TEXT, query: TRIAGE_OFFER_QUERY });
    expect((manifest.queries ?? []).some((q) => q.name === TRIAGE_OFFER_QUERY)).toBe(true);
    const settings = (manifest.pages ?? []).find((p) => p.id === 'settings');
    expect(settings?.data).toEqual({ query: 'accounts' });
    expect(JSON.stringify(settings?.body)).toContain('"kind":"agent-offer","agent":"mail-triage"');
    // And the registry accepts the page: an offer names an agent this plugin proposes.
    expect(() => new ToolRegistry().register(manifest)).not.toThrow();
  });

  it('refuses a page that offers an agent the plugin does not propose', () => {
    const broken = { ...manifest, name: 'email', agents: [] };
    expect(() => new ToolRegistry().register(broken)).toThrow(/offers mail-triage, which this plugin does not propose/);
  });
});
