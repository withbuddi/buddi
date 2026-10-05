import { describe, expect, it } from 'vitest';
import { LiveTurns, type LiveFrame } from './live.js';

describe('live turns', () => {
  it('settles a turn its transcript now carries, and retracts one the guard withdrew', () => {
    const live = new LiveTurns(() => 0);
    const frames: LiveFrame[] = [];
    live.subscribe('c1', (frame) => frames.push(frame));

    live.append('c1', 'r1', { kind: 'text', text: 'CBS News reported…' });
    live.retract('c1', 'r1');
    expect(frames.at(-1)).toEqual({ event: 'live.settle', data: { runId: 'r1', turn: 1, retracted: true } });
    expect(live.snapshot('c1')).toBeNull();

    live.append('c1', 'r1', { kind: 'text', text: 'Checked: 6-3.' });
    live.settle('c1', 'r1');
    expect(frames.at(-1)).toEqual({ event: 'live.settle', data: { runId: 'r1', turn: 2 } });
  });
});
