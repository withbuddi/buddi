import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createCodexRpc } from './codex-rpc.js';

function harness(timeoutMs = 100) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(), exitCode: 0, signalCode: null,
  });
  const outbound: string[] = [];
  child.stdin.on('data', (chunk) => outbound.push(String(chunk)));
  const rpc = createCodexRpc(child as unknown as ChildProcessWithoutNullStreams, timeoutMs);
  const receive = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  return { child, rpc, outbound, receive };
}

describe('Codex stdio transport', () => {
  it('correlates out-of-order responses without a jsonrpc field', async () => {
    const { rpc, receive, outbound } = harness();
    const a = rpc.request('a'); const b = rpc.request('b', { test: true });
    receive({ id: 2, result: 'second' }); receive({ id: 1, result: 'first' });
    expect(await a).toBe('first'); expect(await b).toBe('second');
    expect(JSON.parse(outbound[0]!)).toEqual({ id: 1, method: 'a' });
    rpc.close();
  });

  it('preserves UTF-8 split across stream chunks', () => {
    const { rpc, child } = harness();
    const listener = vi.fn(); rpc.onMessage(listener);
    const bytes = Buffer.from('{"method":"text","params":"é"}\n');
    const offset = bytes.indexOf(Buffer.from('é')) + 1;
    child.stdout.write(bytes.subarray(0, offset)); child.stdout.write(bytes.subarray(offset));
    expect(listener).toHaveBeenCalledWith({ method: 'text', params: 'é' });
    rpc.close();
  });

  it('never answers dynamic tools; the adapter can return them as proposals', () => {
    const { rpc, receive, outbound } = harness();
    const listener = vi.fn(); rpc.onMessage(listener);
    receive({ id: 'call', method: 'item/tool/call', params: { tool: 'buddi_clock' } });
    expect(listener).toHaveBeenCalledOnce(); expect(outbound).toEqual([]);
    rpc.close();
  });

  it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'unknown/method'])(
    'rejects native server request %s without granting permission', async (method) => {
      const { rpc, receive, outbound, child } = harness();
      const waiting = rpc.request('turn/start');
      receive({ id: 'server1', method, params: {} });
      await expect(waiting).rejects.toThrow('unsupported native capability');
      expect(JSON.parse(outbound[1]!)).toMatchObject({ id: 'server1', error: { code: -32601 } });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    },
  );

  it('redacts errors and stderr and rejects pending requests on exit', async () => {
    const { rpc, receive, child } = harness();
    const first = rpc.request('account/read');
    receive({ id: 1, error: { message: 'SECRET_TOKEN' } });
    await expect(first).rejects.toThrow('Codex App Server rejected the request.');
    child.stderr.write('PRIVATE_AUTH_VALUE');
    const second = rpc.request('turn/start');
    child.emit('exit', 1);
    await expect(second).rejects.toThrow('Codex App Server exited.');
    await expect(rpc.request('again')).rejects.toThrow('exited');
  });

  it('bounds request waits, invalid frames and oversized frames', async () => {
    for (const mode of ['timeout', 'invalid', 'oversized']) {
      const { rpc, child } = harness(5);
      const waiting = rpc.request('test');
      if (mode === 'invalid') child.stdout.write('not JSON\n');
      if (mode === 'oversized') child.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
      await expect(waiting).rejects.toThrow();
      expect(child.kill).toHaveBeenCalled();
    }
  });
});
