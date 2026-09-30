import { describe, expect, it } from 'vitest';
import { Fake, MCP_URL } from './testing/fake.js';
import { listAllTools, openSession, Sessions, Unauthorized } from './session.js';

describe('the SDK client over the shared transport', () => {
  for (const json of [true, false]) {
    it(`initializes, lists and calls (${json ? 'JSON' : 'SSE'} answers)`, async () => {
      const fake = new Fake({ json });
      const opened = await openSession({ url: MCP_URL, transport: fake.transport });
      expect(opened.client.getServerVersion()).toMatchObject({ name: 'fake-tracker', version: '1.2.3' });
      const tools = await listAllTools(opened.client);
      expect(tools.map((t) => t.name)).toEqual(['search_issues', 'create_issue', 'delete.repo']);
      const answer = await opened.client.callTool({ name: 'create_issue', arguments: { title: 'Hi' } });
      expect(answer.content).toEqual([{ type: 'text', text: 'created Hi' }]);
      await opened.close();
      // Only POSTs reached the transport: the standing stream never left the process.
      expect(fake.calls.every((c) => c.method === 'POST' || c.method === 'DELETE')).toBe(true);
    });
  }

  it('turns a 401 into Unauthorized with the challenge', async () => {
    const fake = new Fake({ auth: true });
    const error = await openSession({ url: MCP_URL, transport: fake.transport }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).wwwAuthenticate).toMatch(/resource_metadata=/);
  });

  it('keeps one session per connection and closes it when idle', async () => {
    const fake = new Fake({ json: true });
    const sessions = new Sessions(20);
    let opens = 0;
    const open = () => { opens += 1; return openSession({ url: MCP_URL, transport: fake.transport }); };
    const [a, b] = await Promise.all([sessions.get('c1', open), sessions.get('c1', open)]);
    expect(a).toBe(b);
    expect(opens).toBe(1);
    // Idle counts from the end of the last use.
    sessions.release('c1');
    sessions.release('c1');
    await new Promise((r) => setTimeout(r, 60));
    expect(sessions.has('c1')).toBe(false);
    await sessions.get('c1', open);
    expect(opens).toBe(2);
    await sessions.closeAll();
  });
});
