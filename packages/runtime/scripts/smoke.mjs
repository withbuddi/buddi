#!/usr/bin/env node
/**
 * Live smoke check for the Anthropic adapter (subscription-token kind).
 *
 * buddi keeps Anthropic credentials in named model accounts, not in `.env`, so
 * the token is passed for this one run only, in BUDDI_SMOKE_TOKEN. Resolves the
 * provider explicitly (no ambient credentials) and asks for a single word.
 * Prints the text and the usage. The token itself is never printed.
 *
 *   BUDDI_SMOKE_TOKEN=sk-ant-oat01-… node packages/runtime/scripts/smoke.mjs
 */
import { resolveProvider } from '@buddi/core';
import { createAnthropicProvider } from '../dist/index.js';

const resolution = resolveProvider(
  {
    kind: 'anthropic',
    credential: { kind: 'subscription-token', env: 'BUDDI_SMOKE_TOKEN' },
    model: 'claude-sonnet-5',
  },
  process.env,
);

if (!resolution.ok) {
  console.error(`provider problem [${resolution.problem.code}]: ${resolution.problem.message}`);
  process.exit(1);
}

const provider = createAnthropicProvider(resolution.provider, { maxTokens: 64 });

try {
  const res = await provider.complete({
    system: 'You are a terse assistant.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word ok.' }] }],
    tools: [],
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  console.log(`status: 200`);
  console.log(`model: ${res.model}`);
  console.log(`stop_reason: ${res.stopReason}`);
  console.log(`usage: in=${res.usage.input} out=${res.usage.output}`);
  console.log(`text: ${text}`);
} catch (err) {
  console.error(
    `smoke failed: status=${err?.status ?? '?'} type=${err?.type ?? '?'} requestId=${
      err?.requestId ?? '-'
    } message=${err?.message ?? String(err)}`,
  );
  process.exit(1);
}
