import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Structured } from './views/Structured';
import { commandResult } from './command-result';
import { inspectToolCall, renderablesFrom } from './renderables';
import type { ChatMessage } from '../chat/types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const result = { state: 'completed', exitCode: 0, signal: null, stdout: 'total 2\n-rw-r--r--  report.csv\n  indented\tvalue\n', stderr: '', workspace: '/fixture/workspace', artifacts: [], outputErrors: [], note: 'Do not retry uncertain effects.' };
const wrapped = { input: { command: 'ls -la ./inputs' }, status: 'completed', output: result };

it('shows exact command and output immediately, hiding technical details and empty error fields', () => {
  render(<Structured props={{ value: wrapped }} />);
  expect(screen.getByLabelText('Command').textContent).toBe(wrapped.input.command);
  const output = screen.getByLabelText('Output');
  expect(output.tagName).toBe('PRE');
  expect(output.textContent).toBe(result.stdout);
  expect(output.closest('details')).toBeNull();
  expect(output).toHaveClass('wb-command-text');
  expect(screen.getByText('Exit code 0')).toBeVisible();
  expect(screen.queryByText('Standard error')).toBeNull();
  expect(screen.getByText('Execution details').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }));
  expect(screen.getByText(/"workspace":/)).toBeVisible();
});

it('copies exact text and reports clipboard rejection without throwing', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<Structured props={{ value: wrapped }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
  await screen.findByText('Copied');
  expect(writeText).toHaveBeenLastCalledWith(result.stdout);
  writeText.mockRejectedValueOnce(new Error('denied'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
  await screen.findByText('Copy failed; select the text to copy.');
  expect(writeText).toHaveBeenLastCalledWith(wrapped.input.command);
});

it('reports unavailable clipboard support', () => {
  vi.stubGlobal('navigator', {});
  render(<Structured props={{ value: wrapped }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
  expect(screen.getByText('Copy unavailable; select the text to copy.')).toBeVisible();
});

it('marks nonzero exit codes as failed and keeps stderr and export errors visible', () => {
  render(<Structured props={{ value: { ...result, exitCode: 2, stdout: '', stderr: '<script>bad()</script>\nfailed\n', outputErrors: ['Could not export report.csv'] } }} />);
  expect(screen.getByText('Failed')).toBeVisible();
  expect(screen.getByText('Exit code 2')).toBeVisible();
  expect(screen.getByText('No standard output.')).toBeVisible();
  expect(screen.getByLabelText('Standard error').textContent).toBe('<script>bad()</script>\nfailed\n');
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('Could not export report.csv')).toBeVisible();
});

it.each(['output-limit', 'timed-out', 'cancelled'])('shows interrupted execution state %s', state => {
  render(<Structured props={{ value: { ...result, state, exitCode: null, signal: 'SIGTERM' } }} />);
  expect(screen.getByText(state)).toBeVisible();
  expect(screen.queryByText('Exit code 0')).toBeNull();
  expect(screen.getByLabelText('Output')).toBeVisible();
});

it('previews nested artifacts using local IDs only and leaves downloads available on preview failure', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  render(<Structured props={{ value: { ...wrapped, output: { ...result, artifacts: [{ id, filename: 'result.png', mime: 'image/png', downloadUrl: '//untrusted.invalid/secret' }] } } }} />);
  const img = screen.getByAltText('result.png');
  expect(img).toHaveAttribute('src', `/api/artifacts/${id}/preview`);
  expect(screen.getByRole('link', { name: 'Download result.png' })).toHaveAttribute('href', `/api/artifacts/${id}/download`);
  fireEvent.error(img);
  await waitFor(() => expect(screen.getByText(/Preview unavailable/)).toBeVisible());
  expect(screen.getByRole('link', { name: 'Download result.png' })).toBeVisible();
});

it('recognizes execution shapes for both automatic panels and clicked chips without affecting unrelated records', () => {
  const messages: ChatMessage[] = [
    { id: 'a', at: '2026-09-19T02:00:00Z', role: 'assistant', blocks: [{ type: 'tool_use', id: 'call', name: 'fixture.execute', input: wrapped.input }] },
    { id: 'b', at: '2026-09-19T02:00:01Z', role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'call', name: 'fixture.execute', ok: true, output: result }] },
  ];
  const panels = renderablesFrom({ messages, descriptors: [] });
  expect(panels).toHaveLength(1);
  expect(panels[0]!.props).toMatchObject({ value: { input: wrapped.input, output: result } });
  const inspection = inspectToolCall(messages, 'call');
  expect(inspection?.props).toMatchObject({ value: wrapped });
  expect(commandResult({ state: 'completed', message: 'saved' })).toBeNull();
  expect(commandResult({ ...result, stdout: null })).toBeNull();
});
