/**
 * The one face component: the uploaded picture when there is one, else the
 * icon (an image the folder ships, or an emoji), else initials — and a picture
 * that fails to load gives way to the icon instead of a broken image.
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { Avatar } from './Avatar';

afterEach(cleanup);

it('draws the uploaded picture before the icon', () => {
  const { container } = render(<Avatar id="scout" name="Scout" face={{ picture: '/api/agents/scout/avatar?v=1', avatar: { kind: 'emoji', value: '🦊' } }} />);
  const face = container.querySelector('.ui-avatar')!;
  expect(face).toHaveAttribute('data-kind', 'image');
  expect(face.querySelector('img')).toHaveAttribute('src', '/api/agents/scout/avatar?v=1');
  expect(face).not.toHaveTextContent('🦊');
});

it('falls back to the icon when there is no picture', () => {
  const { container } = render(<Avatar id="scout" name="Scout" face={{ avatar: { kind: 'emoji', value: '🦊' } }} />);
  const face = container.querySelector('.ui-avatar')!;
  expect(face).toHaveAttribute('data-kind', 'emoji');
  expect(face).toHaveTextContent('🦊');
  expect(face.querySelector('img')).toBeNull();
});

it('falls back to the icon when the picture fails to load', () => {
  const { container } = render(<Avatar id="scout" name="Scout" face={{ picture: '/api/agents/scout/avatar?v=1', avatar: { kind: 'emoji', value: '🦊' } }} />);
  fireEvent.error(container.querySelector('img')!);
  const face = container.querySelector('.ui-avatar')!;
  expect(face).toHaveAttribute('data-kind', 'emoji');
  expect(face).toHaveTextContent('🦊');
});

it('draws initials when there is neither', () => {
  const { container } = render(<Avatar id="scout" name="Field Scout" />);
  expect(container.querySelector('.ui-avatar')).toHaveTextContent('FS');
});
