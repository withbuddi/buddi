import { describe, expect, it } from 'vitest';
import { subscriptionSignIns } from './subscription-signins.js';

describe('subscription sign-ins', () => {
  it('are on unless the owner turns them off', () => {
    expect(subscriptionSignIns({})).toEqual({ claude: true, codex: true, oldVars: [] });
    expect(subscriptionSignIns({ BUDDI_SUBSCRIPTION_SIGNINS: 'on' })).toMatchObject({ claude: true, codex: true });
    expect(subscriptionSignIns({ BUDDI_SUBSCRIPTION_SIGNINS: 'no' })).toMatchObject({ claude: true, codex: true });
    expect(subscriptionSignIns({ BUDDI_SUBSCRIPTION_SIGNINS: ' OFF ' })).toMatchObject({ claude: false, codex: false });
  });

  it('lets an old flag set to 0 hide its one sign-in, and names it', () => {
    expect(subscriptionSignIns({ BUDDI_CODEX_EXPERIMENT: '0' })).toEqual({ claude: true, codex: false, oldVars: ['BUDDI_CODEX_EXPERIMENT'] });
    expect(subscriptionSignIns({ BUDDI_ANTHROPIC_OAUTH_EXPERIMENT: '0' })).toMatchObject({ claude: false, codex: true });
    expect(subscriptionSignIns({ BUDDI_ANTHROPIC_OAUTH_EXPERIMENT: '1' })).toEqual({ claude: true, codex: true, oldVars: ['BUDDI_ANTHROPIC_OAUTH_EXPERIMENT'] });
  });
});
