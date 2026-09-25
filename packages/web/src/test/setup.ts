/**
 * jsdom is missing a few things Radix expects from a real browser. Stubbing
 * them here keeps the component tests honest about *our* code rather than
 * about the environment's gaps.
 */
import { vi } from 'vitest';
import { configure } from '@testing-library/react';

// `findBy*` and `waitFor` give up after one second by default, which a loaded
// CI runner exceeds on a re-render that a laptop does in a tenth of that. Ten
// seconds changes nothing a test asserts, only how long it is allowed to wait.
configure({ asyncUtilTimeout: 10_000 });

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (!('DOMRect' in globalThis)) {
  globalThis.DOMRect = class {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    top = 0;
    left = 0;
    right = 0;
    bottom = 0;
    toJSON(): unknown {
      return {};
    }
    static fromRect(): DOMRect {
      return new globalThis.DOMRect() as DOMRect;
    }
  } as unknown as typeof DOMRect;
}

// jsdom's document here has an opaque origin, so it ships no `localStorage`.
// The real browser always has one, and the theme toggle is tested against its
// behaviour rather than against its absence.
if (!('localStorage' in window) || !window.localStorage) {
  const store = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', { value: memory, configurable: true });
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

Element.prototype.hasPointerCapture ??= (): boolean => false;
Element.prototype.setPointerCapture ??= (): void => {};
Element.prototype.releasePointerCapture ??= (): void => {};
Element.prototype.scrollIntoView ??= (): void => {};

vi.stubGlobal('scrollTo', () => {});
