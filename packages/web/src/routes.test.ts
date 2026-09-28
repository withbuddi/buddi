import { describe, expect, it } from 'vitest';
import { tipsPageOf } from './routes';

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
