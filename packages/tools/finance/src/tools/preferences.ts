import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { loadPreferences } from './shared.js';

const setInput = z
  .object({
    currency: z
      .string()
      .min(1)
      .max(8)
      .optional()
      .describe("ISO currency code used to report money, e.g. 'EUR' or 'USD'."),
    safetyFloor: z
      .number()
      .optional()
      .describe(
        'Balance the owner never wants to go below. Cashflow projections report a breach when the projected balance falls under it.',
      ),
  })
  .refine((v) => v.currency !== undefined || v.safetyFloor !== undefined, {
    message: 'provide at least one of currency, safetyFloor',
  });

export const setPreferences: ToolDefinition<z.infer<typeof setInput>, unknown> = {
  name: 'finance.set_preferences',
  description:
    "Set the owner's finance preferences: the reporting currency and the safety floor (the balance to stay above). Returns the full preference set after the update.",
  tier: 'auto',
  input: setInput,
  async execute(input, ctx) {
    if (input.currency !== undefined) {
      await ctx.db.query(
        `insert into finance.preferences (key, value) values ('currency', $1::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [JSON.stringify(input.currency)],
      );
    }
    if (input.safetyFloor !== undefined) {
      await ctx.db.query(
        `insert into finance.preferences (key, value) values ('safety_floor', $1::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [JSON.stringify(input.safetyFloor)],
      );
    }
    return loadPreferences(ctx.db);
  },
};

const getInput = z.object({});

export const getPreferences: ToolDefinition<z.infer<typeof getInput>, unknown> = {
  name: 'finance.get_preferences',
  description:
    "Read the owner's finance preferences: reporting currency (default EUR) and safety floor (default 0).",
  tier: 'auto',
  input: getInput,
  async execute(_input, ctx) {
    return loadPreferences(ctx.db);
  },
};
