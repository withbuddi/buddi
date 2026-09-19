export interface ProviderDiagnostic {
  state: string;
  message: string;
  httpStatus: number | null;
  retryAt: string | null;
}

/** Never expose provider error bodies: they may echo credentials or conversation data. */
export function providerDiagnostic(error: unknown): ProviderDiagnostic {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : null;
  const retryAt = typeof value.retryAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.retryAt) && Number.isFinite(Date.parse(value.retryAt)) ? value.retryAt : null;
  let state = 'unavailable', message = 'Connection failed. Check the account, model, vault and network.';
  if (status === 401) { state = 'authentication-error'; message = 'The provider rejected this credential. Check or replace it; subscription accounts may need to reconnect.'; }
  else if (status === 403) { state = 'access-denied'; message = 'The provider denied access. Check account permissions and model availability.'; }
  else if (status === 429 && value.type === 'insufficient_quota') {
    state = 'quota-exhausted'; message = 'The provider reports insufficient quota. Check this account’s credits or spending limit; this is not evidence of a subscription renewal date.';
  } else if (status === 429) {
    state = 'rate-limited'; message = 'The provider returned a rate or usage limit. This response alone does not establish whether a subscription allowance is exhausted.';
  } else if (status === 404) { state = 'not-found'; message = 'The provider could not find the requested model or endpoint. Check both account settings.'; }
  else if (status !== null && status >= 500) { state = 'provider-unavailable'; message = 'The provider reported a server error. Try again later.'; }
  return { state, message, httpStatus: status, retryAt };
}
