/**
 * The approval view.
 *
 * One rule, asserted directly: **what is approved is what is shown.** Every
 * field of the envelope reaches the page, including one this build has never
 * seen before — because a field that is silently dropped is a field somebody
 * approved without reading.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Envelope, envelopeFields } from './views/Envelope';
import { CSRF_COOKIE_PREFIX, type ApprovalRow } from '../api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const action: ApprovalRow = {
  id: 'act-99',
  tool: 'shed.order',
  toolVersion: '1.2.0',
  agentId: 'gardener',
  conversationId: 'conv-1',
  jobId: null,
  preview: 'Order 2 rakes from the usual supplier, delivered Thursday.',
  envelope: {
    supplier: 'Harrow & Sons',
    quantity: 2,
    totalPence: 4599,
    deliverOn: '2026-09-18',
    // A field this build has never heard of. It must still be shown.
    unfamiliarField: 'do not drop me',
  },
  canonicalArgs: { sku: 'RAKE-2' },
  argsHash: 'sha256:abc123',
  policyVersion: 4,
  state: 'pending',
  decidedBy: null,
  decidedVia: null,
  decidedAt: null,
  expiresAt: '2026-09-15T09:00:00Z',
  createdAt: '2026-09-14T09:00:00Z',
  outcome: null,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe('the approval view', () => {
  it('shows every envelope field, the preview, and the identity of the decision', async () => {
    stubFetch(() => new Response(JSON.stringify({ action }), { status: 200 }));
    await act(async () => {
      render(<Envelope props={{ approvalId: 'act-99' }} timezone="UTC" />);
    });
    await waitFor(() => expect(screen.getByText(/Order 2 rakes/)).toBeDefined());

    // Every key of the envelope, by its label and by its value.
    for (const [label, value] of [
      ['Supplier', 'Harrow & Sons'],
      ['Quantity', '2'],
      ['Total pence', '4,599'],
      ['Deliver on', '2026-09-18'],
      ['Unfamiliar field', 'do not drop me'],
    ]) {
      expect(screen.getByText(label!)).toBeDefined();
      expect(screen.getByText(value!)).toBeDefined();
    }

    // And what makes this a specific action rather than a description of one.
    expect(screen.getByText('sha256:abc123')).toBeDefined();
    expect(screen.getByText('act-99')).toBeDefined();
    expect(screen.getByText('1.2.0')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
    expect(screen.getByText('Argument · Sku')).toBeDefined();
  });

  it('approves through the existing route, with the CSRF header', async () => {
    // The cookie is named after this page's port; another dashboard on the
    // same host leaves its own beside it, which must not be the one sent.
    const port = Number(location.port) || (location.protocol === 'https:' ? 443 : 80);
    document.cookie = `${CSRF_COOKIE_PREFIX}_${port}=token-xyz`;
    document.cookie = `${CSRF_COOKIE_PREFIX}_${port + 1}=someone-elses`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubFetch((url, init) => {
      calls.push({ url, init });
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ action: { ...action, state: 'approved', decidedBy: 'owner' }, execution: null }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ action }), { status: 200 });
    });

    const decided = vi.fn();
    await act(async () => {
      render(<Envelope props={{ approvalId: 'act-99' }} timezone="UTC" onDecided={decided} />);
    });
    await waitFor(() => expect(screen.getByText('Approve')).toBeDefined());

    await act(async () => {
      screen.getByText('Approve').click();
    });

    const post = calls.find((call) => call.init?.method === 'POST');
    expect(post?.url).toBe('/api/approvals/act-99/approve');
    expect((post?.init?.headers as Record<string, string>)['x-buddi-csrf']).toBe('token-xyz');
    await waitFor(() => expect(decided).toHaveBeenCalled());
    // Once decided, the buttons are gone: there is nothing left to decide.
    await waitFor(() => expect(screen.queryByText('Approve')).toBeNull());
  });

  it('rejects through the reject route', async () => {
    const calls: string[] = [];
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        calls.push(url);
        return new Response(JSON.stringify({ action: { ...action, state: 'rejected' }, execution: null }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ action }), { status: 200 });
    });
    await act(async () => {
      render(<Envelope props={{ approvalId: 'act-99' }} timezone="UTC" />);
    });
    await waitFor(() => expect(screen.getByText('Reject')).toBeDefined());
    await act(async () => {
      screen.getByText('Reject').click();
    });
    expect(calls).toEqual(['/api/approvals/act-99/reject']);
  });

  it('flattens without dropping, whatever the envelope holds', () => {
    const fields = envelopeFields({
      ...action,
      envelope: { list: ['a', 'b'], nested: { deep: 1 }, missing: null },
    });
    const byLabel = Object.fromEntries(fields.map((field) => [field.label, field.value]));
    expect(byLabel['List']).toBe('a, b');
    expect(byLabel['Nested']).toBe('{"deep":1}');
    expect(byLabel['Missing']).toBe('—');
  });
});

describe('when there is no such action', () => {
  it('says so, and asks for nothing else', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(JSON.stringify({ error: 'no such action' }), { status: 404 });
    });
    await act(async () => {
      render(<Envelope props={{ approvalId: 'act-99' }} timezone="UTC" />);
    });
    await waitFor(() => expect(screen.getByText('no such action')).toBeDefined());
    // One route, asked once. There is no list to fall back to: the single-action
    // route is served, and a 404 from it means the action does not exist.
    expect(urls).toEqual(['/api/approvals/act-99']);
  });
});
