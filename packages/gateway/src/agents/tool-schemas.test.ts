/**
 * Every tool this build ships must hand a provider an *object* schema.
 *
 * This is the test that would have caught the bug it was written for: the
 * canvas plugin declared `canvas.show` as a `z.discriminatedUnion`, which
 * renders as a bare `anyOf` with no top-level `type`, and Anthropic refused
 * every single request from the one agent that holds the canvas tools with
 * `tools.8.custom.input_schema.type: Field required`. Nothing was wrong with
 * the tool, the agent, or the conversation — only with the schema handed over
 * the wire, and nothing checked that.
 *
 * So it checks the whole registered surface rather than the one tool, and it
 * fails the day someone adds another bare union.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core';
import { createToolRegistry } from './catalog.js';
import { createMissionManifest } from '../missions/report.js';

/** The base surface: every plugin `createToolRegistry` installs. */
const base = createToolRegistry();

/**
 * Plus the mission tools, which are registered into a per-run copy of the base
 * registry (`missions/execute.ts`) and so never appear in `base.list()`.
 */
function missionRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const manifest of base.manifests()) registry.register(manifest);
  registry.register(createMissionManifest({ decision: undefined }));
  return registry;
}

describe('the schemas this build sends to a provider', () => {
  it('installs a non-trivial surface, so an empty pass means nothing', () => {
    expect(base.list().length).toBeGreaterThan(20);
    expect(base.list().map((t) => t.name)).toContain('canvas.show');
  });

  it.each(base.list().map((spec) => [spec.name, spec] as const))(
    '%s declares an object input schema with no union at the top level',
    (_name, spec) => {
      expect(spec.inputSchema).toMatchObject({ type: 'object' });
      // The API refuses a top-level union even when the type is stated:
      // "input_schema does not support oneOf, allOf, or anyOf at the top level".
      expect(spec.inputSchema.anyOf).toBeUndefined();
      expect(spec.inputSchema.oneOf).toBeUndefined();
      expect(spec.inputSchema.allOf).toBeUndefined();
    },
  );

  it('covers the mission tools too, which only exist inside a mission run', () => {
    const specs = missionRegistry().list();
    expect(specs.some((s) => s.name.startsWith('mission.'))).toBe(true);
    for (const spec of specs) {
      expect(spec.inputSchema, spec.name).toMatchObject({ type: 'object' });
      expect(spec.inputSchema.anyOf, spec.name).toBeUndefined();
    }
  });

  it('keeps every renderer of the one tool that is a union of variants', () => {
    // `canvas.show` is discriminated on the renderer — a legitimate shape that
    // renders as a bare union. Flattened, it must still offer every renderer
    // and every variant of the data that goes with them.
    const schema = base.list().find((s) => s.name === 'canvas.show')!.inputSchema as {
      type: string;
      required: string[];
      properties: { renderer: { enum: string[] }; data: { anyOf: unknown[] }; title: unknown };
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.renderer.enum).toEqual([
      'timeseries',
      'table',
      'bars',
      'keyvalue',
      'document',
      'structured',
    ]);
    // Alternatives are legal below the top level, so the data shapes survive.
    expect(schema.properties.data.anyOf).toHaveLength(6);
    expect(schema.properties.title).toBeDefined();
    // `title` is optional in every branch, so it must not become required.
    expect(schema.required).toEqual(['renderer', 'data']);
  });
});
