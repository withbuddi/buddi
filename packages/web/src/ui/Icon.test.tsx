import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES, Icon } from './Icon';

describe('Icon', () => {
  it('draws every glyph as a hidden, current-colour line drawing on its own grid', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.getAttribute('fill')).toBe('none');
      expect(svg!.getAttribute('stroke')).toBe('currentColor');
      expect(svg!.getAttribute('stroke-linecap')).toBe('round');
      expect(svg!.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
      expect(svg!.querySelectorAll('path, circle, rect').length, name).toBeGreaterThan(0);
      unmount();
    }
  });

  it('keeps each glyph exactly as it was drawn inline', () => {
    const { container } = render(
      <>
        <Icon name="home" />
        <Icon name="send" />
        <Icon name="out" />
        <Icon name="chevron-down" />
        <Icon name="frame" />
      </>,
    );
    const [home, send, out, down, frame] = [...container.querySelectorAll('svg')];
    expect(home!.getAttribute('width')).toBe('20');
    expect(home!.getAttribute('stroke-width')).toBe('1.6');
    expect([...home!.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([
      'M3.5 9.2 10 3.6l6.5 5.6',
      'M5.2 8.4v7.4a1 1 0 0 0 1 1h2.6v-4.6h2.4v4.6h2.6a1 1 0 0 0 1-1V8.4',
    ]);
    expect(send!.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(send!.getAttribute('stroke-width')).toBe('1.8');
    // Drawn on a 12px grid and shown at 11, as the roster always did.
    expect(out!.getAttribute('viewBox')).toBe('0 0 12 12');
    expect(out!.getAttribute('width')).toBe('11');
    expect(down!.getAttribute('width')).toBe('12');
    expect(down!.getAttribute('viewBox')).toBe('0 0 14 14');
    expect(frame!.getAttribute('stroke-width')).toBe('1.3');
  });

  it('takes a size and a class, and the gear keeps its grid while drawn at the rail size', () => {
    const { container } = render(
      <>
        <Icon name="chevron" className="wb-tool-chevron" />
        <Icon name="mail" size={16} />
        <Icon name="settings" />
      </>,
    );
    const [chevron, mail, settings] = [...container.querySelectorAll('svg')];
    expect(chevron!.getAttribute('class')).toBe('wb-tool-chevron');
    expect(mail!.getAttribute('width')).toBe('16');
    expect(mail!.getAttribute('viewBox')).toBe('0 0 20 20');
    expect(settings!.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(settings!.getAttribute('width')).toBe('20');
    expect(settings!.querySelectorAll('circle')).toHaveLength(1);
  });

  it('has a mark for every canvas renderer', () => {
    for (const renderer of ['timeseries', 'table', 'bars', 'keyvalue', 'document', 'diff', 'terminal', 'image', 'preview', 'envelope', 'structured']) {
      expect(ICON_NAMES).toContain(`shape-${renderer}`);
    }
  });
});

it('leaves no inline icon in the rail, the composer, the thread, the roster or the canvas', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of ['shell/Rail.tsx', 'chat/Composer.tsx', 'chat/MessageList.tsx', 'shell/AgentRail.tsx', 'canvas/Canvas.tsx']) {
    expect(readFileSync(path.join(src, file), 'utf8'), file).not.toMatch(/<svg\b/);
  }
});
