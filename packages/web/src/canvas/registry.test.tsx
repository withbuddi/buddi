/**
 * The registry, and the rule it exists to enforce: the web package knows
 * *shapes*, and a plugin's descriptor is the only thing that connects a tool
 * to one. Every fixture here is a made-up plugin. None of them is a plugin
 * this repository ships, which is the point.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RenderView, RENDERERS, isKnownRenderer, rendererFor } from './registry';
import { renderablesFrom, labelFor, CANVAS_SHOW, CANVAS_CLEAR, MAX_RENDERABLES } from './renderables';
import { applyDescriptor, readPath } from './resolve';
import type { ViewDescriptor } from './types';
import type { ChatMessage } from '../chat/types';

afterEach(cleanup);

/*
 * Two entirely fictional plugins. Nothing in this repository ships an
 * `orchard` or a `shed` tool — which is the point: these tests must pass on an
 * installation with no plugins at all.
 */
const forecast: ViewDescriptor = {
  tool: 'orchard.forecast',
  renderer: 'timeseries',
  title: 'Forecast',
  map: {
    points: 'days',
    x: 'date',
    y: 'highC',
    referenceLines: [{ value: { const: 0 }, label: 'Freezing', tone: 'critical' }],
    mark: 'min',
  },
};

const inventory: ViewDescriptor = {
  tool: 'shed.inventory',
  renderer: 'table',
  title: 'Inventory',
  map: {
    rows: 'items',
    columns: [
      { key: 'name', label: 'Item' },
      { key: 'count', label: 'Count', type: 'number' },
    ],
  },
};

/** Three figures: a reading is a thing the canvas lays out, not a sentence. */
/* A reading with enough separate values to be worth laying out: the rule
 * about what earns a tab is about quantity of readable value, and a panel
 * of three pairs is a sentence. */
const reading = {
  celsius: 11,
  humidity: 62,
  windKph: 18,
  gustKph: 31,
  pressureHpa: 1004,
  rainMm: 2.4,
  cloudPercent: 80,
  readAt: '2026-09-14',
};

const forecastOutput = {
  place: 'Reykjavík',
  days: [
    { date: '2026-09-14', highC: 7, summary: 'Rain' },
    { date: '2026-09-15', highC: -2, summary: 'Snow' },
    { date: '2026-09-16', highC: 3, summary: 'Cloud' },
  ],
};

function toolPair(id: string, name: string, output: unknown, ok = true): ChatMessage[] {
  return [
    { id: `m-${id}-a`, role: 'assistant', at: '2026-09-14T09:00:00Z', blocks: [{ type: 'tool_use', id, name, input: {} }] },
    {
      id: `m-${id}-b`,
      role: 'user',
      at: '2026-09-14T09:00:01Z',
      blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output }],
    },
  ];
}

describe('the renderer registry', () => {
  it('holds one renderer per shape and nothing per domain', () => {
    expect(Object.keys(RENDERERS).sort()).toEqual([
      'bars',
      'diff',
      'document',
      'envelope',
      'image',
      'keyvalue',
      'preview',
      'structured',
      'table',
      'terminal',
      'timeseries',
    ]);
  });

  it('picks the renderer a descriptor names', () => {
    expect(rendererFor('timeseries')).toBe(RENDERERS.timeseries);
    expect(rendererFor('table')).toBe(RENDERERS.table);
    expect(rendererFor('envelope')).toBe(RENDERERS.envelope);
  });

  it('falls back to structured for a name this build does not know', () => {
    // A descriptor from a plugin newer than the dashboard must still show its
    // data, not an empty panel.
    expect(isKnownRenderer('sankey')).toBe(false);
    expect(rendererFor('sankey')).toBe(RENDERERS.structured);

    render(<RenderView renderer="sankey" props={{ mystery: 'value' }} />);
    expect(screen.getByText(/Mystery/)).toBeDefined();
  });

  it('reads paths, indexes and misses without throwing', () => {
    expect(readPath({ a: { b: [{ c: 3 }] } }, 'a.b[0].c')).toBe(3);
    expect(readPath({ a: 1 }, '$')).toEqual({ a: 1 });
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
  });
});

describe('descriptors decide what a tool looks like', () => {
  it('maps a tool output onto the renderer the plugin declared', () => {
    const { renderer, props } = applyDescriptor(forecast, forecastOutput);
    expect(renderer).toBe('timeseries');
    expect(props).toMatchObject({
      points: [
        { x: '2026-09-14', y: 7 },
        { x: '2026-09-15', y: -2 },
        { x: '2026-09-16', y: 3 },
      ],
      referenceLines: [{ value: 0, label: 'Freezing', tone: 'critical' }],
      mark: 'min',
    });
  });

  it('gives a tool with no descriptor the structured view, not a dump', () => {
    const renderables = renderablesFrom({
      messages: toolPair('t1', 'shed.temperature', reading),
      descriptors: [forecast],
    });
    expect(renderables).toHaveLength(1);
    expect(renderables[0]).toMatchObject({ renderer: 'structured', source: 'fallback', tool: 'shed.temperature' });
  });

  it('uses the descriptor when one is installed for that tool', () => {
    const renderables = renderablesFrom({
      messages: toolPair('t2', 'shed.inventory', { items: [{ name: 'Rake', count: 2 }] }),
      descriptors: [forecast, inventory],
    });
    expect(renderables[0]).toMatchObject({ renderer: 'table', title: 'Inventory', source: 'descriptor' });
  });

  it('shows a failed call as its error rather than as a chart', () => {
    const renderables = renderablesFrom({
      messages: toolPair('t3', 'orchard.forecast', { message: 'no location set' }, false),
      descriptors: [forecast],
    });
    expect(renderables[0]).toMatchObject({ renderer: 'structured', tone: 'critical' });
  });
});

describe('precedence', () => {
  it('lets an explicit canvas.show win over anything inferred', () => {
    const messages: ChatMessage[] = [
      ...toolPair('t4', 'orchard.forecast', forecastOutput),
      {
        id: 'm-show',
        role: 'assistant',
        at: '2026-09-14T09:00:02Z',
        blocks: [
          {
            type: 'tool_use',
            id: 'show-1',
            name: CANVAS_SHOW,
            input: { renderer: 'keyvalue', title: 'The point', data: { pairs: [{ label: 'Coldest', value: -2 }] } },
          },
        ],
      },
    ];
    const renderables = renderablesFrom({ messages, descriptors: [forecast] });
    const shown = renderables.find((item) => item.source === 'canvas');
    expect(shown).toMatchObject({ renderer: 'keyvalue', title: 'The point' });
    // The inferred chart is still there to go back to.
    expect(renderables.find((item) => item.source === 'descriptor')).toBeTruthy();
  });

  it('empties the canvas at canvas.clear and keeps what comes after', () => {
    const messages: ChatMessage[] = [
      ...toolPair('t5', 'orchard.forecast', forecastOutput),
      {
        id: 'm-clear',
        role: 'assistant',
        at: '2026-09-14T09:01:00Z',
        blocks: [{ type: 'tool_use', id: 'clear-1', name: CANVAS_CLEAR, input: {} }],
      },
      ...toolPair('t6', 'shed.inventory', { items: [{ name: 'Rake', count: 2 }] }),
    ];
    const renderables = renderablesFrom({ messages, descriptors: [forecast, inventory] });
    expect(renderables.map((item) => item.tool)).toEqual(['shed.inventory']);
  });

  it('turns a gated call into the envelope view whatever it would have drawn', () => {
    const messages = toolPair(
      't7',
      'shed.order',
      { ok: false, reason: 'approval-required', actionId: 'act-99' },
      false,
    );
    const renderables = renderablesFrom({ messages, descriptors: [inventory] });
    expect(renderables[0]).toMatchObject({
      renderer: 'envelope',
      source: 'approval',
      props: { approvalId: 'act-99' },
    });
  });

  it('keeps only the last few renderables, so the tabs stay a tab bar', () => {
    const messages = Array.from({ length: MAX_RENDERABLES + 4 }, (_, index) =>
      toolPair(`many-${index}`, 'shed.temperature', { ...reading, celsius: index }),
    ).flat();
    expect(renderablesFrom({ messages, descriptors: [] })).toHaveLength(MAX_RENDERABLES);
  });
});

describe('labels', () => {
  it('gives a dotted tool name its words back', () => {
    expect(labelFor('orchard.forecast')).toBe('Orchard · Forecast');
    expect(labelFor('shed.stockLevel')).toBe('Shed · Stock level');
  });
});
