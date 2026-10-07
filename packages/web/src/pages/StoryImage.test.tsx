import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { StoryImage } from './StoryImage';
afterEach(cleanup);
it('renders only a local image with publisher caption, credit and article link', () => {
  render(<StoryImage plugin="demo" image={{ key: 'story-a_test', outlet: 'Publisher', url: 'https://example.com/article', caption: 'A crowd', credit: 'Photographer' }} />);
  expect(screen.getByRole('img')).toHaveAttribute('src', '/api/plugin-assets/demo/story-a_test?size=768');
  expect(screen.getByRole('img')).toHaveAttribute('alt', 'A crowd');
  expect(screen.getByText(/Photographer · Publisher/)).toBeVisible();
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/article');
});
it('keeps missing and broken images out of the layout', () => {
  const view = render(<StoryImage plugin="demo" />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<StoryImage plugin="demo" image={{ key: 'https://remote.test/image', outlet: 'Publisher', url: '' }} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<StoryImage plugin="demo" image={{ key: 'story-test', outlet: 'Publisher', url: '' }} />);
  fireEvent.error(screen.getByRole('img'));
  expect(view.container).toBeEmptyDOMElement();
});
