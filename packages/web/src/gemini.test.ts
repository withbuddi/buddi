import { describe, expect, it } from 'vitest';
import { isGeminiAccount, pickGeminiModel } from './gemini';

describe('the Gemini model a new account starts on', () => {
  it('is the newest Pro, bare, stable over preview at the same version, never an image model', () => {
    expect(pickGeminiModel(['models/gemini-2.5-pro', 'models/gemini-3-pro-image', 'models/gemini-3.1-pro-preview'])).toBe('gemini-3.1-pro-preview');
    expect(pickGeminiModel(['gemini-3.1-pro-preview', 'gemini-3.1-pro', 'gemini-2.5-pro'])).toBe('gemini-3.1-pro');
    expect(pickGeminiModel(['gemini-10-pro', 'gemini-9.9-pro'])).toBe('gemini-10-pro');
  });

  it('falls back to the first gemini- model, and to nothing without one', () => {
    expect(pickGeminiModel(['embedding-001', 'models/gemini-3.8-flash', 'gemini-2.5-flash'])).toBe('gemini-3.8-flash');
    expect(pickGeminiModel(['embedding-001'])).toBeUndefined();
  });

  it('knows an account by its address, whatever the trailing slash', () => {
    expect(isGeminiAccount({ kind: 'openai-compatible', baseUrl: 'g/openai' }, 'g/openai/')).toBe(true);
    expect(isGeminiAccount({ kind: 'openai', baseUrl: 'g/openai' }, 'g/openai/')).toBe(false);
    expect(isGeminiAccount({ kind: 'openai-compatible', baseUrl: 'g/openai' }, undefined)).toBe(false);
  });
});
