/**
 * Wait for the mocked API to answer, inside `act`.
 *
 * `findBy*` resolves at the commit that shows an element, and React runs that
 * commit's effects later, on its scheduler. On a loaded runner the test can
 * act in between: a form whose effect syncs its fields from the loaded data
 * then overwrites what the test typed (You's Time select read '' after being
 * set to 12h). Awaiting the answers inside `act` instead flushes the renders
 * and the effects they cause before the test goes on.
 *
 * Pass the mocks a view calls on mount; every call made so far is awaited,
 * rejections included (an error banner is also a render).
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

export async function answered(...mocks: Array<(...args: never[]) => unknown>): Promise<void> {
  await act(async () => {
    await Promise.allSettled(mocks.flatMap((mock) => vi.mocked(mock).mock.results.map((result) => result.value)));
  });
}
