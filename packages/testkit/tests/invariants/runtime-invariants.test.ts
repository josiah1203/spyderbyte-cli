import { describe, expect, it } from 'vitest';
import { assertTierParentChild } from '@agentic-platform/runtime-contracts';

describe('non-negotiable invocation hierarchy invariants', () => {
  it('permits only the registered parent-child tiers', () => {
    expect(() => assertTierParentChild(0, 1)).not.toThrow();
    expect(() => assertTierParentChild(1, 2)).not.toThrow();
  });

  it('rejects authority broadening by every invalid tier relationship', () => {
    for (const [parent, child] of [
      [0, 0],
      [0, 2],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
      [2, 2],
    ]) {
      expect(() => assertTierParentChild(parent, child)).toThrow();
    }
  });
});
