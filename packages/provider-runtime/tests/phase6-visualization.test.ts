import { describe, expect, it } from 'vitest';
import { LocalVisualizationRuntime, type VisualizationType } from '../src/visualizations.js';

describe('Phase 6 visualization registry', () => {
  it('selects automatically, honors overrides, and renders the declared registry', () => {
    const runtime = new LocalVisualizationRuntime();
    const input = {
      columns: ['category', 'x', 'y'],
      rows: [
        ['a', 1, 2],
        ['b', 2, 3],
      ],
      sourceArtifactId: 'artifact-phase6',
    } as const;
    expect(runtime.choose(input)).toMatchObject({ type: 'scatter', source: 'automatic' });
    expect(runtime.choose(input, 'heatmap')).toMatchObject({ type: 'heatmap', source: 'override' });

    const types: readonly VisualizationType[] = [
      'line',
      'bar',
      'stacked-bar',
      'area',
      'metric',
      'kpi',
      'table',
      'pivot',
      'scatter',
      'histogram',
      'box',
      'heatmap',
      'point-map',
      'choropleth',
      'confusion-matrix',
      'roc',
      'precision-recall',
      'feature-importance',
      'time-series',
    ];
    for (const type of types) {
      const render = runtime.render(
        {
          type,
          ...(type === 'table' || type === 'metric' || type === 'kpi' || type === 'pivot'
            ? {}
            : { xColumn: 'x', yColumn: 'y', seriesColumn: 'category' }),
        },
        input,
      );
      expect(render).toMatchObject({
        status: 'rendered',
        spec: { type },
        lineage: ['artifact-phase6'],
      });
    }
  });
});
