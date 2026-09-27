import { describe, expect, it } from 'vitest';
import { languageTag } from './language-tag.js';

describe('languageTag', () => {
  it('reads a language name, in English or its own words', () => {
    expect(languageTag('French')).toBe('fr');
    expect(languageTag(' français ')).toBe('fr');
    expect(languageTag('Español')).toBe('es');
    expect(languageTag('日本語')).toBe('ja');
    expect(languageTag('Bahasa  Indonesia')).toBe('id');
  });

  it('keeps a tag, written the usual way', () => {
    expect(languageTag('fr')).toBe('fr');
    expect(languageTag('pt_br')).toBe('pt-BR');
    expect(languageTag('zh-hant-TW')).toBe('zh-Hant-TW');
    expect(languageTag('es-419')).toBe('es-419');
  });

  it('answers nothing for what is not a language', () => {
    expect(languageTag(null)).toBeUndefined();
    expect(languageTag('')).toBeUndefined();
    expect(languageTag('Klingon')).toBeUndefined();
    expect(languageTag('whatever I write in')).toBeUndefined();
  });
});
