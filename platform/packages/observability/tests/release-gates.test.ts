import { describe, expect, it } from 'vitest';
import {
  evaluateCapacity,
  evaluateReleaseGate,
  evaluateSlo,
  runCapacityProbe,
  summarizeSlo,
} from '../src/index.js';
import { newSortableId } from '@agentic-platform/runtime-contracts';

describe('provider-neutral release gates', () => {
  it('summarizes and evaluates supplied SLO observations without inventing targets', () => {
    expect(summarizeSlo('p95_latency_ms', [30, 10, 20, 40])).toBe(40);
    expect(
      evaluateSlo(
        {
          name: 'command success',
          metric: 'success_rate',
          comparator: 'at_least',
          target: 0.99,
          unit: 'ratio',
        },
        [1, 1, 0],
      ),
    ).toMatchObject({ observed: 2 / 3, sampleCount: 3, passed: false });
    expect(
      evaluateSlo(
        {
          name: 'recovery',
          metric: 'recovery_time_ms',
          comparator: 'at_most',
          target: 100,
          unit: 'milliseconds',
        },
        [],
      ),
    ).toMatchObject({ observed: undefined, sampleCount: 0, passed: false });
  });

  it('runs bounded concurrent probes and evaluates capacity evidence', async () => {
    const observation = await runCapacityProbe({
      taskCount: 5,
      concurrency: 2,
      run: async (index) => {
        if (index === 3) throw new Error('fixture failure');
      },
    });
    expect(observation).toMatchObject({ attempted: 5, completed: 4, failed: 1 });
    expect(observation.latenciesMs).toHaveLength(4);
    expect(
      evaluateCapacity(
        {
          name: 'local fixture',
          minimumCompleted: 4,
          maximumFailed: 1,
          maximumP95LatencyMs: 100,
        },
        observation,
      ),
    ).toMatchObject({ passed: true });
    expect(
      evaluateCapacity(
        { name: 'strict fixture', minimumCompleted: 5, maximumFailed: 0 },
        observation,
      ),
    ).toMatchObject({ passed: false });
  });

  it('holds failed rollout stages and advances only with complete evidence', () => {
    const previousReleaseId = newSortableId();
    const held = evaluateReleaseGate({
      releaseId: newSortableId(),
      harnessVersion: 'harness.v2',
      stage: 'canary',
      previousReleaseId,
      checks: [{ name: 'recovery', passed: false, observed: 250, target: 100 }],
      operatorApproved: true,
      operator: { actorId: newSortableId(), type: 'human' },
      evaluatedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(held).toMatchObject({
      passed: false,
      decision: 'hold',
      rollbackRequired: true,
      previousReleaseId,
      nextStage: 'limited',
    });

    const advanced = evaluateReleaseGate({
      releaseId: newSortableId(),
      harnessVersion: 'harness.v2',
      stage: 'shadow',
      checks: [{ name: 'objective_success', passed: true }],
      operatorApproved: false,
      evaluatedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(advanced).toMatchObject({ passed: false, decision: 'hold', nextStage: 'canary' });

    const approved = evaluateReleaseGate({
      releaseId: newSortableId(),
      harnessVersion: 'harness.v2',
      stage: 'shadow',
      checks: [{ name: 'objective_success', passed: true }],
      operatorApproved: true,
      operator: { actorId: newSortableId(), type: 'human' },
      evaluatedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(approved).toMatchObject({ passed: true, decision: 'advance', nextStage: 'canary' });
    expect(approved.evidenceDigest).toHaveLength(64);
  });
});
