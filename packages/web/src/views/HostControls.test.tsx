import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { HostControls } from './HostControls';
import { Envelope } from '../canvas/views/Envelope';
import { Structured } from '../canvas/views/Structured';
vi.mock('../api', async (load) => ({ ...await load<typeof import('../api')>(), api: { host: vi.fn(), stopHost: vi.fn(), revokeHost: vi.fn(), approval: vi.fn(), decide: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.host).mockResolvedValue({ permissions: [], runs: [] }); });
describe('host permission controls', () => {
  it('never enables auto-mode just by opening a conversation', async () => {
    render(<HostControls agentId="ledger" conversationId="c1" />);
    await screen.findByText(/Ask each time/);
    expect(api.host).toHaveBeenCalledWith('ledger', 'c1');
    expect(api.decide).not.toHaveBeenCalled();
  });
  it('shows scope and running output, and provides scoped stop and revoke', async () => {
    vi.mocked(api.host).mockResolvedValue({ permissions: [{ id: 'p1', agentId: 'ledger', conversationId: 'c1', toolVersion: '0.1.0' }],
      runs: [{ actionId: 'a1', agentId: 'ledger', conversationId: 'c1', command: 'python3 report.py', cwd: '/workspace', stdout: '42', stderr: '' }] });
    vi.mocked(api.stopHost).mockResolvedValue({ stopped: 1 }); vi.mocked(api.revokeHost).mockResolvedValue({ revoked: true });
    render(<HostControls agentId="ledger" conversationId="c1" />);
    fireEvent.click(await screen.findByText(/Host execution · Conversation/));
    expect(await screen.findByText('python3 report.py')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop command' }));
    await waitFor(() => expect(api.stopHost).toHaveBeenCalledWith('ledger', 'c1'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke permission' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke permission' }));
    await waitFor(() => expect(api.revokeHost).toHaveBeenCalledWith('p1'));
  });
  it.each(['conversation', 'always'] as const)('sends the owner-selected %s scope with the exact action', async (scope) => {
    const action = { id: 'a1', tool: 'host.exec', permissionScopes: ['conversation', 'always'], state: 'pending', envelope: { command: 'printf 42' }, canonicalArgs: {}, preview: 'NOT sandboxed', agentId: 'ledger' } as never;
    vi.mocked(api.approval).mockResolvedValue(action);
    vi.mocked(api.decide).mockResolvedValue({ action: { ...action as object, state: 'succeeded' } as never, execution: { state: 'succeeded' } });
    render(<Envelope props={{ approvalId: 'a1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: scope === 'always' ? 'Always: this agent' : 'Auto: this conversation' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('a1', 'approve', scope));
  });
  it('downloads only local artifact IDs, not arbitrary tool-provided URLs', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    render(<Structured props={{ value: { artifacts: [{ id, filename: 'summary.csv', downloadUrl: ['https:', '', 'evil.example'].join('/') }] } }} />);
    expect(screen.getByRole('link', { name: 'summary.csv' })).toHaveAttribute('href', `/api/artifacts/${id}/download`);
  });
  it('previews raster artifacts first with a download button and collapsible tool details', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    render(<Structured props={{ value: { stdout: 'created', artifacts: [{ id, filename: 'quote.png', mime: 'image/png' }] } }} />);
    expect(screen.getByRole('img', { name: 'quote.png' })).toHaveAttribute('src', `/api/artifacts/${id}/preview`);
    expect(screen.getByRole('link', { name: 'Download quote.png' })).toHaveAttribute('href', `/api/artifacts/${id}/download`);
    expect(screen.getByText('Tool details').closest('details')).not.toHaveAttribute('open');
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText(/Preview unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download quote.png' })).toBeInTheDocument();
  });
  it('does not inline SVG or malformed artifact IDs', () => {
    render(<Structured props={{ value: { artifacts: [
      { id: '11111111-1111-1111-1111-111111111111', filename: 'vector.svg', mime: 'image/svg+xml' },
      { id: '../untrusted', filename: 'image.png', mime: 'image/png' },
    ] } }} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
