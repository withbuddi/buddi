import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from './api';
import { ModelPicker } from './ModelPicker';
vi.mock('./api', () => ({ api: { accountModels: vi.fn() } }));
const list = { models: [{ id: 'terra', name: 'Terra', isDefault: false }, { id: 'astra', name: 'Astra', isDefault: true }], truncated: false };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.accountModels).mockResolvedValue(list); });
function Harness() { const [value, set] = useState('old-model'); return <ModelPicker accountId="one" label="Model" value={value} onChange={set} />; }
it('preserves unlisted selections on load and refresh, and permits explicit custom entry', async () => {
  render(<Harness />);
  await screen.findByRole('option', { name: /Astra/ });
  expect(screen.getByLabelText('Model')).toHaveValue('old-model');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  await waitFor(() => expect(api.accountModels).toHaveBeenCalledWith('one', true));
  expect(screen.getByLabelText('Model')).toHaveValue('old-model');
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'terra' } });
  expect(screen.getByLabelText('Model')).toHaveValue('terra');
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__buddi_custom__' } });
  fireEvent.change(screen.getByLabelText('Custom model'), { target: { value: 'custom/model' } });
  expect(screen.getByLabelText('Custom model')).toHaveValue('custom/model');
});
it('keeps custom entry available after a failed list request', async () => {
  vi.mocked(api.accountModels).mockRejectedValue(new Error('Provider listing is unavailable.'));
  render(<Harness />);
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
  expect(screen.getByLabelText('Model')).toHaveValue('old-model');
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__buddi_custom__' } });
  expect(screen.getByLabelText('Custom model')).toBeEnabled();
});
it('ignores a late response from a previously selected account', async () => {
  let finish!: (value: typeof list) => void;
  vi.mocked(api.accountModels).mockImplementation(id => id === 'one' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ models: [{ id: 'two-only', name: 'Two', isDefault: false }], truncated: false }));
  const change = vi.fn();
  const view = render(<ModelPicker accountId="one" label="Model" value="kept" onChange={change} />);
  view.rerender(<ModelPicker accountId="two" label="Model" value="kept" onChange={change} />);
  await screen.findByRole('option', { name: /Two/ });
  finish(list);
  await waitFor(() => expect(screen.queryByRole('option', { name: /Astra/ })).not.toBeInTheDocument());
  expect(change).not.toHaveBeenCalled();
});
