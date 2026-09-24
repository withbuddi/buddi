/**
 * The view descriptor is data that ends up in a browser, so the only place it
 * can be checked is here. These tests are the worked example a plugin author
 * copies: validate against the shared schema, and prove the paths actually hit
 * the shape your own tool returns.
 */
import { parseViewDescriptors, ToolRegistry } from '@buddi/core/testing';
import { describe, expect, it } from 'vitest';
import { createWeatherManifest } from './index.js';
import type { ForecastOutput } from './tools/forecast.js';
import { weatherViews } from './views.js';

const manifest = createWeatherManifest(async () => []);

describe('the forecast view descriptor', () => {
  it('validates, and names a tool this plugin actually contributes', () => {
    const parsed = parseViewDescriptors(weatherViews, {
      plugin: manifest.name,
      tools: manifest.tools.map((tool) => tool.name),
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.renderer).toBe('timeseries');
  });

  it('is carried by the manifest, as the fifth contribution', () => {
    expect(manifest.views).toBe(weatherViews);
  });

  it('points at fields the tool really returns', () => {
    // Typed against the tool's own output, so a rename breaks the build here
    // rather than emptying a panel in the dashboard six weeks later.
    const output: ForecastOutput = {
      place: 'Reykjavík',
      days: [{ date: '2026-09-14', lowC: -3, highC: 1, summary: 'Snow' }],
    };
    const map = weatherViews[0]!.map as { points: string; x: string; y: string };
    const points = output[map.points as 'days'];
    expect(Array.isArray(points)).toBe(true);
    expect(points[0]).toHaveProperty(map.x);
    expect(points[0]).toHaveProperty(map.y);
  });

  it('refuses a descriptor for a tool this plugin does not ship', () => {
    expect(() =>
      parseViewDescriptors([{ ...weatherViews[0]!, tool: 'weather.hindcast' }], {
        plugin: manifest.name,
        tools: manifest.tools.map((tool) => tool.name),
      }),
    ).toThrow(/does not contribute/);
  });
});

/**
 * The other thing a plugin contributes that leaves this process: the tool's
 * input schema, which goes to a model provider. Both Anthropic and OpenAI
 * require it to be an object, so the registry refuses anything else at
 * registration — and a worked example should be the thing that passes.
 */
describe('the tools this example contributes', () => {
  it('register, and declare object input schemas', () => {
    const registry = new ToolRegistry();
    registry.register(manifest);
    const specs = registry.list();
    expect(specs.map((s) => s.name)).toEqual(manifest.tools.map((t) => t.name));
    for (const spec of specs) {
      expect(spec.inputSchema, spec.name).toMatchObject({ type: 'object' });
    }
  });
});
