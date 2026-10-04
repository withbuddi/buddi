/** Settings → System's command line row: only in buddi.app, and it says where buddi went. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api, ApiError } from '../../api';
import { CommandLineTool } from './CommandLineTool';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return { ...original, api: { ...original.api, cliTool: vi.fn(), installCliTool: vi.fn() } };
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('CommandLineTool', () => {
  it('is absent outside buddi.app', async () => {
    vi.mocked(api.cliTool).mockResolvedValue({ available: false, installed: [], reason: 'npm' });
    const { container } = render(<CommandLineTool />);
    await vi.waitFor(() => expect(api.cliTool).toHaveBeenCalled());
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('installs, and says where buddi went', async () => {
    vi.mocked(api.cliTool).mockResolvedValueOnce({ available: true, installed: [] }).mockResolvedValue({ available: true, installed: ['/usr/local/bin/buddi'] });
    vi.mocked(api.installCliTool).mockResolvedValue({ file: '/usr/local/bin/buddi', lines: ['buddi is at /usr/local/bin/buddi. Open a new terminal and run buddi status.'] });
    render(<CommandLineTool />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install Command Line Tool' }));
    expect(await screen.findByText(/Open a new terminal/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Install Again' })).toBeInTheDocument();
  });

  it("says why when npm's buddi is in the way", async () => {
    vi.mocked(api.cliTool).mockResolvedValue({ available: true, installed: [] });
    vi.mocked(api.installCliTool).mockRejectedValue(new ApiError(409, "buddi is already installed from npm at /opt/homebrew/bin/buddi; remove it first for the app's copy: npm rm -g @withbuddi/buddi"));
    render(<CommandLineTool />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install Command Line Tool' }));
    expect(await screen.findByText(/already installed from npm at \/opt\/homebrew\/bin\/buddi/)).toBeInTheDocument();
  });
});
