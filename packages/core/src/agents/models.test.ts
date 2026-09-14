/**
 * The model catalogue: grouping, the default, and what "usable" means on a
 * machine that has one credential and not the other.
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_MODELS, modelCatalogue } from './models.js';
import { modelBelongsTo, PROVIDER_KINDS } from '../provider.js';

describe('the suggested models', () => {
  it('only ever suggest names their own provider would accept', () => {
    for (const kind of PROVIDER_KINDS) {
      for (const model of KNOWN_MODELS[kind]) {
        expect(modelBelongsTo(kind, model.id)).toBe(true);
        // And never a name the *other* provider would claim.
        for (const other of PROVIDER_KINDS) {
          if (other !== kind) expect(modelBelongsTo(other, model.id)).toBe(false);
        }
      }
    }
  });
});

describe('modelCatalogue', () => {
  it('groups by provider and marks only the credentialed one usable', () => {
    const groups = modelCatalogue({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(groups.map((g) => g.kind)).toEqual([...PROVIDER_KINDS]);

    const anthropic = groups.find((g) => g.kind === 'anthropic');
    expect(anthropic?.usable).toBe(true);
    expect(anthropic?.credentialEnv).toBe('ANTHROPIC_API_KEY');

    const openai = groups.find((g) => g.kind === 'openai');
    expect(openai?.usable).toBe(false);
    expect(openai?.problem?.message).toContain('OPENAI_API_KEY');
  });

  it('reports the default model and where it came from', () => {
    const builtIn = modelCatalogue({})[0];
    expect(builtIn?.defaultModel).toBe('claude-sonnet-5');
    expect(builtIn?.defaultFrom).toBe('built-in default');

    const pinned = modelCatalogue({ BUDDI_MODEL: 'claude-opus-5' })[0];
    expect(pinned?.defaultModel).toBe('claude-opus-5');
    expect(pinned?.defaultFrom).toBe('BUDDI_MODEL');
  });

  it('prefers a subscription token when the owner has one', () => {
    const groups = modelCatalogue({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-test' });
    const anthropic = groups.find((g) => g.kind === 'anthropic');
    expect(anthropic?.credentialKind).toBe('subscription-token');
    expect(anthropic?.usable).toBe(true);
  });

  it('can be asked about one provider alone', () => {
    const groups = modelCatalogue({}, 'openai');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('openai');
    expect(groups[0]?.defaultModel).toBe('gpt-5');
  });
});
