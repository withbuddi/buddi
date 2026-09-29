import { describe, expect, it } from 'vitest';
import { firstMlxhModel, isMlxhImageModel, mlxhBrains, mlxhNotAnswering } from './mlxh';

describe('mlxh in the page', () => {
  it('starts on a loaded language model, passes over image models, and guesses by name before one is loaded', () => {
    const models = [
      { id: 'klein', loaded: false },
      { id: 'bonsai2', loaded: false },
      { id: 'flux-schnell', loaded: false },
      { id: 'gemma4-e2b-it', loaded: true, kind: 'language' as const },
      { id: 'studio', loaded: true, kind: 'image' as const },
    ];
    expect(mlxhBrains({ models })).toEqual(['gemma4-e2b-it', 'bonsai2']);
    expect(firstMlxhModel({ models })).toBe('gemma4-e2b-it');
    expect(firstMlxhModel({ models: [{ id: 'klein', loaded: false }] })).toBeUndefined();
    expect(isMlxhImageModel({ id: 'klein', loaded: true, kind: 'language' })).toBe(false);
  });

  it('says where it looked, from the probe\'s address', () => {
    expect(mlxhNotAnswering('http://127.0.0.1:1060/v1')).toBe('mlxh is not answering on 127.0.0.1:1060. Start it with `mlxh serve`, or `mlxh service install` to keep it running.');
  });
});
