import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isId, newSortableId } from '../src/ids.js';
import { addMoney, makeMoney, makeQuantity } from '../src/primitives.js';
import { transitionWorkflow } from '../src/state-machines.js';

describe('runtime contract properties', () => {
  it('generates valid sortable IDs for every safe millisecond timestamp', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_000_000_000_000 }), (milliseconds) => {
        expect(isId(newSortableId(new Date(milliseconds)))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps same-currency money addition closed and exact', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (left, right) => {
        const result = addMoney(makeMoney(left, 'USD'), makeMoney(right, 'USD'));
        expect(result).toEqual({ amountMinor: left + right, currency: 'USD' });
      }),
      { numRuns: 100 },
    );
  });

  it('accepts only non-negative integer quantity values', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), (value) => {
        expect(makeQuantity(value, 'bytes')).toEqual({ value, unit: 'bytes' });
      }),
      { numRuns: 100 },
    );
  });

  it('never permits a terminal workflow state to transition', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      expect(() => transitionWorkflow(state, 'beginExecution')).toThrow();
    }
  });
});
